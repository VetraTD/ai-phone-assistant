// tests/webhookSsrf.test.js
/**
 * S4-3 A: the inbound tool webhook (integrations/webhook.js) goes out through
 * lib/net/ssrfGuard.js fetchVetted. A hostile or broken customer endpoint must
 * not crash or stall a live call: oversize bodies are an explicit failure,
 * redirects are refused, private/CGNAT targets never connect, and the timeout
 * covers the body.
 *
 * Two ends are real here: the vetting (fetchVetted's resolver + refusal) and a
 * REAL local HTTPS server for the connect-time behaviours (the same fixture
 * and trust helper tests/ssrfGuard.test.js uses). Needs NODE_EXTRA_CA_CERTS on
 * a machine whose loopback TLS is re-signed (see briefs/common.md).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeWebhook, _setWebhookTransport, WEBHOOK_MAX_BODY_BYTES } from "../integrations/webhook.js";
import { connectVetted, fetchVetted } from "../lib/net/ssrfGuard.js";
import { trustedCa } from "./helpers/trustedCa.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CERT = fs.readFileSync(path.join(HERE, "fixtures", "ssrfGuardTest.cert.pem"));
const KEY = fs.readFileSync(path.join(HERE, "fixtures", "ssrfGuardTest.key.pem"));

const PAYLOAD = { tool: "lookup_order", arguments: { id: "42" }, business_id: "biz-1", call_id: "call-1", caller_phone: "+15550001111" };

let server;
let port;
const hits = [];

beforeAll(async () => {
  server = https.createServer({ cert: CERT, key: KEY }, (req, res) => {
    hits.push(req.url);
    req.resume();
    req.on("end", () => {
      if (req.url === "/ok") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, message: "Order 42 ships Friday.", data: { eta: "Friday" } }));
      } else if (req.url === "/redirect") {
        res.writeHead(302, { Location: "https://example.com/elsewhere" });
        res.end("moved");
      } else if (req.url === "/huge-json") {
        // Valid JSON that would parse fine if it were silently cut at the cap
        // boundary is the trap: a truncated prefix must never be parsed.
        const big = JSON.stringify({ success: true, message: "x".repeat(200 * 1024) });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(big);
      } else if (req.url === "/slow-body") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write("{");
        // never finishes
      } else if (req.url === "/500") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal error" }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  server.on("clientError", () => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});

afterAll(async () => {
  _setWebhookTransport(null);
  await new Promise((r) => server.close(r));
});

// Real transport against the local fixture: keeps connectVetted's redirect,
// timer and body cap; only the address vetting is bypassed (127.0.0.1 is
// private by design, and connectVetted trusts an address it is handed).
const localTransport = (url, o) =>
  connectVetted({
    hostname: "localhost",
    address: "127.0.0.1",
    family: 4,
    port,
    path: new URL(url).pathname,
    method: o.method,
    headers: o.headers,
    body: o.body,
    timeoutMs: o.timeoutMs,
    maxBodyBytes: o.maxBodyBytes,
    tlsOptions: { ca: trustedCa(CERT) },
  });

const integ = (p) => ({ provider: "webhook", name: "lookup_order", config: { url: `https://localhost${p}`, method: "POST" } });

beforeEach(() => {
  hits.length = 0;
});
afterEach(() => {
  _setWebhookTransport(null);
  vi.useRealTimers();
});

describe("inbound webhook via fetchVetted: connect-time behaviour (real local HTTPS)", () => {
  it("happy path is unchanged: message and data reach the caller-facing result", async () => {
    _setWebhookTransport(localTransport);
    const r = await executeWebhook(integ("/ok"), PAYLOAD);
    expect(r).toEqual({ success: true, message: "Order 42 ships Friday.", data: { eta: "Friday" } });
  });

  it("a non-2xx response keeps its error text", async () => {
    _setWebhookTransport(localTransport);
    const r = await executeWebhook(integ("/500"), PAYLOAD);
    expect(r).toEqual({ success: false, error: "Internal error" });
  });

  it("an oversize body is an explicit error, never a truncated parse", async () => {
    _setWebhookTransport(localTransport);
    const r = await executeWebhook(integ("/huge-json"), PAYLOAD);
    expect(r.success).toBe(false);
    expect(r.error).toBe("The response was too large.");
    expect(r.message).toBeUndefined();
    expect(r.data).toBeUndefined();
  });

  it("the webhook cap is 64 KiB, well above the 8 KiB outbox default", () => {
    expect(WEBHOOK_MAX_BODY_BYTES).toBe(64 * 1024);
  });

  it("a redirect is refused, not followed", async () => {
    _setWebhookTransport(localTransport);
    const r = await executeWebhook(integ("/redirect"), PAYLOAD);
    expect(r.success).toBe(false);
    expect(r.error).toBe("The endpoint redirected the request.");
    expect(hits).toEqual(["/redirect"]); // exactly one request, no follow
  });

  it("the timeout covers a body that never finishes", async () => {
    // WEBHOOK_TIMEOUT_MS is read at import; drive the timer via the transport
    // option instead of waiting 6 s: wrap the transport with a short timeout.
    _setWebhookTransport((url, o) => localTransport(url, { ...o, timeoutMs: 300 }));
    const t0 = Date.now();
    const r = await executeWebhook(integ("/slow-body"), PAYLOAD);
    expect(r).toEqual({ success: false, error: "Request timed out." });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("passes the module's own timeout and cap to the transport", async () => {
    const spy = vi.fn(async () => ({ status: 200, headers: {}, body: "{}", truncated: false }));
    _setWebhookTransport(spy);
    await executeWebhook(integ("/ok"), PAYLOAD);
    expect(spy.mock.calls[0][1].timeoutMs).toBe(6000);
    expect(spy.mock.calls[0][1].maxBodyBytes).toBe(64 * 1024);
  });
});

describe("inbound webhook via the REAL fetchVetted: refused before connect", () => {
  // No transport override: the production path. Literal addresses are vetted
  // without DNS, so nothing here can touch the network.
  it.each([
    ["CGNAT literal", "https://100.64.0.1/hook"],
    ["loopback literal", "https://127.0.0.1/hook"],
    ["IPv4-mapped IPv6 literal", "https://[::ffff:127.0.0.1]/hook"],
    ["metadata address", "https://169.254.169.254/latest"],
    ["decimal-integer loopback", "https://2130706433/hook"],
  ])("%s -> refused with the private-address message", async (_l, url) => {
    _setWebhookTransport(null);
    const r = await executeWebhook({ provider: "webhook", name: "t", config: { url, method: "POST" } }, PAYLOAD);
    expect(r).toEqual({ success: false, error: "URL resolves to a private/reserved address" });
  });

  it("a hostname whose resolver answer includes any private record is refused before connect", async () => {
    const resolver = { lookup: vi.fn((_h, _o, cb) => cb(null, [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }])) };
    _setWebhookTransport((url, o) => fetchVetted(url, { ...o, resolver }));
    const r = await executeWebhook({ provider: "webhook", name: "t", config: { url: "https://multi.example.com/x", method: "POST" } }, PAYLOAD);
    expect(r.success).toBe(false);
    expect(r.error).toBe("URL resolves to a private/reserved address");
    expect(resolver.lookup).toHaveBeenCalledTimes(1);
  });

  it("an unresolvable hostname keeps the 'Cannot resolve' message", async () => {
    const resolver = {
      lookup: vi.fn((_h, _o, cb) => {
        const e = new Error("getaddrinfo ENOTFOUND nope.example.com");
        e.code = "ENOTFOUND";
        cb(e);
      }),
    };
    _setWebhookTransport((url, o) => fetchVetted(url, { ...o, resolver }));
    const r = await executeWebhook({ provider: "webhook", name: "t", config: { url: "https://nope.example.com/x", method: "POST" } }, PAYLOAD);
    expect(r.success).toBe(false);
    expect(r.error).toBe("Cannot resolve webhook hostname.");
    expect(r.error).not.toMatch(/ENOTFOUND|nope/); // the detail stays in the log
  });

  // FINAL FIX WAVE t3: a transport error that is neither a timeout nor an SSRF
  // refusal used to forward e.message (resolved IP, TLS text) to the model.
  it("any other transport error is the fixed 'Request failed.' -- the detail never reaches the model", async () => {
    _setWebhookTransport(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 93.184.216.34:443 (tls: unable to verify the first certificate)"), { code: "ECONNREFUSED" });
    });
    const r = await executeWebhook({ provider: "webhook", name: "t", config: { url: "https://x.example.com/x", method: "POST" } }, PAYLOAD);
    expect(r).toEqual({ success: false, error: "Request failed." });
  });
});

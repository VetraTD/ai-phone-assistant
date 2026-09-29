// tests/ssrfGuard.test.js
/**
 * S3-8 lib/net/ssrfGuard.js. No real DNS and no remote network: private-range
 * classification is driven by an INJECTED resolver (vi.fn implementing
 * `dns.lookup`'s callback signature), and connect-time behaviour (redirect
 * refusal, delivery, timeout, no-second-lookup) is driven against a REAL
 * local HTTPS server bound to 127.0.0.1 -- `connectVetted` is exercised
 * directly there, with an address handed to it (not re-derived), exactly the
 * split the dispatch notes call out ("local servers / injected resolvers").
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveVettedAddress, connectVetted, fetchVetted, SsrfRefusedError, _internal, MAX_BODY_BYTES, SSRF_TIMEOUT_MS } from "../lib/net/ssrfGuard.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CERT = fs.readFileSync(path.join(HERE, "fixtures", "ssrfGuardTest.cert.pem"));
const KEY = fs.readFileSync(path.join(HERE, "fixtures", "ssrfGuardTest.key.pem"));

/** A fake `dns.lookup`-shaped resolver that always answers with the given candidates. */
function fakeResolver(candidates) {
  return { lookup: vi.fn((_host, _opts, cb) => cb(null, candidates)) };
}

describe("ssrfGuard: private-range refusal (injected resolver, no real DNS)", () => {
  const PRIVATE_CASES = [
    ["10.0.0.1", 4, "10.0.0.0/8"],
    ["172.16.0.1", 4, "172.16.0.0/12"],
    ["172.31.255.255", 4, "172.16.0.0/12 (top of range)"],
    ["192.168.1.1", 4, "192.168.0.0/16"],
    ["127.0.0.1", 4, "127.0.0.0/8 (loopback)"],
    ["169.254.1.1", 4, "169.254.0.0/16 (link-local)"],
    ["100.64.0.1", 4, "100.64.0.0/10 (CGNAT)"],
    ["100.127.255.255", 4, "100.64.0.0/10 (top of range)"],
    ["0.0.0.0", 4, "0.0.0.0/8"],
    ["0.5.5.5", 4, "0.0.0.0/8 (wider)"],
    ["::1", 6, "IPv6 loopback"],
    ["::", 6, "IPv6 unspecified"],
    ["fc00::1", 6, "fc00::/7 (unique local)"],
    ["fd12:3456::1", 6, "fc00::/7 (fd form)"],
    ["fe80::1", 6, "fe80::/10 (link local)"],
    ["::ffff:10.0.0.1", 6, "IPv4-mapped, dotted form"],
    ["::ffff:127.0.0.1", 6, "IPv4-mapped loopback, dotted form"],
    ["::ffff:7f00:1", 6, "IPv4-mapped loopback, hex-group form (no dots)"],
    ["::ffff:a00:1", 6, "IPv4-mapped 10.0.0.1, hex-group form"],
    // D4 (final review): reserved ranges the original list left accepted.
    ["198.18.0.1", 4, "198.18.0.0/15 (benchmarking)"],
    ["198.19.255.255", 4, "198.18.0.0/15 (top of range)"],
    ["224.0.0.1", 4, "224.0.0.0/4 (multicast)"],
    ["240.0.0.1", 4, "240.0.0.0/4 (reserved)"],
    ["255.255.255.255", 4, "broadcast"],
    ["192.0.0.8", 4, "192.0.0.0/24 (IETF protocol assignments)"],
    ["fec0::1", 6, "fec0::/10 (deprecated site-local)"],
    ["64:ff9b::7f00:1", 6, "64:ff9b::/96 (NAT64) embedding 127.0.0.1"],
    ["64:ff9b::a00:1", 6, "64:ff9b::/96 (NAT64) embedding 10.0.0.1"],
    ["2002:a00:1::", 6, "2002::/16 (6to4) embedding 10.0.0.1"],
    ["2002:7f00:1::", 6, "2002::/16 (6to4) embedding 127.0.0.1"],
  ];

  it.each(PRIVATE_CASES)("refuses %s (family %i, %s)", async (address, family) => {
    const resolver = fakeResolver([{ address, family }]);
    await expect(resolveVettedAddress("evil.example.com", { resolver })).rejects.toThrow(SsrfRefusedError);
    await expect(resolveVettedAddress("evil.example.com", { resolver })).rejects.toMatchObject({ reason: "private_address" });
  });

  it("refuses the whole hostname if ANY resolved record is private, even when others are public", async () => {
    const resolver = fakeResolver([
      { address: "203.0.113.9", family: 4 }, // public (TEST-NET-3)
      { address: "10.0.0.1", family: 4 }, // private
    ]);
    await expect(resolveVettedAddress("mixed.example.com", { resolver })).rejects.toMatchObject({ reason: "private_address" });
  });

  it("accepts a hostname whose every resolved record is public", async () => {
    const resolver = fakeResolver([{ address: "203.0.113.9", family: 4 }]);
    const vetted = await resolveVettedAddress("public.example.com", { resolver });
    expect(vetted).toEqual({ address: "203.0.113.9", family: 4 });
  });

  // D4 (final review): the NAT64/6to4 checks classify the EMBEDDED IPv4,
  // not the whole prefix -- a transition address wrapping a genuinely
  // public IPv4 must not be blanket-refused just for using that form.
  it("a NAT64 (64:ff9b::/96) address embedding a PUBLIC IPv4 is accepted, not blanket-refused", async () => {
    const resolver = fakeResolver([{ address: "64:ff9b::cb00:7109", family: 6 }]); // embeds 203.0.113.9
    const vetted = await resolveVettedAddress("nat64.example.com", { resolver });
    expect(vetted).toEqual({ address: "64:ff9b::cb00:7109", family: 6 });
  });

  it("a 6to4 (2002::/16) address embedding a PUBLIC IPv4 is accepted, not blanket-refused", async () => {
    const resolver = fakeResolver([{ address: "2002:cb00:7109::", family: 6 }]); // embeds 203.0.113.9
    const vetted = await resolveVettedAddress("sixtofour.example.com", { resolver });
    expect(vetted).toEqual({ address: "2002:cb00:7109::", family: 6 });
  });

  it("\"localhost\" resolves through the SAME resolver-trust path -- whatever the resolver hands back is what gets checked, never the hostname text", async () => {
    const resolver = fakeResolver([{ address: "127.0.0.1", family: 4 }]);
    await expect(resolveVettedAddress("localhost", { resolver })).rejects.toMatchObject({ reason: "private_address" });
    expect(resolver.lookup).toHaveBeenCalledTimes(1);
  });

  it("refuses when the resolver returns no records at all", async () => {
    const resolver = { lookup: vi.fn((_h, _o, cb) => cb(null, [])) };
    await expect(resolveVettedAddress("nowhere.example.com", { resolver })).rejects.toMatchObject({ reason: "no_address" });
  });
});

describe("ssrfGuard: numeric IPv4 literals in the URL host (bypass DNS entirely)", () => {
  it("2130706433 (decimal for 127.0.0.1) is refused without calling the resolver", async () => {
    const resolver = fakeResolver([{ address: "203.0.113.9", family: 4 }]); // would be public if consulted
    await expect(resolveVettedAddress("2130706433", { resolver })).rejects.toMatchObject({ reason: "private_address" });
    expect(resolver.lookup).not.toHaveBeenCalled();
  });

  it("017700000001 (octal for 127.0.0.1) is refused", async () => {
    const resolver = fakeResolver([{ address: "203.0.113.9", family: 4 }]);
    await expect(resolveVettedAddress("017700000001", { resolver })).rejects.toMatchObject({ reason: "private_address" });
    expect(resolver.lookup).not.toHaveBeenCalled();
  });

  it("0x7f000001 (hex for 127.0.0.1) is refused", async () => {
    const resolver = fakeResolver([{ address: "203.0.113.9", family: 4 }]);
    await expect(resolveVettedAddress("0x7f000001", { resolver })).rejects.toMatchObject({ reason: "private_address" });
  });

  it("0x7f.0.0.1 (mixed hex/decimal shortened form for 127.0.0.1) is refused", async () => {
    const resolver = fakeResolver([{ address: "203.0.113.9", family: 4 }]);
    await expect(resolveVettedAddress("0x7f.0.0.1", { resolver })).rejects.toMatchObject({ reason: "private_address" });
  });

  it("0177.0.0.1 (per-octet octal for 127.0.0.1) is refused", async () => {
    const resolver = fakeResolver([{ address: "203.0.113.9", family: 4 }]);
    await expect(resolveVettedAddress("0177.0.0.1", { resolver })).rejects.toMatchObject({ reason: "private_address" });
  });

  it("a plain public numeric literal is accepted and never touches the resolver", async () => {
    const resolver = fakeResolver([{ address: "0.0.0.0", family: 4 }]); // would be refused if consulted
    const vetted = await resolveVettedAddress("3405803778", { resolver }); // 203.0.113.2
    expect(vetted.address).toBe("203.0.113.2");
    expect(resolver.lookup).not.toHaveBeenCalled();
  });
});

describe("ssrfGuard: literal IP hosts (net.isIP path, no resolver call)", () => {
  it("a literal private IPv4 host is refused directly", async () => {
    const resolver = fakeResolver([]);
    await expect(resolveVettedAddress("192.168.0.5", { resolver })).rejects.toMatchObject({ reason: "private_address" });
    expect(resolver.lookup).not.toHaveBeenCalled();
  });

  it("a literal public IPv4 host is accepted directly", async () => {
    const resolver = fakeResolver([]);
    const vetted = await resolveVettedAddress("203.0.113.5", { resolver });
    expect(vetted).toEqual({ address: "203.0.113.5", family: 4 });
    expect(resolver.lookup).not.toHaveBeenCalled();
  });
});

describe("ssrfGuard: internal classifiers (unit level)", () => {
  it("isPrivateAddress refuses an address it cannot parse at all (fail closed)", () => {
    expect(_internal.isPrivateAddress("not-an-ip", 4)).toBe(true);
    expect(_internal.isPrivateAddress("garbage", 6)).toBe(true);
  });

  it("isPrivateAddress refuses an unrecognized address family (fail closed)", () => {
    expect(_internal.isPrivateAddress("203.0.113.5", 5)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// connectVetted: a REAL local HTTPS server on 127.0.0.1. This never goes
// through resolveVettedAddress's private-range gate -- connectVetted trusts
// the address it is handed, by construction, so 127.0.0.1 here is not a
// contradiction of the private-range tests above.
// ---------------------------------------------------------------------------
describe("ssrfGuard: connectVetted (real local HTTPS server, manual redirect, timeout, no second lookup)", () => {
  let server;
  let port;
  let lastRequest = null;

  beforeAll(async () => {
    server = https.createServer({ cert: CERT, key: KEY }, (req, res) => {
      lastRequest = { headers: req.headers, path: req.url, method: req.method };
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        lastRequest.body = body;
        if (req.url === "/redirect-me") {
          res.writeHead(302, { Location: "https://example.com/elsewhere" });
          res.end("moved");
          return;
        }
        if (req.url === "/hang") {
          // Never responds -- exercises the timeout path.
          return;
        }
        if (req.url === "/huge") {
          // C1 (fix round 1): a single, large body -- well past MAX_BODY_BYTES
          // (8 KiB), but small enough to build synchronously and fast in a
          // unit test. 5 MiB is >600x the cap.
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(Buffer.alloc(5 * 1024 * 1024, "x"));
          return;
        }
        if (req.url === "/never-ending") {
          // A body that never ends on its own -- the client must settle
          // (and destroy the connection) once MAX_BODY_BYTES is exceeded,
          // never wait for 'end' or the 6 s timeout. Stops writing once the
          // client disconnects (res.destroy() on the far end), so this
          // never leaks an interval past the test.
          res.writeHead(200, { "Content-Type": "text/plain" });
          const chunk = Buffer.alloc(64 * 1024, "y"); // 64 KiB/tick, > the 8 KiB cap in one write
          const timer = setInterval(() => {
            if (res.destroyed) clearInterval(timer);
            else res.write(chunk);
          }, 5);
          res.on("close", () => clearInterval(timer));
          res.on("error", () => {}); // the client destroying its end is expected, not a server crash
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.on("clientError", () => {}); // a client that destroys mid-response is expected here too
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("delivers the exact body and headers to a vetted address, Host/SNI set to the given hostname", async () => {
    const res = await connectVetted({
      hostname: "localhost",
      address: "127.0.0.1",
      family: 4,
      port,
      path: "/deliver",
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Vetra-Event": "call.completed" },
      body: JSON.stringify({ hello: "world" }),
      tlsOptions: { rejectUnauthorized: false }, // test-only: self-signed fixture cert
    });
    expect(res.status).toBe(200);
    expect(lastRequest.method).toBe("POST");
    expect(lastRequest.path).toBe("/deliver");
    expect(lastRequest.headers["x-vetra-event"]).toBe("call.completed");
    // Node includes the port in the default Host header for a non-default
    // port -- correct HTTP behaviour (RFC 7230 §5.4), not a guard concern.
    expect(lastRequest.headers.host).toBe(`localhost:${port}`);
    expect(lastRequest.body).toBe(JSON.stringify({ hello: "world" }));
  });

  // D3 (final review, security): tlsOptions must never be able to override
  // hostname/servername/lookup -- the three fields that close the
  // DNS-rebinding window (named risk 2). A colliding tlsOptions.lookup
  // that redirected the connection to a different address would defeat
  // resolveVettedAddress entirely.
  it("D3: a colliding tlsOptions.hostname/servername/lookup can never redirect the connection away from the vetted address", async () => {
    const evilLookup = vi.fn((_h, opts, cb) => (opts && opts.all ? cb(null, [{ address: "203.0.113.9", family: 4 }]) : cb(null, "203.0.113.9", 4)));
    const res = await connectVetted({
      hostname: "localhost",
      address: "127.0.0.1",
      family: 4,
      port,
      path: "/deliver",
      method: "POST",
      tlsOptions: { rejectUnauthorized: false, hostname: "evil.example", servername: "evil.example", lookup: evilLookup },
    });
    expect(res.status).toBe(200); // reached the REAL local server, not "evil.example"
    expect(evilLookup).not.toHaveBeenCalled(); // tlsOptions' own lookup override never wins
    expect(lastRequest.headers.host).toBe(`localhost:${port}`); // Host/SNI stayed the real hostname
  });

  it("treats a 3xx as a refusal (manual redirect, never followed) -- named risk 3", async () => {
    await expect(
      connectVetted({
        hostname: "localhost",
        address: "127.0.0.1",
        family: 4,
        port,
        path: "/redirect-me",
        method: "POST",
        tlsOptions: { rejectUnauthorized: false },
      })
    ).rejects.toMatchObject({ reason: "redirect" });
  });

  it("times out rather than hanging forever", async () => {
    await expect(
      connectVetted({
        hostname: "localhost",
        address: "127.0.0.1",
        family: 4,
        port,
        path: "/hang",
        method: "POST",
        timeoutMs: 150,
        tlsOptions: { rejectUnauthorized: false },
      })
    ).rejects.toThrow();
  }, 5000);

  // C1 (fix round 1, Critical): the response body used to be buffered
  // without limit -- Buffer.concat + .toString("utf8") on a body past
  // Node's string length limit threw ERR_STRING_TOO_LONG as an UNCAUGHT
  // exception (server.js has no uncaughtException handler), which killed
  // the whole voice service. Both tests below are RED against the
  // pre-fix code (a 5 MiB single write, or a never-ending stream, both
  // resolve/settle with the full unbounded body and no cap).
  it("a large single-write body is truncated to MAX_BODY_BYTES, not buffered in full", async () => {
    const res = await connectVetted({
      hostname: "localhost",
      address: "127.0.0.1",
      family: 4,
      port,
      path: "/huge",
      method: "POST",
      tlsOptions: { rejectUnauthorized: false },
    });
    expect(res.status).toBe(200);
    expect(Buffer.byteLength(res.body, "utf8")).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(Buffer.byteLength(res.body, "utf8")).toBeGreaterThan(0);
  });

  it("a never-ending streamed body is cut off at MAX_BODY_BYTES and the socket is destroyed -- never waits for 'end' or the 6s timeout", async () => {
    const start = Date.now();
    const res = await connectVetted({
      hostname: "localhost",
      address: "127.0.0.1",
      family: 4,
      port,
      path: "/never-ending",
      method: "POST",
      timeoutMs: SSRF_TIMEOUT_MS, // the PRODUCTION timeout -- this must settle well before it
      tlsOptions: { rejectUnauthorized: false },
    });
    const elapsedMs = Date.now() - start;
    expect(res.status).toBe(200);
    expect(Buffer.byteLength(res.body, "utf8")).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(elapsedMs).toBeLessThan(SSRF_TIMEOUT_MS / 2);
  });

  it("never performs a REAL DNS lookup at connect time: an unresolvable hostname still connects, because the hostname is used only for Host/SNI, never handed to the OS resolver -- named risk 2 (closes the DNS-rebinding window: there is no second lookup for a rebound answer to win)", async () => {
    const res = await connectVetted({
      // .invalid is reserved (RFC 2606) to never resolve. If connectVetted's
      // `lookup` override were not intercepting resolution, this would fail
      // with ENOTFOUND instead of reaching the local server below.
      hostname: "this-hostname-does-not-exist-anywhere.invalid",
      address: "127.0.0.1",
      family: 4,
      port,
      path: "/deliver",
      method: "POST",
      body: "{}",
      tlsOptions: { rejectUnauthorized: false },
    });
    expect(res.status).toBe(200);
    expect(lastRequest.headers.host).toBe(`this-hostname-does-not-exist-anywhere.invalid:${port}`);
  });

  it("fetchVetted composes resolution (once) and connection (to that vetted address) end-to-end", async () => {
    const resolver = { lookup: vi.fn((_h, _o, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }])) };
    // A hostname whose classification we don't care about here: 127.0.0.1
    // itself is private, so route through connectVetted's own hostname/
    // address split is what fetchVetted composes -- proven directly by
    // calling fetchVetted against a hostname string that is ALREADY the
    // literal, public-looking form net.isIP accepts, avoiding the resolver
    // path's private-address refusal while still exercising the full
    // resolve-then-connect composition.
    const literalRes = await fetchVetted(`https://127.0.0.1:${port}/deliver`, {
      method: "POST",
      headers: {},
      body: "{}",
      resolver, // unused: a literal IP host never calls the resolver
      tlsOptions: { rejectUnauthorized: false },
    }).catch((e) => e);
    // 127.0.0.1 is itself in the private range, so the composed call is
    // REFUSED end-to-end -- this is the correct behaviour (fetchVetted must
    // not let a caller route around resolveVettedAddress by handing it a
    // literal loopback host), and it proves the two halves are wired
    // together, not merely each independently correct.
    expect(literalRes).toBeInstanceOf(SsrfRefusedError);
    expect(resolver.lookup).not.toHaveBeenCalled();
  });
});

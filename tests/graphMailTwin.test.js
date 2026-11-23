import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "module";
import * as esm from "../services/graphMail.js";

const require = createRequire(import.meta.url);
// The dashboard backend's CommonJS copy. The dashboard deploys from its own
// folder (its Dockerfile copies only AI-phone-dashboard/backend/src), so it
// cannot import the voice server's module and carries a twin instead. Same
// arrangement as the idToken verifiers: duplicated modules drift; duplicated
// modules with one shared test suite do not. Every case below runs against
// BOTH, so a fix made in one and forgotten in the other fails here.
const cjs = require("../AI-phone-dashboard/backend/src/services/graphMail.js");

const IMPLEMENTATIONS = [
  ["voice server (ESM)", esm],
  ["dashboard backend (CJS)", cjs],
];

const CONFIG = {
  tenantId: "tenant-1",
  clientId: "client-1",
  clientSecret: "secret-1",
  sender: "notifications@vetratd.com",
};

const ENV = {
  MS_GRAPH_TENANT_ID: " tenant-1 ",
  MS_GRAPH_CLIENT_ID: "client-1",
  MS_GRAPH_CLIENT_SECRET: "secret-1\n",
  MS_GRAPH_SENDER: "notifications@vetratd.com",
};

function tokenResponse(token = "tok-1") {
  return new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), { status: 200 });
}

/** A fetch stand-in that answers the token URL and the sendMail URL in turn. */
function fakeGraph({ sendStatus = 202, tokenStatus = 200 } = {}) {
  const calls = [];
  let tokenCount = 0;
  const impl = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("login.microsoftonline.com")) {
      tokenCount += 1;
      if (tokenStatus !== 200) return new Response("no", { status: tokenStatus });
      return tokenResponse(`tok-${tokenCount}`);
    }
    return new Response(null, { status: typeof sendStatus === "function" ? sendStatus() : sendStatus });
  });
  return { impl, calls, tokens: () => tokenCount };
}

describe.each(IMPLEMENTATIONS)("graphMail — %s", (_name, mod) => {
  let graph;
  beforeEach(() => {
    graph = fakeGraph();
    vi.stubGlobal("fetch", graph.impl);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads MAIL_TRANSPORT the same way: graph in any case, blank is smtp, other is smtp + invalid", () => {
    expect(mod.mailTransportSetting({ MAIL_TRANSPORT: " Graph " })).toEqual({ transport: "graph", invalid: false });
    expect(mod.mailTransportSetting({})).toEqual({ transport: "smtp", invalid: false });
    expect(mod.mailTransportSetting({ MAIL_TRANSPORT: "smtp" })).toEqual({ transport: "smtp", invalid: false });
    expect(mod.mailTransportSetting({ MAIL_TRANSPORT: "sendgrid" })).toEqual({ transport: "smtp", invalid: true });
  });

  it("builds the config from all four variables, trimmed, and null when any is missing", () => {
    expect(mod.graphMailConfig(ENV)).toEqual(CONFIG);
    expect(mod.graphMailConfig({ ...ENV, MS_GRAPH_SENDER: " " })).toBeNull();
    expect(mod.missingGraphMailVars({ MS_GRAPH_TENANT_ID: "t" })).toEqual([
      "MS_GRAPH_CLIENT_ID",
      "MS_GRAPH_CLIENT_SECRET",
      "MS_GRAPH_SENDER",
    ]);
  });

  it("sends one message from the shared mailbox and reports 202 as ok", async () => {
    const mailer = mod.createGraphMailer(CONFIG);
    const result = await mailer.send({ to: "owner@example.com", subject: "Hi", contentType: "Text", content: "Body" });
    expect(result).toEqual({ ok: true, status: 202 });
    const send = graph.calls.find((c) => c.url.includes("graph.microsoft.com"));
    expect(send.url).toBe("https://graph.microsoft.com/v1.0/users/notifications@vetratd.com/sendMail");
    expect(send.init.headers.Authorization).toBe("Bearer tok-1");
    const body = JSON.parse(send.init.body);
    expect(body.message.subject).toBe("Hi");
    expect(body.message.body).toEqual({ contentType: "Text", content: "Body" });
    expect(body.message.toRecipients).toEqual([{ emailAddress: { address: "owner@example.com" } }]);
    expect(body.saveToSentItems).toBe(false);
  });

  it("reuses one token across sends", async () => {
    const mailer = mod.createGraphMailer(CONFIG);
    await mailer.send({ to: "a@example.com", subject: "1", contentType: "Text", content: "x" });
    await mailer.send({ to: "b@example.com", subject: "2", contentType: "Text", content: "x" });
    expect(graph.tokens()).toBe(1);
  });

  it("drops a token Microsoft rejected, so the next send fetches a new one", async () => {
    let n = 0;
    graph = fakeGraph({ sendStatus: () => (++n === 1 ? 401 : 202) });
    vi.stubGlobal("fetch", graph.impl);
    const mailer = mod.createGraphMailer(CONFIG);
    expect(await mailer.send({ to: "a@example.com", subject: "1", contentType: "Text", content: "x" })).toEqual({
      ok: false,
      reason: "graph_refused",
      status: 401,
    });
    expect(await mailer.send({ to: "a@example.com", subject: "2", contentType: "Text", content: "x" })).toEqual({
      ok: true,
      status: 202,
    });
    expect(graph.tokens()).toBe(2);
  });

  it("reports a failed token request as a closed reason, never throwing", async () => {
    graph = fakeGraph({ tokenStatus: 400 });
    vi.stubGlobal("fetch", graph.impl);
    const mailer = mod.createGraphMailer(CONFIG);
    const result = await mailer.send({ to: "secret-person@example.com", subject: "S", contentType: "Text", content: "x" });
    expect(result).toEqual({ ok: false, reason: "graph_token_failed", status: 400 });
    // Nothing about the recipient, subject or secret rides on the failure.
    expect(JSON.stringify(result)).not.toMatch(/secret|example\.com/);
  });

  it("treats any non-202 send as refused", async () => {
    graph = fakeGraph({ sendStatus: 500 });
    vi.stubGlobal("fetch", graph.impl);
    const mailer = mod.createGraphMailer(CONFIG);
    expect(await mailer.send({ to: "a@example.com", subject: "S", contentType: "Text", content: "x" })).toEqual({
      ok: false,
      reason: "graph_refused",
      status: 500,
    });
  });

  it("reports a network failure as a closed reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND login.microsoftonline.com for owner@example.com");
    }));
    const mailer = mod.createGraphMailer(CONFIG);
    const result = await mailer.send({ to: "a@example.com", subject: "S", contentType: "Text", content: "x" });
    expect(result).toEqual({ ok: false, reason: "graph_token_failed", status: null });
  });
});

// The dashboard's contact form answers the prospect by Reply, so its copy can
// set Reply-To. The voice server never needed it and is left as it is.
describe("graphMail — dashboard backend (CJS) only", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sets Reply-To when given one", async () => {
    const graph = fakeGraph();
    vi.stubGlobal("fetch", graph.impl);
    const mailer = cjs.createGraphMailer(CONFIG);
    await mailer.send({
      to: "support@vetratd.com",
      subject: "S",
      contentType: "Text",
      content: "x",
      replyTo: "prospect@example.com",
    });
    const body = JSON.parse(graph.calls.find((c) => c.url.includes("graph.microsoft.com")).init.body);
    expect(body.message.replyTo).toEqual([{ emailAddress: { address: "prospect@example.com" } }]);
  });

  it("sends no Reply-To when none is given", async () => {
    const graph = fakeGraph();
    vi.stubGlobal("fetch", graph.impl);
    const mailer = cjs.createGraphMailer(CONFIG);
    await mailer.send({ to: "a@example.com", subject: "S", contentType: "Text", content: "x" });
    const body = JSON.parse(graph.calls.find((c) => c.url.includes("graph.microsoft.com")).init.body);
    expect(body.message).not.toHaveProperty("replyTo");
  });
});

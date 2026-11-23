// The dashboard's outbound email: the contact form and "Email me bookings".
//
// It used to go over Gmail SMTP as a personal address. MAIL_TRANSPORT=graph
// sends it through Microsoft 365 from the shared notifications@ mailbox, the
// same route the voice server's owner alerts already use.
//
// mailer.js reads its environment once, at require time, so every case loads a
// fresh copy under the env it describes.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const MAILER = require.resolve("../services/mailer.js");
const GRAPH = require.resolve("../services/graphMail.js");

const MAIL_VARS = [
  "MAIL_TRANSPORT",
  "MS_GRAPH_TENANT_ID",
  "MS_GRAPH_CLIENT_ID",
  "MS_GRAPH_CLIENT_SECRET",
  "MS_GRAPH_SENDER",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_HOST",
  "SMTP_FROM_EMAIL",
];

const GRAPH_ENV = {
  MAIL_TRANSPORT: "graph",
  MS_GRAPH_TENANT_ID: "tenant-1",
  MS_GRAPH_CLIENT_ID: "client-1",
  MS_GRAPH_CLIENT_SECRET: "secret-1",
  MS_GRAPH_SENDER: "notifications@vetratd.com",
};

let saved;

function loadMailer(env) {
  for (const name of MAIL_VARS) delete process.env[name];
  Object.assign(process.env, env);
  delete require.cache[MAILER];
  delete require.cache[GRAPH];
  return require("../services/mailer.js");
}

function fakeGraph(sendStatus = 202) {
  const sends = [];
  const impl = vi.fn(async (url, init) => {
    if (String(url).includes("login.microsoftonline.com")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    }
    sends.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(null, { status: sendStatus });
  });
  return { impl, sends };
}

beforeEach(() => {
  saved = Object.fromEntries(MAIL_VARS.map((n) => [n, process.env[n]]));
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.unstubAllGlobals();
  delete require.cache[MAILER];
});

describe("MAIL_TRANSPORT=graph", () => {
  it("is configured by the four Graph variables alone, with no SMTP credentials", () => {
    const mailer = loadMailer(GRAPH_ENV);
    expect(mailer.isConfigured()).toBe(true);
  });

  it("is NOT configured when a Graph variable is missing, even with SMTP credentials present", () => {
    const mailer = loadMailer({ ...GRAPH_ENV, MS_GRAPH_SENDER: "", SMTP_USER: "me@gmail.com", SMTP_PASS: "pw" });
    expect(mailer.isConfigured()).toBe(false);
  });

  it("sends through Graph from the shared mailbox, with the reply going to the prospect", async () => {
    const graph = fakeGraph();
    vi.stubGlobal("fetch", graph.impl);
    const mailer = loadMailer(GRAPH_ENV);
    await mailer.sendMail({
      to: "support@vetratd.com",
      subject: "VetraTD contact: Sam",
      text: "Hello",
      replyTo: "sam@example.com",
      fromName: "VetraTD",
    });
    expect(graph.sends).toHaveLength(1);
    expect(graph.sends[0].url).toBe("https://graph.microsoft.com/v1.0/users/notifications@vetratd.com/sendMail");
    const { message } = graph.sends[0].body;
    expect(message.subject).toBe("VetraTD contact: Sam");
    expect(message.body).toEqual({ contentType: "Text", content: "Hello" });
    expect(message.toRecipients).toEqual([{ emailAddress: { address: "support@vetratd.com" } }]);
    expect(message.replyTo).toEqual([{ emailAddress: { address: "sam@example.com" } }]);
  });

  it("throws when Microsoft refuses, so the route answers 500 rather than claiming it sent", async () => {
    vi.stubGlobal("fetch", fakeGraph(403).impl);
    const mailer = loadMailer(GRAPH_ENV);
    await expect(
      mailer.sendMail({ to: "owner@example.com", subject: "S", text: "x" })
    ).rejects.toMatchObject({ code: "MAIL_SEND_FAILED", message: "graph_refused" });
  });

  it("puts nothing about the recipient into the thrown error", async () => {
    vi.stubGlobal("fetch", fakeGraph(500).impl);
    const mailer = loadMailer(GRAPH_ENV);
    const err = await mailer.sendMail({ to: "private-person@example.com", subject: "S", text: "x" }).catch((e) => e);
    expect(JSON.stringify({ ...err, message: err.message })).not.toContain("private-person");
  });

  it("flattens line breaks in a subject into spaces", async () => {
    // A business name is read from the database, and a stray newline in a cell
    // has happened before (the "our office" routing bug).
    const graph = fakeGraph();
    vi.stubGlobal("fetch", graph.impl);
    const mailer = loadMailer(GRAPH_ENV);
    await mailer.sendMail({ to: "o@example.com", subject: "Today appointments -\r\nBrightwork\tDental", text: "x" });
    expect(graph.sends[0].body.message.subject).toBe("Today appointments - Brightwork Dental");
  });
});

describe("MAIL_TRANSPORT unset (SMTP)", () => {
  it("is configured by SMTP credentials, as before", () => {
    expect(loadMailer({ SMTP_USER: "me@gmail.com", SMTP_PASS: "pw" }).isConfigured()).toBe(true);
    expect(loadMailer({}).isConfigured()).toBe(false);
  });

  it("ignores Graph variables unless MAIL_TRANSPORT=graph", () => {
    const { MAIL_TRANSPORT: _unused, ...graphVarsOnly } = GRAPH_ENV;
    expect(loadMailer(graphVarsOnly).isConfigured()).toBe(false);
  });
});

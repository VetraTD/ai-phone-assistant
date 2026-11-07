import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Task M (Ilija inbound, S2): owner email can go out through Microsoft 365, via
// the Graph sendMail API with an app-only token, behind MAIL_TRANSPORT. The
// default (unset or "smtp") stays the nodemailer path it always was.
//
// No live Microsoft call anywhere: fetch is stubbed with vi.stubGlobal. Every
// tenant, client, secret, token and address below is a placeholder.
//
// The module reads env at import, so every case sets env and resets modules
// before importing (load()).

const ENV_KEYS = [
  "NOTIFICATIONS_ENABLED",
  "SMTP_USER",
  "SMTP_PASS",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_SMS_FROM",
  "DASHBOARD_URL",
  "DEPLOYMENT_MODE",
  "MAIL_TRANSPORT",
  "MS_GRAPH_TENANT_ID",
  "MS_GRAPH_CLIENT_ID",
  "MS_GRAPH_CLIENT_SECRET",
  "MS_GRAPH_SENDER",
];
const originalEnv = {};

const TENANT = "00000000-0000-0000-0000-000000000000";
const CLIENT = "11111111-1111-1111-1111-111111111111";
const SECRET = "placeholder-client-secret-NOT-REAL";
const SENDER = "notifications@example.com";
const TOKEN_A = "placeholder-access-token-AAAA";
const TOKEN_B = "placeholder-access-token-BBBB";
const RECIPIENT = "owner@example.com";

const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const SEND_URL = `https://graph.microsoft.com/v1.0/users/${SENDER}/sendMail`;

const GRAPH_VARS = {
  MS_GRAPH_TENANT_ID: TENANT,
  MS_GRAPH_CLIENT_ID: CLIENT,
  MS_GRAPH_CLIENT_SECRET: SECRET,
  MS_GRAPH_SENDER: SENDER,
};
const GRAPH = { MAIL_TRANSPORT: "graph", ...GRAPH_VARS };
const SMTP = { SMTP_USER: "bot@example.com", SMTP_PASS: "secret" };
const SMS = {
  TWILIO_ACCOUNT_SID: "AC" + "1".repeat(32),
  TWILIO_AUTH_TOKEN: "authtoken1234567890",
  TWILIO_SMS_FROM: "+15550009999",
};

const sendMailMock = vi.fn(async () => ({ messageId: "1" }));
const messagesCreateMock = vi.fn(async () => ({ sid: "SM1" }));
const captureMock = vi.fn();

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a) => sendMailMock(...a) }) },
}));
vi.mock("twilio", () => ({
  default: vi.fn(() => ({ messages: { create: (...a) => messagesCreateMock(...a) } })),
}));
vi.mock("../lib/sentry.js", () => ({
  enabled: false,
  captureException: (...a) => captureMock(...a),
}));

const BASE_BUSINESS = {
  id: "biz-1",
  name: "Acme Plumbing",
  notifications_enabled: true,
  notification_email: RECIPIENT,
  notification_phone: null,
  timezone: "Europe/London",
  compliance_tier: "standard",
};
const state = { business: { ...BASE_BUSINESS } };

vi.mock("../services/db.js", () => ({
  isEnabled: () => true,
  withTenantSafe: async (_businessId, fn) => fn(),
  fetchBusinessById: async () => state.business,
}));

// ---------------------------------------------------------------------------
// fetch stub: token endpoint and sendMail endpoint answered separately
// ---------------------------------------------------------------------------

/** A Response stand-in. Plain object, so it behaves the same under fake timers. */
function res(status, body = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: null,
  };
}
const tokenOk = (token = TOKEN_A, expiresIn = 3599) =>
  res(200, { token_type: "Bearer", expires_in: expiresIn, ext_expires_in: expiresIn, access_token: token });
const accepted = () => res(202);

let fetchMock;
function routeFetch({ token = () => tokenOk(), send = () => accepted() } = {}) {
  fetchMock = vi.fn(async (url, init) =>
    String(url).startsWith("https://login.microsoftonline.com/") ? token(url, init) : send(url, init)
  );
  vi.stubGlobal("fetch", fetchMock);
}
const tokenCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith("https://login.microsoftonline.com/"));
const sendCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith("https://graph.microsoft.com/"));
const sentPayload = (i = 0) => JSON.parse(sendCalls()[i][1].body);
const authOf = (i) => new Headers(sendCalls()[i][1].headers).get("authorization");

// ---------------------------------------------------------------------------
// log capture (stdout: survives vi.resetModules, unlike a spy on one log instance)
// ---------------------------------------------------------------------------

let stdoutLines;
let writeSpy;
const logEvents = () =>
  stdoutLines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
const eventsNamed = (name) => logEvents().filter((e) => e.event === name);

/** Everything that left through a log line or a Sentry call, as one string. */
function everythingReported() {
  const sentry = captureMock.mock.calls.map((args) =>
    args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}\n${a.stack}` : JSON.stringify(a))).join(" ")
  );
  return [...stdoutLines, ...sentry].join("\n");
}

beforeEach(() => {
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
  sendMailMock.mockReset();
  sendMailMock.mockImplementation(async () => ({ messageId: "1" }));
  messagesCreateMock.mockClear();
  captureMock.mockClear();
  state.business = { ...BASE_BUSINESS };
  routeFetch();
  stdoutLines = [];
  writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdoutLines.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  writeSpy.mockRestore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  vi.resetModules();
});

async function load(env) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, { DASHBOARD_URL: "https://dashboard.example/app", ...env });
  vi.resetModules();
  return import("../services/notifications.js");
}

/** One link-only owner email (html part); resolves sendEmail's boolean. */
const sendOne = (n) => n.notifyCustomerRequest({ businessId: "biz-1", customerRequest: { request_type: "message" } });
const LINK_ONLY_SUBJECT = "New customer request — Acme Plumbing";

const row = {
  id: "r1",
  call_id: "c1",
  request_type: "message",
  caller_name: "Jane Doe",
  callback_number: "+447700900123",
  message: "wants help with Meta ads",
  preferred_time: "Tuesday afternoon",
  caller_number: "+447700900999",
  created_at: "2026-11-09T14:32:00Z",
  details: { callerType: "new_enquiry", answers: [{ label: "Company", answer: "Acme" }] },
};
const DETAILS_SUBJECT = "New enquiry — Acme Plumbing";

// ---------------------------------------------------------------------------

describe("MAIL_TRANSPORT=graph sends through Microsoft Graph", () => {
  it("202 is accepted: the token, then the sender's sendMail URL with a Bearer token", async () => {
    const n = await load(GRAPH);
    await expect(sendOne(n)).resolves.toBe(true);

    expect(tokenCalls()).toHaveLength(1);
    const [tokenUrl, tokenInit] = tokenCalls()[0];
    expect(tokenUrl).toBe(TOKEN_URL);
    expect(tokenInit.method).toBe("POST");
    const form = new URLSearchParams(String(tokenInit.body));
    expect(Object.fromEntries(form)).toEqual({
      client_id: CLIENT,
      client_secret: SECRET,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });

    expect(sendCalls()).toHaveLength(1);
    const [sendUrl, sendInit] = sendCalls()[0];
    expect(sendUrl).toBe(SEND_URL);
    expect(sendInit.method).toBe("POST");
    expect(authOf(0)).toBe(`Bearer ${TOKEN_A}`);
    expect(new Headers(sendInit.headers).get("content-type")).toMatch(/^application\/json/);
    const payload = sentPayload();
    expect(payload.saveToSentItems).toBe(false);
    expect(payload.message.subject).toBe(LINK_ONLY_SUBJECT);
    expect(payload.message.toRecipients).toEqual([{ emailAddress: { address: RECIPIENT } }]);
    // Not plainOnly: the same html the SMTP path builds from the text.
    expect(payload.message.body.contentType).toBe("HTML");
    expect(payload.message.body.content).toContain("<br>\n");
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("graph mode does not touch SMTP even when SMTP credentials are also set", async () => {
    const n = await load({ ...GRAPH, ...SMTP });
    await expect(sendOne(n)).resolves.toBe(true);
    expect(sendCalls()).toHaveLength(1);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("values are trimmed: a secret with a trailing newline still authenticates", async () => {
    const n = await load({ ...GRAPH, MS_GRAPH_CLIENT_SECRET: `${SECRET}\n`, MS_GRAPH_SENDER: ` ${SENDER} ` });
    await expect(sendOne(n)).resolves.toBe(true);
    expect(new URLSearchParams(String(tokenCalls()[0][1].body)).get("client_secret")).toBe(SECRET);
    expect(sendCalls()[0][0]).toBe(SEND_URL);
  });
});

describe("the token", () => {
  it("two sends share one token; it is refetched 60 s before expires_in", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-11-07T12:00:00Z").getTime();
    vi.setSystemTime(start);
    const tokens = [TOKEN_A, TOKEN_B];
    routeFetch({ token: () => tokenOk(tokens.shift(), 3600) });
    const n = await load(GRAPH);

    await expect(sendOne(n)).resolves.toBe(true);
    await expect(sendOne(n)).resolves.toBe(true);
    expect(tokenCalls()).toHaveLength(1);
    expect(sendCalls()).toHaveLength(2);

    vi.setSystemTime(start + (3600 - 60) * 1000 - 1);
    await expect(sendOne(n)).resolves.toBe(true);
    expect(tokenCalls()).toHaveLength(1);

    vi.setSystemTime(start + (3600 - 60) * 1000);
    await expect(sendOne(n)).resolves.toBe(true);
    expect(tokenCalls()).toHaveLength(2);
    expect(authOf(3)).toBe(`Bearer ${TOKEN_B}`);
  });

  it("two concurrent sends with an empty cache make one token request", async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    routeFetch({
      token: async () => {
        await gate;
        return tokenOk();
      },
    });
    const n = await load(GRAPH);
    const both = Promise.all([sendOne(n), sendOne(n)]);
    await vi.waitFor(() => expect(tokenCalls()).toHaveLength(1));
    // Give the second send every chance to ask for a token of its own.
    await new Promise((r) => setTimeout(r, 25));
    release();
    await expect(both).resolves.toEqual([true, true]);
    expect(tokenCalls()).toHaveLength(1);
    expect(sendCalls()).toHaveLength(2);
  });

  it("a 401 from sendMail drops the token, does not retry, and the next send fetches a new one", async () => {
    const tokens = [TOKEN_A, TOKEN_B];
    const answers = [res(401, { error: { code: "InvalidAuthenticationToken" } }), accepted()];
    routeFetch({ token: () => tokenOk(tokens.shift()), send: () => answers.shift() });
    const n = await load(GRAPH);

    await expect(sendOne(n)).resolves.toBe(false);
    expect(sendCalls()).toHaveLength(1);
    expect(eventsNamed("notification_email")).toEqual([
      expect.objectContaining({ reason: "graph_refused", status: 401 }),
    ]);

    await expect(sendOne(n)).resolves.toBe(true);
    expect(tokenCalls()).toHaveLength(2);
    expect(authOf(1)).toBe(`Bearer ${TOKEN_B}`);
  });
});

describe("plain text (R9) holds on the Graph path", () => {
  it("plainOnly sends contentType Text with the text, and no HTML anywhere", async () => {
    const n = await load(GRAPH);
    await expect(n.notifyCallRequests({ businessId: "biz-1", rows: [row] })).resolves.toBe("sent");
    expect(sendCalls()).toHaveLength(1);
    const raw = sendCalls()[0][1].body;
    const payload = JSON.parse(raw);
    expect(payload.message.subject).toBe(DETAILS_SUBJECT);
    expect(payload.message.body.contentType).toBe("Text");
    expect(payload.message.body.content).toContain("Name: Jane Doe");
    expect(payload.message.body.content).toContain("\nNumber: +447700900123\n");
    expect(raw).not.toMatch(/html/i);
    expect(raw).not.toContain("<br");
  });
});

describe("every Graph failure returns false, never throws, and reports closed reasons only", () => {
  const leaky = `Mailbox ${RECIPIENT} rejected; token ${TOKEN_A}; secret ${SECRET}`;
  const cases = [
    ["sendMail 4xx", { send: () => res(403, { error: { code: "ErrorAccessDenied", message: leaky } }) }, "graph_refused", 403],
    ["sendMail 5xx", { send: () => res(503, { error: { code: "ServiceUnavailable", message: leaky } }) }, "graph_refused", 503],
    ["sendMail 200 (not 202)", { send: () => res(200, { note: leaky }) }, "graph_refused", 200],
    ["sendMail network error", { send: async () => { throw new TypeError(`fetch failed: ${leaky}`); } }, "graph_refused", undefined],
    ["token refused", { token: () => res(401, { error: "invalid_client", error_description: leaky }) }, "graph_token_failed", 401],
    ["token 200 without access_token", { token: () => res(200, { error_description: leaky }) }, "graph_token_failed", 200],
    ["token network error", { token: async () => { throw new TypeError(`fetch failed: ${leaky}`); } }, "graph_token_failed", undefined],
  ];

  it.each(cases)("%s", async (_label, routes, reason, status) => {
    routeFetch(routes);
    const n = await load(GRAPH);
    let result;
    await expect(
      (async () => {
        result = await sendOne(n);
      })()
    ).resolves.toBeUndefined();
    expect(result).toBe(false);

    const logged = eventsNamed("notification_email");
    expect(logged).toHaveLength(1);
    expect(logged[0].reason).toBe(reason);
    if (status === undefined) expect("status" in logged[0]).toBe(false);
    else expect(logged[0].status).toBe(status);
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock.mock.calls[0][0].message.startsWith(reason)).toBe(true);

    const reported = everythingReported();
    for (const s of [RECIPIENT, SECRET, TOKEN_A, LINK_ONLY_SUBJECT, "New customer request", "Mailbox", "invalid_client"]) {
      expect(reported).not.toContain(s);
    }
  });

  it("the plainOnly email's refusal reports no caller words either", async () => {
    routeFetch({ send: () => res(400, { error: { message: `bad recipient ${RECIPIENT} for Jane Doe` } }) });
    const n = await load(GRAPH);
    await expect(n.notifyCallRequests({ businessId: "biz-1", rows: [row] })).resolves.toBe("failed");
    const reported = everythingReported();
    for (const s of [RECIPIENT, SECRET, TOKEN_A, DETAILS_SUBJECT, "Jane", "+4477", "Meta"]) {
      expect(reported).not.toContain(s);
    }
  });

  it("notifyCallRequests with a refused Graph send is failed, and texts nobody", async () => {
    state.business = { ...BASE_BUSINESS, notification_phone: "+15551110000" };
    routeFetch({ send: () => res(500) });
    const n = await load({ ...GRAPH, ...SMS });
    await expect(n.notifyCallRequests({ businessId: "biz-1", rows: [row] })).resolves.toBe("failed");
    // Failed because Microsoft refused it, not because nothing was tried.
    expect(sendCalls()).toHaveLength(1);
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });
});

describe("a hung Microsoft call is bounded below notifyCallRequests' 10 s cap", () => {
  it("the timeout is one named constant, under 10 s", async () => {
    const { GRAPH_FETCH_TIMEOUT_MS } = await import("../services/graphMail.js");
    expect(GRAPH_FETCH_TIMEOUT_MS).toBe(8_000);
  });

  it("a sendMail that never resolves: false at 8 s, before the 10 s cap fires", async () => {
    routeFetch({ send: () => new Promise(() => {}) });
    const n = await load(GRAPH);
    vi.useFakeTimers();
    const p = n.notifyCallRequests({ businessId: "biz-1", rows: [row] });
    let settled = false;
    p.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(7_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(p).resolves.toBe("failed");
    expect(eventsNamed("notification_email")).toEqual([expect.objectContaining({ reason: "graph_timeout" })]);
    // The flush's own 10 s cap never had to fire.
    expect(eventsNamed("notify_call_requests").filter((e) => e.reason === "timeout")).toEqual([]);
  });

  it("a token that never resolves: false at 8 s", async () => {
    routeFetch({ token: () => new Promise(() => {}) });
    const n = await load(GRAPH);
    vi.useFakeTimers();
    const p = sendOne(n);
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(p).resolves.toBe(false);
    expect(eventsNamed("notification_email")).toEqual([expect.objectContaining({ reason: "graph_timeout" })]);
    expect(sendCalls()).toHaveLength(0);
  });

  it("a slow token then a hung sendMail: still false at 8 s in all, not 8 s each", async () => {
    routeFetch({
      token: () => new Promise((resolve) => setTimeout(() => resolve(tokenOk()), 7_000)),
      send: () => new Promise(() => {}),
    });
    const n = await load(GRAPH);
    vi.useFakeTimers();
    const p = sendOne(n);
    let settled = false;
    p.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(7_999);
    expect(sendCalls()).toHaveLength(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe(false);
    expect(eventsNamed("notification_email")).toEqual([expect.objectContaining({ reason: "graph_timeout" })]);
  });

  it("the abort signal reaches fetch", async () => {
    let seen = null;
    routeFetch({
      send: (_url, init) => {
        seen = init.signal;
        return new Promise(() => {});
      },
    });
    const n = await load(GRAPH);
    vi.useFakeTimers();
    const p = sendOne(n);
    await vi.advanceTimersByTimeAsync(8_000);
    await p;
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen.aborted).toBe(true);
  });
});

describe("gating: HAS_EMAIL_CREDS and NOTIFICATIONS_ENABLED in graph mode", () => {
  const variants = Object.keys(GRAPH_VARS).flatMap((key) => [
    [`${key} unset`, key, undefined],
    [`${key} blank`, key, "   "],
  ]);

  it.each(variants)("%s: not configured, notification_dropped, no fetch, no SMTP fallback", async (_label, key, value) => {
    const env = { ...GRAPH, ...SMTP, ...SMS };
    if (value === undefined) delete env[key];
    else env[key] = value;
    const n = await load(env);
    await n.notifyCallMissed({ businessId: "biz-1", call: {}, status: "no-answer" });

    const dropped = eventsNamed("notification_dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0].channel).toBe("email");
    expect(dropped[0].reason).toBe("graph_not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("a half-configured graph mode cannot look enabled, whatever SMTP holds", async () => {
    const { MS_GRAPH_CLIENT_SECRET: _omit, ...half } = GRAPH;
    expect((await load({ ...half, ...SMTP })).NOTIFICATIONS_ENABLED).toBe(false);
  });

  it("complete graph mode alone enables email; NOTIFICATIONS_ENABLED=false still wins", async () => {
    expect((await load(GRAPH)).NOTIFICATIONS_ENABLED).toBe(true);
    expect((await load({ ...GRAPH, NOTIFICATIONS_ENABLED: "false" })).NOTIFICATIONS_ENABLED).toBe(false);
  });

  it("graph variables without MAIL_TRANSPORT=graph enable nothing", async () => {
    expect((await load(GRAPH_VARS)).NOTIFICATIONS_ENABLED).toBe(false);
  });
});

describe("the default is today's SMTP path", () => {
  it.each([
    ["MAIL_TRANSPORT unset", {}],
    ["MAIL_TRANSPORT=smtp", { MAIL_TRANSPORT: "smtp" }],
    ["MAIL_TRANSPORT blank", { MAIL_TRANSPORT: "" }],
  ])("%s: nodemailer sends, no fetch, no boot warning", async (_label, extra) => {
    const n = await load({ ...SMTP, ...GRAPH_VARS, ...extra });
    await expect(sendOne(n)).resolves.toBe(true);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(eventsNamed("mail_transport_invalid")).toEqual([]);
  });

  it("an unknown MAIL_TRANSPORT logs mail_transport_invalid once at boot and behaves as smtp", async () => {
    const n = await load({ ...SMTP, ...GRAPH_VARS, MAIL_TRANSPORT: "sendgrid" });
    expect(eventsNamed("mail_transport_invalid")).toHaveLength(1);
    await sendOne(n);
    await sendOne(n);
    expect(eventsNamed("mail_transport_invalid")).toHaveLength(1);
    expect(sendMailMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stdoutLines.join("\n")).not.toContain("sendgrid");
  });

  it("case and surrounding space are forgiven: ' Graph ' is graph", async () => {
    const n = await load({ ...GRAPH, MAIL_TRANSPORT: " Graph " });
    await expect(sendOne(n)).resolves.toBe(true);
    expect(sendCalls()).toHaveLength(1);
    expect(eventsNamed("mail_transport_invalid")).toEqual([]);
  });
});

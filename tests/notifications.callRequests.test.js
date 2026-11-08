import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Ilija inbound, Task 5: the owner email for a call's saved messages. It carries
// the call's details (name, number, reason, answers) for every business except a
// healthcare-tier one, which gets the link-only email (tests/notifications.phi.test.js).

const ENV_KEYS = ["NOTIFICATIONS_ENABLED", "SMTP_USER", "SMTP_PASS", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_SMS_FROM", "DASHBOARD_URL", "DEPLOYMENT_MODE"];
const originalEnv = {};

const sendMailMock = vi.fn(async () => ({ messageId: "1" }));
const messagesCreateMock = vi.fn(async () => ({ sid: "SM1" }));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a) => sendMailMock(...a) }) },
}));
vi.mock("twilio", () => ({
  default: vi.fn(() => ({ messages: { create: (...a) => messagesCreateMock(...a) } })),
}));

const BASE_BUSINESS = {
  id: "biz-1",
  name: "Acme Plumbing",
  notifications_enabled: true,
  notification_email: "owner@example.com",
  notification_phone: "+15551110000",
  timezone: "Europe/London",
  compliance_tier: "standard",
};
const state = { fetch: async () => ({ ...BASE_BUSINESS }) };

vi.mock("../services/db.js", () => ({
  isEnabled: () => true,
  withTenantSafe: async (_businessId, fn) => fn(),
  fetchBusinessById: (...a) => state.fetch(...a),
}));

beforeEach(() => {
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
  sendMailMock.mockReset();
  sendMailMock.mockImplementation(async () => ({ messageId: "1" }));
  messagesCreateMock.mockClear();
  state.fetch = async () => ({ ...BASE_BUSINESS });
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  vi.resetModules();
});

async function load(extraEnv = {}) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    SMTP_USER: "bot@example.com",
    SMTP_PASS: "secret",
    TWILIO_ACCOUNT_SID: "AC" + "1".repeat(32),
    TWILIO_AUTH_TOKEN: "authtoken1234567890",
    TWILIO_SMS_FROM: "+15550009999",
    DASHBOARD_URL: "https://dashboard.example/app",
    ...extraEnv,
  });
  for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete process.env[k];
  vi.resetModules();
  return import("../services/notifications.js");
}

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
const render = (n, rows, timezone = "Europe/London") =>
  n.renderCallRequestsEmail({ businessName: "Acme Plumbing", timezone, rows });

describe("renderCallRequestsEmail", () => {
  it("carries the details and names the kind in the subject", async () => {
    const n = await load();
    const { subject, text } = render(n, [row]);
    expect(subject).toBe("New enquiry — Acme Plumbing");
    for (const line of [
      "Type: New enquiry",
      "Name: Jane Doe",
      "Number: +447700900123",
      "Reason: wants help with Meta ads",
      "Company: Acme",
      "Preferred time: Tuesday afternoon",
    ]) expect(text).toContain(line);
    expect(text).not.toContain("contains no caller");
    expect(text).toContain("Details were taken by phone, so spellings may be off.");
    expect(text).toContain("https://dashboard.example/app");
  });

  it("orders the lines: Type, Name, Number, Reason, answers, Preferred time, Call time", async () => {
    const n = await load();
    const { text } = render(n, [row]);
    const at = (s) => text.indexOf(s);
    const order = ["Type:", "Name:", "Number:", "Reason:", "Company:", "Preferred time:", "Call time:"].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it.each([
    ["existing_customer", "Existing customer message"],
    ["personal", "Personal message"],
    ["supplier", "Supplier message"],
    ["sales_pitch", "Sales call"],
    ["other", "New message"],
    ["gibberish", "New message"],
    [undefined, "New message"],
  ])("subject for type %s is %s", async (callerType, label) => {
    const n = await load();
    const { subject } = render(n, [{ ...row, details: callerType ? { callerType, answers: [] } : null }]);
    expect(subject).toBe(`${label} — Acme Plumbing`);
  });

  it("a quote with no type is a quote request; with a type the type wins", async () => {
    const n = await load();
    expect(render(n, [{ ...row, request_type: "quote", details: null }]).subject).toBe("New quote request — Acme Plumbing");
    expect(render(n, [{ ...row, request_type: "quote" }]).subject).toBe("New enquiry — Acme Plumbing");
  });

  it("prints a Type line only for a known type that is not other", async () => {
    const n = await load();
    expect(render(n, [{ ...row, details: { callerType: "other", answers: [] } }]).text).not.toContain("Type:");
    expect(render(n, [{ ...row, details: null }]).text).not.toContain("Type:");
  });

  it("leaves out Preferred time when absent, and says 'not given' for a blank name", async () => {
    const n = await load();
    const { text } = render(n, [{ ...row, preferred_time: null, caller_name: "  " }]);
    expect(text).not.toContain("Preferred time");
    expect(text).toContain("Name: not given");
  });

  it("number: callback first, then a real caller number, else not given", async () => {
    const n = await load();
    expect(render(n, [{ ...row, callback_number: null }]).text).toContain("Number: +447700900999");
    expect(render(n, [{ ...row, callback_number: "   " }]).text).toContain("Number: +447700900999");
    expect(render(n, [{ ...row, callback_number: null, caller_number: null }]).text).toContain("Number: not given");
    expect(render(n, [{ ...row, callback_number: "", caller_number: "" }]).text).toContain("Number: not given");
  });

  it("a withheld caller's placeholder is not a number", async () => {
    const n = await load();
    const { text } = render(n, [{ ...row, callback_number: null, caller_number: "+266696687" }]);
    expect(text).toContain("Number: not given");
    expect(text).not.toContain("266696687");
  });

  it("renders every row, subject from the first, each with its own type", async () => {
    const n = await load();
    const second = { ...row, caller_name: "Bob Two", message: "other thing", details: { callerType: "supplier", answers: [] } };
    const { subject, text } = render(n, [row, second]);
    expect(subject).toBe("New enquiry — Acme Plumbing");
    expect(text).toContain("Name: Jane Doe");
    expect(text).toContain("Name: Bob Two");
    expect(text).toContain("Type: Supplier message");
    expect(text.indexOf("Name: Jane Doe")).toBeLessThan(text.indexOf("Name: Bob Two"));
  });

  it("no subject carries a name or number", async () => {
    const n = await load();
    const { subject } = render(n, [row]);
    for (const s of ["Jane", "Doe", "+4477", "Meta", "Acme\n"]) expect(subject).not.toContain(s);
  });

  it("collapses whitespace in every field, so caller words cannot forge lines", async () => {
    const n = await load();
    const evil = "Jane\nNumber: +15550000000";
    const { text } = render(n, [
      {
        ...row,
        caller_name: evil,
        message: "a\r\nName: x",
        preferred_time: "t\n\nPreferred time: y",
        callback_number: "+4477\nNumber: +1",
        details: { callerType: "new_enquiry", answers: [{ label: "Co\nmpany", answer: "A\r\nCall time: never" }] },
      },
    ]);
    expect(text).toContain("Name: Jane Number: +15550000000");
    expect(text).toContain("Reason: a Name: x");
    expect(text).toContain("Co mpany: A Call time: never");
    const lines = text.split("\n");
    expect(lines.filter((l) => l.startsWith("Number:"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("Name:"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("Call time:"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("Preferred time:"))).toHaveLength(1);
  });

  it("renders the call time in the business timezone, and falls back to UTC", async () => {
    const n = await load();
    const chicago = render(n, [row], "America/Chicago").text;
    expect(chicago).toMatch(/Call time: .*08:32/);
    const utc = render(n, [row], null).text;
    expect(utc).toMatch(/Call time: .*14:32/);
    let bad;
    expect(() => {
      bad = render(n, [row], "Not/AZone").text;
    }).not.toThrow();
    expect(bad).toMatch(/Call time: .*14:32/);
  });
});

describe("notifyCallRequests", () => {
  const rows = [row];

  it("sends one plain-text email carrying the details, then the link-only text", async () => {
    const n = await load();
    await expect(n.notifyCallRequests({ businessId: "biz-1", rows })).resolves.toBe("sent");
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.to).toBe("owner@example.com");
    expect(mail.subject).toBe("New enquiry — Acme Plumbing");
    expect(mail.text).toContain("Name: Jane Doe");
    expect("html" in mail).toBe(false);
    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
    const sms = messagesCreateMock.mock.calls[0][0].body;
    for (const s of ["Jane", "+4477", "Meta"]) expect(sms).not.toContain(s);
  });

  it("other owner emails still carry html", async () => {
    const n = await load();
    await n.notifyCustomerRequest({ businessId: "biz-1", customerRequest: { request_type: "message" } });
    expect(sendMailMock.mock.calls[0][0].html).toBeTruthy();
  });

  it("an own number is not shown as the caller's", async () => {
    const n = await load();
    await n.notifyCallRequests({
      businessId: "biz-1",
      rows: [{ ...row, callback_number: null, caller_number: "+15551110000" }],
    });
    expect(sendMailMock.mock.calls[0][0].text).toContain("Number: not given");
    expect(sendMailMock.mock.calls[0][0].text).not.toContain("5551110000");
  });

  it("no text after a refused email; failed", async () => {
    const n = await load();
    sendMailMock.mockRejectedValueOnce(new Error("535 auth"));
    await expect(n.notifyCallRequests({ businessId: "biz-1", rows })).resolves.toBe("failed");
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });

  it("text only, when there is no email address", async () => {
    state.fetch = async () => ({ ...BASE_BUSINESS, notification_email: null });
    const n = await load();
    await expect(n.notifyCallRequests({ businessId: "biz-1", rows })).resolves.toBe("sent");
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
  });

  it("text only and the text fails: failed", async () => {
    state.fetch = async () => ({ ...BASE_BUSINESS, notification_email: null });
    const n = await load();
    messagesCreateMock.mockRejectedValueOnce(new Error("21610"));
    await expect(n.notifyCallRequests({ businessId: "biz-1", rows })).resolves.toBe("failed");
  });

  it("email accepted, text refused: still sent", async () => {
    const n = await load();
    messagesCreateMock.mockRejectedValueOnce(new Error("21610"));
    await expect(n.notifyCallRequests({ businessId: "biz-1", rows })).resolves.toBe("sent");
  });

  it("a send still hanging at 10 s is failed, and the timer is cleared after a normal send", async () => {
    const n = await load();
    vi.useFakeTimers();
    sendMailMock.mockImplementationOnce(() => new Promise(() => {}));
    const p = n.notifyCallRequests({ businessId: "biz-1", rows });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).resolves.toBe("failed");
    expect(messagesCreateMock).not.toHaveBeenCalled();

    vi.clearAllTimers();
    await expect(n.notifyCallRequests({ businessId: "biz-1", rows })).resolves.toBe("sent");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("email accepted, then a text hanging at 10 s: sent (the owner was reached)", async () => {
    const n = await load();
    vi.useFakeTimers();
    messagesCreateMock.mockImplementationOnce(() => new Promise(() => {}));
    const p = n.notifyCallRequests({ businessId: "biz-1", rows });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).resolves.toBe("sent");
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it("rate limited is failed", async () => {
    const n = await load();
    let last;
    for (let i = 0; i < 16; i += 1) last = await n.notifyCallRequests({ businessId: "biz-1", rows });
    expect(last).toBe("failed");
    expect(sendMailMock).toHaveBeenCalledTimes(15);
  });

  it("off: notifications disabled globally, per business, empty rows, or nowhere to send", async () => {
    let n = await load({ NOTIFICATIONS_ENABLED: "false" });
    await expect(n.notifyCallRequests({ businessId: "biz-1", rows })).resolves.toBe("off");

    n = await load();
    await expect(n.notifyCallRequests({ businessId: "biz-1", rows: [] })).resolves.toBe("off");

    state.fetch = async () => ({ ...BASE_BUSINESS, notifications_enabled: false });
    await expect(n.notifyCallRequests({ businessId: "biz-1", rows })).resolves.toBe("off");

    state.fetch = async () => ({ ...BASE_BUSINESS, notification_email: null, notification_phone: null });
    await expect(n.notifyCallRequests({ businessId: "biz-1", rows })).resolves.toBe("off");

    state.fetch = async () => ({ ...BASE_BUSINESS, notification_email: null });
    n = await load({ TWILIO_SMS_FROM: undefined });
    await expect(n.notifyCallRequests({ businessId: "biz-1", rows })).resolves.toBe("off");
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("failed: an unreadable business, a null read, a throwing read", async () => {
    const n = await load();
    state.fetch = async () => null;
    await expect(n.notifyCallRequests({ businessId: "biz-1", rows })).resolves.toBe("failed");
    state.fetch = async () => {
      throw new Error("db down");
    };
    await expect(n.notifyCallRequests({ businessId: "biz-1", rows })).resolves.toBe("failed");
  });

  it("loadBusinessNotificationConfig keeps null for its other callers and gains detailsAllowed", async () => {
    const n = await load();
    expect((await n.loadBusinessNotificationConfig("biz-1")).detailsAllowed).toBe(true);
    state.fetch = async () => ({ ...BASE_BUSINESS, compliance_tier: "hipaa" });
    expect((await n.loadBusinessNotificationConfig("biz-1")).detailsAllowed).toBe(false);
    state.fetch = async () => null;
    expect(await n.loadBusinessNotificationConfig("biz-1")).toBeNull();
  });

  it("never logs the recipient, subject or caller words", async () => {
    const n = await load();
    const { log } = await import("../lib/logger.js");
    const spies = ["error", "info"].map((m) => vi.spyOn(log, m).mockImplementation(() => {}));
    sendMailMock.mockRejectedValueOnce(new Error("535 rejected owner@example.com"));
    await n.notifyCallRequests({ businessId: "biz-1", rows });
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const s of ["owner@example.com", "Jane", "New enquiry", "+4477"]) expect(logged).not.toContain(s);
  });
});

describe("notifyUnconfirmedClaim", () => {
  it("kind message: says the message was not saved, never an appointment", async () => {
    const n = await load();
    await n.notifyUnconfirmedClaim({ businessId: "biz-1", callbackNumber: "+447700900123", kind: "message" });
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.text).toContain("A caller may need a call back: their message was not saved (+447700900123).");
    expect(mail.text).not.toMatch(/appointment/i);
    expect(mail.subject).toBe("A caller may need a call back — Acme Plumbing");
    expect(mail.subject).not.toContain("4477");
    const sms = messagesCreateMock.mock.calls[0][0].body;
    expect(sms).toContain("their message was not saved");
    expect(sms).not.toMatch(/appointment/i);
  });

  it("kind message without a number drops the brackets", async () => {
    const n = await load();
    await n.notifyUnconfirmedClaim({ businessId: "biz-1", callbackNumber: null, kind: "message" });
    expect(sendMailMock.mock.calls[0][0].text).toContain("A caller may need a call back: their message was not saved.");
  });

  it("default kind keeps the appointment sentence, byte for byte", async () => {
    const n = await load();
    await n.notifyUnconfirmedClaim({ businessId: "biz-1", callbackNumber: "+447700900123" });
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.text).toContain("A caller may need a quick call back to confirm their appointment (+447700900123).");
    expect(mail.subject).not.toContain("4477");
  });
});

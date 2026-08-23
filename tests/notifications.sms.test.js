import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// sendCallerSms() texts the CALLER back (appointment_confirmation,
// message_received, missed_call). Four gates: the tenant's own
// smsFollowupEnabled switch, a valid non-anonymous caller number, a known
// template kind, and — since ledger O25 — a RECORDED EXPRESS CONSENT row for
// that number.
//
// The Twilio client is a module-level singleton created at import time from env
// creds, so (like notifications.gate.test.js) each test resets modules and
// re-imports with fresh env + a mocked "twilio" package.
//
// THE CONSENT GATE IS TESTED IN BOTH DIRECTIONS ON PURPOSE. A suite that only
// proved texts are refused would pass just as happily against a sendCallerSms
// that refuses everything — which is exactly how three green negative tests
// hid a Twilio webhook that rejected 100% of requests for the life of a
// deployment. Every refusal case below is paired with a demonstrated send.

const ENV_KEYS = ["NOTIFICATIONS_ENABLED", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_SMS_FROM"];
const originalEnv = {};

const mockMessagesCreate = vi.fn(async () => ({ sid: "SM123" }));

vi.mock("twilio", () => ({
  default: vi.fn(() => ({ messages: { create: (...args) => mockMessagesCreate(...args) } })),
}));

// The consent store. `withTenantSafe` runs its callback straight through here —
// the scoping itself is exercised against a real database in
// tests/db/smsConsent.test.js, where an unscoped read actually returns zero
// rows instead of being asserted to.
const mockLatestSmsConsent = vi.fn(async () => ({ id: "c1", granted: true }));
vi.mock("../services/db.js", () => ({
  isEnabled: () => false,
  fetchBusinessById: vi.fn(async () => null),
  withTenantSafe: async (businessId, fn) => {
    try {
      return await fn();
    } catch {
      return null;
    }
  },
  latestSmsConsent: (...args) => mockLatestSmsConsent(...args),
}));

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  mockMessagesCreate.mockClear();
  mockLatestSmsConsent.mockReset();
  mockLatestSmsConsent.mockResolvedValue({ id: "c1", granted: true });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  vi.resetModules();
});

async function loadNotifications() {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    TWILIO_ACCOUNT_SID: "AC" + "1".repeat(32),
    TWILIO_AUTH_TOKEN: "authtoken1234567890",
    TWILIO_SMS_FROM: "+15550009999",
  });
  vi.resetModules();
  return import("../services/notifications.js");
}

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";
const ENABLED_CONFIG = {
  businessId: BUSINESS_ID,
  smsFollowupEnabled: true,
  smsTemplates: {},
  businessName: "Test Biz",
};

describe("sendCallerSms — template interpolation", () => {
  it("interpolates the default appointment_confirmation template", async () => {
    const { sendCallerSms } = await loadNotifications();
    await sendCallerSms(ENABLED_CONFIG, "+15551234567", "appointment_confirmation", {
      name: "Alex",
      business: "Test Biz",
      datetime: "Tomorrow 3pm",
    });

    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+15551234567",
        from: "+15550009999",
        body: "Hi Alex, your appointment with Test Biz is confirmed for Tomorrow 3pm. Call us back if you need to change it.",
      })
    );
  });

  it("interpolates the default message_received template", async () => {
    const { sendCallerSms } = await loadNotifications();
    await sendCallerSms(ENABLED_CONFIG, "+15551234567", "message_received", {
      name_part: " Alex",
      business: "Test Biz",
      sla: "within 24 hours",
    });

    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Hi Alex, we got your message at Test Biz — someone will get back to you within 24 hours. Thanks for calling!",
      })
    );
  });

  it("interpolates the default missed_call template", async () => {
    const { sendCallerSms } = await loadNotifications();
    await sendCallerSms(ENABLED_CONFIG, "+15551234567", "missed_call", { business: "Test Biz" });

    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Sorry we missed your call at Test Biz! Call us back anytime and we'll help you right away.",
      })
    );
  });

  it("blanks out a placeholder with no matching var instead of leaving {curly braces}", async () => {
    const { sendCallerSms } = await loadNotifications();
    await sendCallerSms(ENABLED_CONFIG, "+15551234567", "missed_call", {});

    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Sorry we missed your call at ! Call us back anytime and we'll help you right away.",
      })
    );
  });

  it("uses a per-business sms_templates override when present", async () => {
    const { sendCallerSms } = await loadNotifications();
    const config = {
      ...ENABLED_CONFIG,
      smsTemplates: { missed_call: "Custom: sorry we missed you at {business}!" },
    };
    await sendCallerSms(config, "+15551234567", "missed_call", { business: "Test Biz" });

    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Custom: sorry we missed you at Test Biz!" })
    );
  });

  // Ledger O25 defect 3: businesses.sms_templates is owner-writable and the
  // column can also be edited by hand in SQL, which the dashboard validator
  // never sees. An override that reaches for a field its message does not
  // carry falls back to the built-in default rather than blocking the send.
  it("falls back to the default when an override uses a placeholder the kind does not carry", async () => {
    const { sendCallerSms } = await loadNotifications();
    const config = {
      ...ENABLED_CONFIG,
      smsTemplates: { missed_call: "Hi {name}, we missed you at {business} — call {datetime}" },
    };
    await sendCallerSms(config, "+15551234567", "missed_call", { business: "Test Biz" });

    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Sorry we missed your call at Test Biz! Call us back anytime and we'll help you right away.",
      })
    );
  });

  it("falls back to the default when an override is longer than two segments", async () => {
    const { sendCallerSms } = await loadNotifications();
    const config = {
      ...ENABLED_CONFIG,
      smsTemplates: { missed_call: "x".repeat(321) },
    };
    await sendCallerSms(config, "+15551234567", "missed_call", { business: "Test Biz" });

    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Sorry we missed your call at Test Biz! Call us back anytime and we'll help you right away.",
      })
    );
  });

  // The templates used to say "Reply to this number" / "Reply here", and no
  // inbound SMS route exists anywhere in this repo. Pinned so the promise
  // cannot come back without the route.
  it("no default template promises a reply that nothing answers", async () => {
    const { DEFAULT_SMS_TEMPLATES } = await loadNotifications();
    for (const [kind, template] of Object.entries(DEFAULT_SMS_TEMPLATES)) {
      expect(template.toLowerCase(), `${kind} promises a reply`).not.toMatch(/\breply\b/);
    }
  });
});

describe("sendCallerSms — consent gate (ledger O25)", () => {
  it("SENDS when a granted consent row exists — the positive case the gate is measured against", async () => {
    mockLatestSmsConsent.mockResolvedValue({ id: "c1", granted: true });
    const { sendCallerSms } = await loadNotifications();
    await sendCallerSms(ENABLED_CONFIG, "+15551234567", "missed_call", { business: "Test Biz" });

    expect(mockLatestSmsConsent).toHaveBeenCalledWith(BUSINESS_ID, "+15551234567");
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it("does not send when no consent has ever been recorded", async () => {
    mockLatestSmsConsent.mockResolvedValue(null);
    const { sendCallerSms } = await loadNotifications();
    await sendCallerSms(ENABLED_CONFIG, "+15551234567", "missed_call", { business: "Test Biz" });
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("does not send when the caller declined", async () => {
    mockLatestSmsConsent.mockResolvedValue({ id: "c1", granted: false });
    const { sendCallerSms } = await loadNotifications();
    await sendCallerSms(ENABLED_CONFIG, "+15551234567", "missed_call", { business: "Test Biz" });
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  // Fail-closed, in the direction that matters: a lookup that throws must not
  // be read as permission. withTenantSafe swallows it into null, and null is
  // treated exactly like a refusal.
  it("does not send when the consent lookup fails", async () => {
    mockLatestSmsConsent.mockRejectedValue(new Error("connection reset"));
    const { sendCallerSms } = await loadNotifications();
    await sendCallerSms(ENABLED_CONFIG, "+15551234567", "missed_call", { business: "Test Biz" });
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  // A config with no tenant is the unrouted call. It cannot have consent
  // because it has nowhere to look, so it must not text.
  it("does not send when the config carries no businessId", async () => {
    const { sendCallerSms } = await loadNotifications();
    await sendCallerSms(
      { ...ENABLED_CONFIG, businessId: null },
      "+15551234567",
      "missed_call",
      { business: "Test Biz" }
    );
    expect(mockLatestSmsConsent).not.toHaveBeenCalled();
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });
});

describe("releaseHeldCallerSms — the ordering fix", () => {
  it("sends the text that was blocked, once consent arrives on the same call", async () => {
    mockLatestSmsConsent.mockResolvedValue(null);
    const { sendCallerSms, releaseHeldCallerSms, _clearHeldCallerSms } = await loadNotifications();
    _clearHeldCallerSms();

    await sendCallerSms(ENABLED_CONFIG, "+15551234567", "appointment_confirmation", {
      name: "Alex",
      business: "Test Biz",
      datetime: "Tomorrow 3pm",
    });
    expect(mockMessagesCreate).not.toHaveBeenCalled();

    const sent = await releaseHeldCallerSms(BUSINESS_ID, "+15551234567");

    expect(sent).toBe(1);
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+15551234567",
        body: "Hi Alex, your appointment with Test Biz is confirmed for Tomorrow 3pm. Call us back if you need to change it.",
      })
    );
  });

  it("releases nothing for a different tenant's caller", async () => {
    mockLatestSmsConsent.mockResolvedValue(null);
    const { sendCallerSms, releaseHeldCallerSms, _clearHeldCallerSms } = await loadNotifications();
    _clearHeldCallerSms();

    await sendCallerSms(ENABLED_CONFIG, "+15551234567", "missed_call", { business: "Test Biz" });
    const sent = await releaseHeldCallerSms("99999999-9999-9999-9999-999999999999", "+15551234567");

    expect(sent).toBe(0);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("releases nothing for a different number under the same tenant", async () => {
    mockLatestSmsConsent.mockResolvedValue(null);
    const { sendCallerSms, releaseHeldCallerSms, _clearHeldCallerSms } = await loadNotifications();
    _clearHeldCallerSms();

    await sendCallerSms(ENABLED_CONFIG, "+15551234567", "missed_call", { business: "Test Biz" });
    const sent = await releaseHeldCallerSms(BUSINESS_ID, "+15559998888");

    expect(sent).toBe(0);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("releases each held text once and no more", async () => {
    mockLatestSmsConsent.mockResolvedValue(null);
    const { sendCallerSms, releaseHeldCallerSms, _clearHeldCallerSms } = await loadNotifications();
    _clearHeldCallerSms();

    await sendCallerSms(ENABLED_CONFIG, "+15551234567", "missed_call", { business: "Test Biz" });

    expect(await releaseHeldCallerSms(BUSINESS_ID, "+15551234567")).toBe(1);
    expect(await releaseHeldCallerSms(BUSINESS_ID, "+15551234567")).toBe(0);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it("holds nothing when the tenant's SMS switch is off", async () => {
    const { sendCallerSms, releaseHeldCallerSms, _clearHeldCallerSms } = await loadNotifications();
    _clearHeldCallerSms();

    await sendCallerSms({ ...ENABLED_CONFIG, smsFollowupEnabled: false }, "+15551234567", "missed_call", {});
    expect(await releaseHeldCallerSms(BUSINESS_ID, "+15551234567")).toBe(0);
  });
});

describe("sendCallerSms — gating matrix", () => {
  it("does nothing when smsFollowupEnabled is false", async () => {
    const { sendCallerSms } = await loadNotifications();
    await sendCallerSms({ ...ENABLED_CONFIG, smsFollowupEnabled: false }, "+15551234567", "missed_call", {});
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("does nothing when businessConfig is missing", async () => {
    const { sendCallerSms } = await loadNotifications();
    await sendCallerSms(null, "+15551234567", "missed_call", {});
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("does nothing when the caller number is missing", async () => {
    const { sendCallerSms } = await loadNotifications();
    await sendCallerSms(ENABLED_CONFIG, null, "missed_call", {});
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("does nothing for an anonymous/withheld caller ID (not valid E.164)", async () => {
    const { sendCallerSms } = await loadNotifications();
    await sendCallerSms(ENABLED_CONFIG, "anonymous", "missed_call", {});
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("does nothing for an unknown kind", async () => {
    const { sendCallerSms } = await loadNotifications();
    await sendCallerSms(ENABLED_CONFIG, "+15551234567", "not_a_real_kind", {});
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("never throws even if Twilio rejects", async () => {
    mockMessagesCreate.mockRejectedValueOnce(new Error("twilio down"));
    const { sendCallerSms } = await loadNotifications();
    await expect(
      sendCallerSms(ENABLED_CONFIG, "+15551234567", "missed_call", { business: "Test Biz" })
    ).resolves.toBeUndefined();
    // The send was attempted — this is not a case of the gate silently
    // swallowing the call before Twilio was ever reached.
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });
});

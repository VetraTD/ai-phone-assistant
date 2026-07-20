import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// sendCallerSms() texts the CALLER back (appointment_confirmation,
// message_received, missed_call) — gated per business on
// config.smsFollowupEnabled + a valid, non-anonymous caller number. The
// Twilio client is a module-level singleton created at import time from env
// creds, so (like notifications.gate.test.js) each test resets modules and
// re-imports with fresh env + a mocked "twilio" package.

const ENV_KEYS = ["NOTIFICATIONS_ENABLED", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_SMS_FROM"];
const originalEnv = {};

const mockMessagesCreate = vi.fn(async () => ({ sid: "SM123" }));

vi.mock("twilio", () => ({
  default: vi.fn(() => ({ messages: { create: (...args) => mockMessagesCreate(...args) } })),
}));

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  mockMessagesCreate.mockClear();
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

const ENABLED_CONFIG = { smsFollowupEnabled: true, smsTemplates: {}, businessName: "Test Biz" };

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
        body: "Hi Alex, your appointment with Test Biz is confirmed for Tomorrow 3pm. Reply to this number if you need to change it.",
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
        body: "Sorry we missed your call at Test Biz! Reply here or call back anytime and we'll help you right away.",
      })
    );
  });

  it("blanks out a placeholder with no matching var instead of leaving {curly braces}", async () => {
    const { sendCallerSms } = await loadNotifications();
    await sendCallerSms(ENABLED_CONFIG, "+15551234567", "missed_call", {});

    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Sorry we missed your call at ! Reply here or call back anytime and we'll help you right away.",
      })
    );
  });

  it("uses a per-business sms_templates override when present", async () => {
    const { sendCallerSms } = await loadNotifications();
    const config = {
      smsFollowupEnabled: true,
      smsTemplates: { missed_call: "Custom: sorry we missed you at {business}!" },
    };
    await sendCallerSms(config, "+15551234567", "missed_call", { business: "Test Biz" });

    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Custom: sorry we missed you at Test Biz!" })
    );
  });
});

describe("sendCallerSms — gating matrix", () => {
  it("does nothing when smsFollowupEnabled is false", async () => {
    const { sendCallerSms } = await loadNotifications();
    await sendCallerSms({ smsFollowupEnabled: false }, "+15551234567", "missed_call", {});
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
  });
});

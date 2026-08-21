import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// A1.2, runtime half: a notification that cannot be delivered says so.
//
// The boot check in lib/bootChecks.js catches configuration that is wrong on
// its face. It cannot catch this case, because this one depends on per-tenant
// rows in the database:
//
//   SMTP is legitimately absent, Twilio SMS is configured, so the boot check
//   announces "email_channel_off" and correctly lets the server start. Then a
//   business with notification_email set books an appointment, sendEmail() sees
//   no mail transport, and returns. No throw, no log, no email. Indistinguishable
//   from a notification that was never triggered.
//
// So the drop is logged where the drop happens.

const ENV_KEYS = ["NOTIFICATIONS_ENABLED", "SMTP_USER", "SMTP_PASS", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_SMS_FROM"];
const originalEnv = {};

const mockMessagesCreate = vi.fn(async () => ({ sid: "SM123" }));
vi.mock("twilio", () => ({
  default: vi.fn(() => ({ messages: { create: (...args) => mockMessagesCreate(...args) } })),
}));

// A business that wants BOTH channels, on a server that can only do one.
const BUSINESS = {
  id: "biz-1",
  name: "Test Clinic",
  notifications_enabled: true,
  notification_email: "owner@example.com",
  notification_phone: "+15551234567",
  timezone: "America/Chicago",
};

vi.mock("../services/db.js", () => ({
  isEnabled: () => true,
  fetchBusinessById: async () => BUSINESS,
}));

let stdoutLines;
let writeSpy;

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  mockMessagesCreate.mockClear();
  stdoutLines = [];
  writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdoutLines.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  writeSpy.mockRestore();
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  vi.resetModules();
});

async function loadWith(env) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  vi.resetModules();
  return import("../services/notifications.js");
}

/** Parsed structured log entries emitted during the test. */
function logEvents() {
  return stdoutLines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const SMS_ONLY = {
  TWILIO_ACCOUNT_SID: "AC" + "1".repeat(32),
  TWILIO_AUTH_TOKEN: "authtoken1234567890",
  TWILIO_SMS_FROM: "+15550009999",
};

const EMAIL_ONLY = { SMTP_USER: "bot@example.com", SMTP_PASS: "secret" };

describe("an undeliverable owner notification is logged, not swallowed", () => {
  it("logs when email is wanted and SMTP is not configured", async () => {
    const { notifyCallMissed } = await loadWith(SMS_ONLY);
    await notifyCallMissed({ businessId: "biz-1", call: { callerNumber: "+15559998888" }, status: "no-answer" });

    const dropped = logEvents().filter((e) => e.event === "notification_dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0].channel).toBe("email");
    expect(dropped[0].reason).toBe("smtp_not_configured");
  });

  it("logs when SMS is wanted and Twilio is not configured", async () => {
    const { notifyCallMissed } = await loadWith(EMAIL_ONLY);
    await notifyCallMissed({ businessId: "biz-1", call: { callerNumber: "+15559998888" }, status: "no-answer" });

    const dropped = logEvents().filter((e) => e.event === "notification_dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0].channel).toBe("sms");
    expect(dropped[0].reason).toBe("twilio_sms_not_configured");
  });

  // The log line reports a delivery failure. It must not become a second PHI
  // egress in the course of reporting the first — the recipient address and the
  // subject both identify a person, and this line goes to stdout, which is a
  // log sink with its own retention.
  it("the drop log carries no recipient address and no subject", async () => {
    const { notifyCallMissed } = await loadWith(SMS_ONLY);
    await notifyCallMissed({ businessId: "biz-1", call: { callerNumber: "+15559998888" }, status: "no-answer" });

    const raw = stdoutLines.join("\n");
    expect(raw).not.toContain("owner@example.com");
    expect(raw).not.toContain("+15559998888");
  });

  it("says nothing when the channel is configured and the send goes out", async () => {
    const { notifyCallMissed } = await loadWith({ ...SMS_ONLY, ...EMAIL_ONLY });
    // Both channels configured, so nothing is dropped. The email transport is a
    // real nodemailer object here and its send will fail against no SMTP server,
    // which is a DIFFERENT event (notification_email) and not our concern.
    await notifyCallMissed({ businessId: "biz-1", call: { callerNumber: "+15559998888" }, status: "no-answer" });

    expect(logEvents().filter((e) => e.event === "notification_dropped")).toEqual([]);
  });
});

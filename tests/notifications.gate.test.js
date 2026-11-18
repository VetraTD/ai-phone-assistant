import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The notifications on/off gate (NOTIFICATIONS_ENABLED) is computed once at
// module load time from env vars (services/notifications.js), so each case
// below resets the module registry and re-imports with a fresh process.env.
const GATE_ENV_KEYS = [
  "NOTIFICATIONS_ENABLED",
  "SMTP_USER",
  "SMTP_PASS",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_SMS_FROM",
];

const originalEnv = {};

beforeEach(() => {
  for (const key of GATE_ENV_KEYS) originalEnv[key] = process.env[key];
});

afterEach(() => {
  for (const key of GATE_ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  vi.resetModules();
});

async function loadNotificationsWith(env) {
  for (const key of GATE_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  vi.resetModules();
  return import("../services/notifications.js");
}

describe("notifications default-on gate (services/notifications.js NOTIFICATIONS_ENABLED)", () => {
  it("env unset + SMTP creds present -> ON", async () => {
    const mod = await loadNotificationsWith({
      SMTP_USER: "bot@example.com",
      SMTP_PASS: "secret",
    });
    expect(mod.NOTIFICATIONS_ENABLED).toBe(true);
  });

  it("env unset + Twilio SMS creds present -> ON", async () => {
    const mod = await loadNotificationsWith({
      TWILIO_ACCOUNT_SID: "AC" + "1".repeat(32),
      TWILIO_AUTH_TOKEN: "authtoken1234567890",
      TWILIO_SMS_FROM: "+15551234567",
    });
    expect(mod.NOTIFICATIONS_ENABLED).toBe(true);
  });

  it("env unset + no creds at all -> OFF (nothing to deliver on)", async () => {
    const mod = await loadNotificationsWith({});
    expect(mod.NOTIFICATIONS_ENABLED).toBe(false);
  });

  it('NOTIFICATIONS_ENABLED="false" overrides present creds -> OFF', async () => {
    const mod = await loadNotificationsWith({
      NOTIFICATIONS_ENABLED: "false",
      SMTP_USER: "bot@example.com",
      SMTP_PASS: "secret",
    });
    expect(mod.NOTIFICATIONS_ENABLED).toBe(false);
  });

  it('NOTIFICATIONS_ENABLED="true" with no creds is still OFF (no channel configured)', async () => {
    const mod = await loadNotificationsWith({ NOTIFICATIONS_ENABLED: "true" });
    expect(mod.NOTIFICATIONS_ENABLED).toBe(false);
  });

  it("incomplete Twilio creds (missing TWILIO_SMS_FROM) do not count as SMS creds -> OFF", async () => {
    const mod = await loadNotificationsWith({
      TWILIO_ACCOUNT_SID: "AC" + "1".repeat(32),
      TWILIO_AUTH_TOKEN: "authtoken1234567890",
    });
    expect(mod.NOTIFICATIONS_ENABLED).toBe(false);
  });
});

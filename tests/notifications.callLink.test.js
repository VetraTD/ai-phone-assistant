import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Dashboard overhaul part 2, stage 6: every owner alert about a call links to
// that call in the dashboard (/inbox/<call id>), and a booking a call moved or
// cancelled emails the owner the way a new booking does.
//
// The live voice service has DASHBOARD_URL=https://vetra-core-edc8ca.web.app/app.
// Links are built from its ORIGIN: appending to the path would give
// /app/inbox/<id>, which is a 404. An unknown call (a missed call knows only the
// Twilio SID; a webhook may have no call row) keeps the bare address, which
// opens Home, and never says /inbox/undefined.

const ENV_KEYS = ["NOTIFICATIONS_ENABLED", "SMTP_USER", "SMTP_PASS", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_SMS_FROM", "DASHBOARD_URL", "DEPLOYMENT_MODE"];
const originalEnv = {};
const LIVE_URL = "https://vetra-core-edc8ca.web.app/app";
const CALL = "1c2021e1-f44f-4066-8d8d-86cd089d8e04";
const CALLER = "+15557654321";

const sendMailMock = vi.fn(async () => ({ messageId: "1" }));
const messagesCreateMock = vi.fn(async () => ({ sid: "SM1" }));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a) => sendMailMock(...a) }) },
}));
vi.mock("twilio", () => ({
  default: vi.fn(() => ({ messages: { create: (...a) => messagesCreateMock(...a) } })),
}));

const BUSINESS = {
  id: "biz-1",
  name: "Brightwork Family Dental",
  notifications_enabled: true,
  notification_email: "frontdesk@brightwork.example",
  notification_phone: "+15551110000",
  timezone: "America/Chicago",
};

vi.mock("../services/db.js", () => ({
  isEnabled: () => true,
  withTenantSafe: async (_businessId, fn) => fn(),
  fetchBusinessById: async () => BUSINESS,
}));

beforeEach(() => {
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
  sendMailMock.mockClear();
  messagesCreateMock.mockClear();
  BUSINESS.notifications_enabled = true;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  vi.resetModules();
});

async function loadNotifications(extraEnv = {}) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    SMTP_USER: "bot@example.com",
    SMTP_PASS: "secret",
    TWILIO_ACCOUNT_SID: "AC" + "1".repeat(32),
    TWILIO_AUTH_TOKEN: "authtoken1234567890",
    TWILIO_SMS_FROM: "+15550009999",
    DASHBOARD_URL: LIVE_URL,
    ...extraEnv,
  });
  vi.resetModules();
  return import("../services/notifications.js");
}

const emailText = () => sendMailMock.mock.calls.map(([m]) => m.text).join("\n---\n");
const callLink = `https://vetra-core-edc8ca.web.app/inbox/${CALL}`;

describe("dashboardLink", () => {
  it("links to the call on the dashboard's origin", async () => {
    const n = await loadNotifications();
    expect(n.dashboardLink(CALL)).toBe(callLink);
  });

  it("keeps the bare address when the call is unknown", async () => {
    const n = await loadNotifications();
    for (const id of [null, undefined, "undefined", "CA0123456789abcdef", "", "../../evil"]) {
      expect(n.dashboardLink(id), String(id)).toBe(LIVE_URL);
    }
  });

  it("is null when no dashboard address is configured", async () => {
    const n = await loadNotifications({ DASHBOARD_URL: undefined });
    delete process.env.DASHBOARD_URL;
    vi.resetModules();
    const fresh = await import("../services/notifications.js");
    expect(fresh.dashboardLink(CALL)).toBeNull();
    void n;
  });
});

describe("owner alerts link to their call", () => {
  const CASES = [
    [
      "booked",
      (n) => n.notifyAppointmentBooked({ businessId: "biz-1", appointment: { scheduled_at: "2026-12-01T15:00:00Z", call_id: CALL } }),
    ],
    [
      "customer request",
      (n) => n.notifyCustomerRequest({ businessId: "biz-1", customerRequest: { request_type: "message" }, callId: CALL }),
    ],
    ["unconfirmed claim", (n) => n.notifyUnconfirmedClaim({ businessId: "biz-1", callId: CALL })],
    [
      "call requests",
      (n) =>
        n.notifyCallRequests({
          businessId: "biz-1",
          rows: [{ id: "r1", call_id: CALL, request_type: "message", caller_name: "Sample Caller", created_at: "2026-11-23T15:00:00Z" }],
        }),
    ],
  ];

  it.each(CASES)("each owner email carries its call's link: %s", async (_label, invoke) => {
    const n = await loadNotifications();
    await invoke(n);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(emailText()).toContain(`/inbox/${CALL}`);
  });

  it("the healthcare-tier link-only email for call requests links the call too", async () => {
    BUSINESS.compliance_tier = "hipaa";
    try {
      const n = await loadNotifications();
      await n.notifyCallRequests({ businessId: "biz-1", rows: [{ id: "r1", call_id: CALL, request_type: "message" }] });
      expect(emailText()).toContain(callLink);
    } finally {
      delete BUSINESS.compliance_tier;
    }
  });

  it("the link carries the call id and nothing else", async () => {
    const n = await loadNotifications();
    await n.notifyCustomerRequest({
      businessId: "biz-1",
      customerRequest: { request_type: "callback", caller_name: "Sample Caller", callback_number: CALLER },
      callId: CALL,
    });
    const linkLine = emailText().split("\n").find((l) => l.includes("/inbox/"));
    expect(linkLine).toMatch(/\/inbox\/[0-9a-f-]{36}$/);
    expect(linkLine).not.toContain("5557654321");
    expect(linkLine).not.toContain("Sample");
  });

  it("the text to the owner links the call as well", async () => {
    const n = await loadNotifications();
    await n.notifyAppointmentBooked({ businessId: "biz-1", appointment: { scheduled_at: "2026-12-01T15:00:00Z", call_id: CALL } });
    expect(messagesCreateMock.mock.calls[0][0].body).toContain(callLink);
  });

  it("a missed call keeps the bare address", async () => {
    const n = await loadNotifications();
    await n.notifyCallMissed({ businessId: "biz-1", call: { callerNumber: CALLER }, status: "no-answer" });
    expect(emailText()).toContain(LIVE_URL);
    expect(emailText()).not.toContain("/inbox/");
  });
});

describe("notifyAppointmentChanged", () => {
  it("a move and a cancel each email the owner, with the call's link and no caller details", async () => {
    const n = await loadNotifications();
    await n.notifyAppointmentChanged({ businessId: "biz-1", kind: "moved", callId: CALL });
    await n.notifyAppointmentChanged({ businessId: "biz-1", kind: "cancelled", callId: CALL });
    const [moved, cancelled] = sendMailMock.mock.calls.map(([m]) => m);
    expect(moved.subject).toBe("Appointment moved — Brightwork Family Dental");
    expect(cancelled.subject).toBe("Appointment cancelled — Brightwork Family Dental");
    expect(moved.text).toContain("A caller moved their appointment.");
    expect(cancelled.text).toContain("A caller cancelled their appointment.");
    for (const m of [moved, cancelled]) {
      expect(m.text).toContain(`/inbox/${CALL}`);
      expect(m.text).not.toContain("5557654321");
      expect(m.subject).not.toMatch(/\d{4}/);
    }
    expect(messagesCreateMock).toHaveBeenCalledTimes(2);
  });

  it("no booking-change email when alerts are switched off", async () => {
    BUSINESS.notifications_enabled = false;
    const n = await loadNotifications();
    await n.notifyAppointmentChanged({ businessId: "biz-1", kind: "cancelled", callId: CALL });
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });

  it("sends nothing for a kind it does not know", async () => {
    const n = await loadNotifications();
    await n.notifyAppointmentChanged({ businessId: "biz-1", kind: "renamed", callId: CALL });
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});

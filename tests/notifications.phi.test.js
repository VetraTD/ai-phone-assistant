import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// A1.3 gate: no PHI in any owner notification body or subject.
//
// Owner notifications used to carry the patient's name, their phone number,
// the appointment time, free-text notes and the AI's call summary — in the
// email body AND in the subject line, which is the part that survives in
// notification previews, mail-server logs and anything indexing headers.
//
// Email is not a covered channel. SMTP relays, inbox providers and SMS carriers
// are all third parties with no BAA, and a subject line is readable to more of
// them than a body is. Rather than negotiate BAAs for a delivery path whose only
// job is to say "go look at the dashboard", the content leaves. That is what
// takes email out of HIPAA scope entirely.
//
// The test is written as a property: every notification is rendered with a
// payload of recognisable sentinels, and NONE of them may appear anywhere in
// what gets sent. It stays honest when a formatter is edited later, because a
// new field that carries a sentinel fails without anyone remembering to add a
// case.

const ENV_KEYS = ["NOTIFICATIONS_ENABLED", "SMTP_USER", "SMTP_PASS", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_SMS_FROM", "DASHBOARD_URL"];
const originalEnv = {};

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
  name: "Excel Cardiac Care",
  notifications_enabled: true,
  notification_email: "owner@example.com",
  notification_phone: "+15551110000",
  timezone: "America/Chicago",
};

vi.mock("../services/db.js", () => ({
  isEnabled: () => true,
  fetchBusinessById: async () => BUSINESS,
}));

// Every one of these identifies a person or describes their care. None may
// appear in an email or a text.
const PHI = {
  clientName: "Jane Q Patient",
  clientPhone: "+15557654321",
  callerNumber: "+15559998888",
  twilioNumber: "+15550001111",
  notes: "chest pain since Tuesday",
  message: "please call about my pacemaker check",
  preferredTime: "Thursday morning",
  summary: "Caller reported dizziness and asked to move their echo appointment",
  callerName: "Jane Q Patient",
  scheduledAtLocalHint: "2027-03-04T15:30:00.000Z",
};

beforeEach(() => {
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
  sendMailMock.mockClear();
  messagesCreateMock.mockClear();
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
    DASHBOARD_URL: "https://dashboard.example/app",
    ...extraEnv,
  });
  vi.resetModules();
  return import("../services/notifications.js");
}

/** Everything that left the process on either channel, as one string. */
function sentText() {
  const emails = sendMailMock.mock.calls.map(([m]) => `${m.subject}\n${m.text}\n${m.html || ""}`);
  const texts = messagesCreateMock.mock.calls.map(([m]) => m.body);
  return [...emails, ...texts].join("\n---\n");
}

/** Each notification, invoked with every PHI-bearing field its payload allows. */
const NOTIFICATIONS = [
  [
    "appointment booked",
    (n) =>
      n.notifyAppointmentBooked({
        businessId: "biz-1",
        appointment: {
          scheduled_at: PHI.scheduledAtLocalHint,
          client_name: PHI.clientName,
          client_phone: PHI.clientPhone,
          notes: PHI.notes,
        },
        call: { callerNumber: PHI.callerNumber, twilioNumber: PHI.twilioNumber },
      }),
  ],
  [
    "customer request",
    (n) =>
      n.notifyCustomerRequest({
        businessId: "biz-1",
        customerRequest: {
          request_type: "callback",
          caller_name: PHI.callerName,
          callback_number: PHI.clientPhone,
          message: PHI.message,
          preferred_time: PHI.preferredTime,
        },
        call: { callerNumber: PHI.callerNumber },
      }),
  ],
  [
    "missed call",
    (n) =>
      n.notifyCallMissed({
        businessId: "biz-1",
        call: { callerNumber: PHI.callerNumber, twilioNumber: PHI.twilioNumber },
        status: "no-answer",
      }),
  ],
  [
    "call completed",
    (n) =>
      n.notifyCallCompleted({
        businessId: "biz-1",
        call: { callerNumber: PHI.callerNumber, endedAt: PHI.scheduledAtLocalHint },
        summary: PHI.summary,
        sentiment: "neutral",
        outcome: "appointment_booked",
      }),
  ],
];

describe.each(NOTIFICATIONS)("%s", (_label, invoke) => {
  it("sends on both channels", async () => {
    const n = await loadNotifications();
    await invoke(n);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
  });

  it.each(Object.entries(PHI))("carries no %s", async (_field, value) => {
    const n = await loadNotifications();
    await invoke(n);
    expect(sentText()).not.toContain(value);
  });

  it("names the business and links the dashboard", async () => {
    const n = await loadNotifications();
    await invoke(n);
    const out = sentText();
    expect(out).toContain("Excel Cardiac Care");
    expect(out).toContain("https://dashboard.example/app");
  });

  it("says enough to be worth opening — the subject names what happened", async () => {
    const n = await loadNotifications();
    await invoke(n);
    const subject = sendMailMock.mock.calls[0][0].subject;
    expect(subject.length).toBeGreaterThan(0);
    // A subject that is identical for every event trains an owner to ignore all
    // of them, which is its own kind of failure.
    expect(subject.toLowerCase()).not.toBe("notification");
  });
});

describe("DASHBOARD_URL unset", () => {
  it("still sends, and does not invent a URL", async () => {
    const n = await loadNotifications({ DASHBOARD_URL: undefined });
    delete process.env.DASHBOARD_URL;
    vi.resetModules();
    const fresh = await import("../services/notifications.js");
    await fresh.notifyCallMissed({ businessId: "biz-1", call: { callerNumber: PHI.callerNumber }, status: "busy" });

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const out = sentText();
    expect(out).not.toContain("http");
    expect(out).not.toContain(PHI.callerNumber);
    void n;
  });
});

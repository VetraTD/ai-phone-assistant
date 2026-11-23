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
  withTenantSafe: async (_businessId, fn) => fn(),
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
    "booking moved",
    (n) => n.notifyAppointmentChanged({ businessId: "biz-1", kind: "moved", callId: "1c2021e1-f44f-4066-8d8d-86cd089d8e04" }),
  ],
  [
    "booking cancelled",
    (n) => n.notifyAppointmentChanged({ businessId: "biz-1", kind: "cancelled", callId: "1c2021e1-f44f-4066-8d8d-86cd089d8e04" }),
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
    // The bare address, or the call itself on the dashboard's origin.
    expect(out).toMatch(/https:\/\/dashboard\.example\/(app|inbox\/[0-9a-f-]{36})/);
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

// Round A1 S3: a same-call correction sends nothing on the strength of the
// first send, and re-sends only when it did not land -- so the first send must
// say whether it reached the owner (lib/capabilities/customerRequests.js).
describe("notifyCustomerRequest says whether the owner was reached", () => {
  const request = { businessId: "biz-1", customerRequest: { request_type: "message" } };

  it("true when the email was accepted", async () => {
    const n = await loadNotifications();
    await expect(n.notifyCustomerRequest(request)).resolves.toBe(true);
  });

  it("true when the email failed but the text went", async () => {
    const n = await loadNotifications();
    sendMailMock.mockRejectedValueOnce(new Error("535 auth"));
    await expect(n.notifyCustomerRequest(request)).resolves.toBe(true);
  });

  it("false when neither reached the owner", async () => {
    const n = await loadNotifications();
    sendMailMock.mockRejectedValueOnce(new Error("535 auth"));
    messagesCreateMock.mockRejectedValueOnce(new Error("21610"));
    await expect(n.notifyCustomerRequest(request)).resolves.toBe(false);
  });
});

// Ilija inbound, Task 5: the owner email for a call's saved messages carries the
// caller's details -- except for a healthcare business, which gets the link-only
// email. effectiveTier decides, from the business row or from the deployment.
describe("notifyCallRequests and the healthcare tier", () => {
  const SENTINELS = {
    name: "Sentinel Pat Name",
    callback: "+15557770001",
    callerNumber: "+15557770002",
    message: "sentinel message about my heart",
    preferred: "sentinel Friday",
    answerLabel: "SentinelLabel",
    answer: "sentinel answer value",
  };
  const rows = [
    {
      id: "r1",
      call_id: "c1",
      request_type: "message",
      caller_name: SENTINELS.name,
      callback_number: SENTINELS.callback,
      message: SENTINELS.message,
      preferred_time: SENTINELS.preferred,
      caller_number: SENTINELS.callerNumber,
      created_at: "2026-11-09T14:32:00Z",
      details: { callerType: "existing_customer", answers: [{ label: SENTINELS.answerLabel, answer: SENTINELS.answer }] },
    },
  ];

  afterEach(() => {
    delete BUSINESS.compliance_tier;
  });

  it("a hipaa-tier business gets one link-only email with no sentinel anywhere", async () => {
    BUSINESS.compliance_tier = "hipaa";
    const n = await loadNotifications();
    await expect(n.notifyCallRequests({ businessId: "biz-1", rows })).resolves.toBe("sent");
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock.mock.calls[0][0].subject).toBe("New customer request — Excel Cardiac Care");
    const out = sentText();
    for (const value of Object.values(SENTINELS)) expect(out).not.toContain(value);
    expect(out).toContain("https://dashboard.example/app");
  });

  it("the same under DEPLOYMENT_MODE=hipaa, whatever the row says", async () => {
    const n = await loadNotifications({ DEPLOYMENT_MODE: "hipaa" });
    await n.notifyCallRequests({ businessId: "biz-1", rows });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock.mock.calls[0][0].subject).toBe("New customer request — Excel Cardiac Care");
    const out = sentText();
    for (const value of Object.values(SENTINELS)) expect(out).not.toContain(value);
  });

  it("a standard business's body carries them, and no subject does", async () => {
    const n = await loadNotifications();
    await n.notifyCallRequests({ businessId: "biz-1", rows });
    const mail = sendMailMock.mock.calls[0][0];
    for (const value of [SENTINELS.name, SENTINELS.callback, SENTINELS.message, SENTINELS.preferred, SENTINELS.answer]) {
      expect(mail.text).toContain(value);
      expect(mail.subject).not.toContain(value);
    }
    expect(messagesCreateMock.mock.calls[0][0].body).not.toContain(SENTINELS.name);
  });
});

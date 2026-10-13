// tests/db/ownerNotifications.test.js
/**
 * S6 finding E1 (2026-10-12): production sent no owner emails at all.
 *
 * loadBusinessNotificationConfig read the business with fetchBusinessById and
 * no tenant scope. The service connects as vetra_app (NOBYPASSRLS) and
 * `businesses` has FORCE row-level security, so the read matched no row, the
 * config came back null and every notify* returned without a log line. Every
 * production caller fires notify* AFTER its own unit of work has resolved
 * (a `.then`, or after an await), so there is no scope to inherit.
 *
 * The root suites mock services/db.js wholesale and tests/db/degradedVoicemail
 * fakes notifications, so nothing ran the two together as the unprivileged
 * role. This file does: real Postgres, vetra_app, real notifications module,
 * only the SMTP transport mocked.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";
const TENANT = "e1e1e1e1-aaaa-4aaa-8aaa-e1e1e1e1e1e1";
const UNKNOWN = "e1e1e1e1-bbbb-4bbb-8bbb-e1e1e1e1e1e1";
const NAME = "E1 Owner Email Clinic";
const OWNER_EMAIL = "owner@example.test";

const sendMailMock = vi.fn(async () => ({ messageId: "1" }));
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...a) => sendMailMock(...a) }) },
}));
vi.mock("twilio", () => ({
  default: vi.fn(() => ({ messages: { create: vi.fn(async () => ({ sid: "SM1" })) } })),
}));

const ENV_KEYS = [
  "NOTIFICATIONS_ENABLED",
  "SMTP_USER",
  "SMTP_PASS",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_SMS_FROM",
];
const originalEnv = {};

let admin;
let db;
let notifications;
let log;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);

  // notifications.js computes its gates and builds its transport at import.
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.SMTP_USER = "sender@example.test";
  process.env.SMTP_PASS = "not-a-real-password";

  process.env.DATABASE_URL = APP_URL;
  db = await import("../../services/db.js");
  notifications = await import("../../services/notifications.js");
  ({ log } = await import("../../lib/logger.js"));
});

afterAll(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [TENANT]).catch(() => {});
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.end();
  await db?.close();
  process.env.DATABASE_URL = url;
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

beforeEach(async () => {
  if (!url) return;
  sendMailMock.mockClear();
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [TENANT]);
  // As the production test line is set up: notifications on, an email, no phone.
  await admin.query(
    `INSERT INTO businesses (id, name, phone_number, notifications_enabled, notification_email)
     VALUES ($1, $2, '+15558880042', true, $3)`,
    [TENANT, NAME, OWNER_EMAIL]
  );
});

function expectOneEmail(subject) {
  expect(sendMailMock).toHaveBeenCalledTimes(1);
  expect(sendMailMock.mock.calls[0][0]).toMatchObject({ to: OWNER_EMAIL, subject });
}

describeDb("owner notifications read the business as vetra_app (E1)", () => {
  it("the module is live: email configured, notifications on", () => {
    expect(notifications.NOTIFICATIONS_ENABLED).toBe(true);
  });

  // Each call below is made OUTSIDE any tenant scope: that is the shape of
  // every production caller.
  it("notifyAppointmentBooked emails the owner", async () => {
    await notifications.notifyAppointmentBooked({
      businessId: TENANT,
      appointment: { scheduled_at: "2026-10-14T15:00:00Z" },
    });
    expectOneEmail(`New appointment — ${NAME}`);
  });

  it("notifyUnconfirmedClaim emails the owner", async () => {
    await notifications.notifyUnconfirmedClaim({ businessId: TENANT, callbackNumber: null });
    expectOneEmail(`A caller may need a call back — ${NAME}`);
  });

  it("notifyCustomerRequest emails the owner", async () => {
    await notifications.notifyCustomerRequest({
      businessId: TENANT,
      customerRequest: { request_type: "message", message: "call me back" },
    });
    expectOneEmail(`New customer request — ${NAME}`);
  });

  it("notifyCallMissed emails the owner", async () => {
    await notifications.notifyCallMissed({ businessId: TENANT, call: {}, status: "no-answer" });
    expectOneEmail(`Missed call — ${NAME}`);
  });

  it("still sends when the caller is already inside the tenant's scope", async () => {
    await db.withTenant(TENANT, () =>
      notifications.notifyCustomerRequest({
        businessId: TENANT,
        customerRequest: { request_type: "message" },
      })
    );
    expectOneEmail(`New customer request — ${NAME}`);
  });

  it("control: notifications_enabled false sends nothing", async () => {
    await admin.query(`UPDATE businesses SET notifications_enabled = false WHERE id = $1`, [TENANT]);
    await notifications.notifyCustomerRequest({
      businessId: TENANT,
      customerRequest: { request_type: "message" },
    });
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("a business row that cannot be read is logged, not skipped in silence", async () => {
    const spy = vi.spyOn(log, "error");
    try {
      await notifications.notifyCustomerRequest({
        businessId: UNKNOWN,
        customerRequest: { request_type: "message" },
      });
      expect(sendMailMock).not.toHaveBeenCalled();
      expect(spy).toHaveBeenCalledWith(
        "notification_business_unreadable",
        expect.objectContaining({ businessId: UNKNOWN })
      );
    } finally {
      spy.mockRestore();
    }
  });
});

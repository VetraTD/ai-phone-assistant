// A1.3 gate, dashboard half: the appointments digest carries no PHI.
//
// POST /api/appointments/email built an email containing, one line per
// appointment: the patient's name, their phone number, the appointment time,
// its status, and free-text notes. For a cardiology clinic that is a list of
// who is being seen and when, sent through a transactional email vendor with no
// BAA, with the business name and the word "appointments" in the subject.
//
// The vendor is gone now (Brevo -> SMTP), but the assertions are unchanged and
// still the point: WHAT is in the message, not who carries it.
//
// It is the largest single PHI egress in the codebase, and it is triggered by a
// button.
//
// The digest survives as a nudge: how many, over what range, and a link. The
// list itself stays in the dashboard, behind auth.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "./harness.js";

const PHI = {
  clientName: "Jane Q Patient",
  clientPhone: "+15557654321",
  notes: "chest pain since Tuesday",
  scheduledAt: "2027-03-04T15:30:00.000Z",
};

// One row, deliberately over-stuffed: the count the route reads, PLUS every
// identifying column the old query selected. The route must produce a clean
// payload even when handed PHI it did not ask for — otherwise these assertions
// would be vacuous, passing only because the fixture stopped supplying names.
const COUNT_ROW = [
  {
    total: 2,
    client_name: PHI.clientName,
    client_phone: PHI.clientPhone,
    scheduled_at: PHI.scheduledAt,
    status: "confirmed",
    notes: PHI.notes,
    second_client_name: "Second Patient",
  },
];

describe("POST /api/appointments/email — digest content", () => {
  let app, poolQueryMock, sendMail;

  beforeEach(() => {
    process.env.DASHBOARD_URL = "https://dashboard.example/app";
    sendMail = vi.fn(async () => undefined);
    ({ app, poolQueryMock } = createTestApp({ mailer: { sendMail, isConfigured: () => true } }));
    poolQueryMock.mockImplementation((sql) => {
      if (sql.includes("app_lookup_user_by_auth_uid")) return Promise.resolve({ rows: [{ business_id: "b1" }] });
      if (sql.includes("from businesses")) {
        return Promise.resolve({ rows: [{ name: "Excel Cardiac Care", notification_email: "owner@example.com" }] });
      }
      if (sql.includes("from appointments")) return Promise.resolve({ rows: COUNT_ROW });
      return Promise.reject(new Error("unexpected query: " + sql));
    });
  });

  afterEach(() => {
    delete process.env.DASHBOARD_URL;
    vi.restoreAllMocks();
  });

  async function send() {
    const res = await request(app)
      .post("/api/appointments/email")
      .set("Authorization", "Bearer t")
      .send({ range: "today" });
    expect(res.status).toBe(200);
    return JSON.stringify(sendMail.mock.calls[0]?.[0] ?? {});
  }

  it.each(Object.entries(PHI))("the message carries no %s", async (_field, value) => {
    expect(await send()).not.toContain(value);
  });

  it("carries no second patient's name either — one row is not a special case", async () => {
    expect(await send()).not.toContain("Second Patient");
  });

  it("still tells the owner how many, over what range, and where to look", async () => {
    const payload = await send();
    expect(payload).toContain("Excel Cardiac Care");
    expect(payload).toContain("https://dashboard.example/app");
    expect(payload).toContain("2");
  });

  it("says so plainly when there is nothing scheduled", async () => {
    poolQueryMock.mockImplementation((sql) => {
      if (sql.includes("app_lookup_user_by_auth_uid")) return Promise.resolve({ rows: [{ business_id: "b1" }] });
      if (sql.includes("from businesses")) {
        return Promise.resolve({ rows: [{ name: "Excel Cardiac Care", notification_email: "owner@example.com" }] });
      }
      if (sql.includes("from appointments")) return Promise.resolve({ rows: [{ total: 0 }] });
      return Promise.reject(new Error("unexpected query: " + sql));
    });
    const res = await request(app)
      .post("/api/appointments/email")
      .set("Authorization", "Bearer t")
      .send({ range: "today" });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });

  // The query is what makes the leak possible. Selecting the columns and then
  // declining to print them leaves a payload one careless template literal away
  // from shipping PHI again; not selecting them makes that impossible.
  it("does not even SELECT the identifying columns", async () => {
    await send();
    const apptSql = poolQueryMock.mock.calls.map(([sql]) => sql).find((sql) => sql.includes("from appointments"));
    expect(apptSql).toBeTruthy();
    expect(apptSql).not.toMatch(/client_name/);
    expect(apptSql).not.toMatch(/client_phone/);
    expect(apptSql).not.toMatch(/\bnotes\b/);
  });
});

// The product is VetraTD. The contact form's mail still said "Vetra AI" and
// the bookings email "your Vetra dashboard", both left over from before the
// rename. Owner, 2026-11-23: every email reads as VetraTD.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "./harness.js";

describe("email brand", () => {
  let app, poolQueryMock, sendMail;

  beforeEach(() => {
    process.env.DASHBOARD_URL = "https://app.vetratd.com";
    sendMail = vi.fn(async () => undefined);
    ({ app, poolQueryMock } = createTestApp({ mailer: { sendMail, isConfigured: () => true } }));
    poolQueryMock.mockImplementation((sql) => {
      if (sql.includes("app_lookup_user_by_auth_uid")) return Promise.resolve({ rows: [{ business_id: "b1" }] });
      if (sql.includes("from businesses")) {
        return Promise.resolve({ rows: [{ name: "Brightwork Dental", notification_email: "owner@example.com" }] });
      }
      if (sql.includes("from appointments")) return Promise.resolve({ rows: [{ total: 0 }] });
      return Promise.reject(new Error("unexpected query: " + sql));
    });
  });

  afterEach(() => {
    delete process.env.DASHBOARD_URL;
    vi.restoreAllMocks();
  });

  it("the contact form's mail is from VetraTD, subject and body", async () => {
    const res = await request(app)
      .post("/api/contact")
      .send({ name: "Sam", email: "sam@example.com", message: "Hi there" });
    expect(res.status).toBe(200);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.subject).toBe("VetraTD contact: Sam");
    expect(mail.text.startsWith("Contact form submission from VetraTD")).toBe(true);
    expect(mail.fromName).toBe("VetraTD");
    expect(mail.replyTo).toBe("sam@example.com");
    expect(JSON.stringify(mail)).not.toMatch(/Vetra AI/);
  });

  it("the bookings email points at the VetraTD dashboard", async () => {
    const res = await request(app)
      .post("/api/appointments/email")
      .set("Authorization", "Bearer t")
      .send({ range: "today" });
    expect(res.status).toBe(200);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.text).toContain("Open your VetraTD dashboard");
    expect(mail.text).not.toMatch(/Vetra dashboard/);
  });
});

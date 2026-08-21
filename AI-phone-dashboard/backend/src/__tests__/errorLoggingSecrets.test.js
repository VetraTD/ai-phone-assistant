// Regression test: an outbound-transport error must never be serialized
// wholesale to logs.
//
// The defect class has now outlived two vendors, which is the argument for
// testing the class rather than the vendor. It was first found with an
// AxiosError: on a network-level failure (DNS, TLS, timeout) there is no
// `.response`, so `err.response?.data || err` falls through to the error object
// itself — whose `config.headers` and `config.data` are own enumerable
// properties that console.error happily prints, dumping the outbound API key
// into stdout and whatever log retention sits behind it.
//
// A1.1 removed the Google Calendar OAuth case with the route it exercised.
// Removing Brevo has now removed the second. The contact form is still the
// place to test it, because it is still the one outbound send in this service —
// only now it goes over SMTP, and a nodemailer transport error carries the
// connection options, INCLUDING auth.pass, on exactly the same kind of own
// enumerable property. Same shape, same trap, different vendor.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "./harness.js";

const SMTP_PASS = "SECRET-SMTP-PASSWORD-must-not-be-logged";

/**
 * A transport error as nodemailer produces one, with credentials hanging off
 * the error rather than inside the message.
 */
function transportError() {
  const err = new Error("connect ETIMEDOUT smtp.example.com:587");
  err.code = "ETIMEDOUT";
  err.command = "CONN";
  // The trap: printing this object prints the password.
  err.options = {
    host: "smtp.example.com",
    port: 587,
    auth: { user: "bot@example.com", pass: SMTP_PASS },
  };
  return err;
}

describe("transport failures do not leak credentials to logs", () => {
  let app, sendMail, errorSpy;

  beforeEach(() => {
    sendMail = vi.fn();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    ({ app } = createTestApp({ mailer: { sendMail, isConfigured: () => true } }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Everything handed to console.error, rendered the way a log sink would. */
  function loggedOutput() {
    return errorSpy.mock.calls
      .map((args) =>
        args
          .map((a) => {
            if (typeof a === "string") return a;
            try {
              return JSON.stringify(a) ?? String(a);
            } catch {
              return String(a);
            }
          })
          .join(" ")
      )
      .join("\n");
  }

  it("keeps the SMTP password out of the contact-form error log", async () => {
    sendMail.mockRejectedValue(transportError());

    const res = await request(app)
      .post("/api/contact")
      .send({ name: "Ada", email: "ada@example.com", message: "hello" });

    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalled();
    const output = loggedOutput();
    expect(output).toContain("contact form failed");
    expect(output).not.toContain(SMTP_PASS);
  });

  it("keeps it out of the appointments-digest error log too", async () => {
    // The second sender in this service, and it had the same `err.response?.data
    // ?? err.message` shape the contact form did.
    const { app: app2, poolQueryMock } = createTestApp({
      mailer: { sendMail, isConfigured: () => true },
    });
    poolQueryMock.mockImplementation((sql) => {
      if (sql.includes("app_lookup_user_by_email")) return Promise.resolve({ rows: [{ business_id: "b1" }] });
      if (sql.includes("from businesses")) {
        return Promise.resolve({ rows: [{ name: "Clinic", notification_email: "owner@example.com" }] });
      }
      if (sql.includes("from appointments")) return Promise.resolve({ rows: [{ total: 1 }] });
      return Promise.reject(new Error("unexpected query: " + sql));
    });
    sendMail.mockRejectedValue(transportError());

    const res = await request(app2)
      .post("/api/appointments/email")
      .set("Authorization", "Bearer t")
      .send({ range: "today" });

    expect(res.status).toBe(500);
    expect(loggedOutput()).not.toContain(SMTP_PASS);
  });

  it("says nothing at all when the send succeeds", async () => {
    sendMail.mockResolvedValue(undefined);

    const res = await request(app)
      .post("/api/contact")
      .send({ name: "Ada", email: "ada@example.com", message: "hello" });

    expect(res.status).toBe(200);
    expect(loggedOutput()).not.toContain("contact form failed");
  });
});

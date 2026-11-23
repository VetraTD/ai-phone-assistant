// POST /api/auth/password-reset: the reset email, sent by us from
// notifications@vetratd.com instead of by Identity Platform from its own
// noreply@ address.
//
// The rule that shapes everything here: the answer must be the SAME whether or
// not the address has an account. Otherwise the form becomes a way to test
// which staff addresses exist.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { createPasswordResetRouter } = require("../routes/passwordReset.js");

const ORIGIN = "https://app.vetratd.com";

function buildApp({ mint, sendMail, minResponseMs = 0, perEmailMax = 3, dashboardOrigin = ORIGIN } = {}) {
  const minter = { mint: mint || vi.fn(async () => ({ code: "CODE-123" })) };
  const mailer = { sendMail: sendMail || vi.fn(async () => undefined), isConfigured: () => true };
  const app = express();
  app.use(express.json());
  app.use(createPasswordResetRouter({ minter, mailer, dashboardOrigin, minResponseMs, perEmailMax }));
  return { app, minter, mailer };
}

const post = (app, body) => request(app).post("/api/auth/password-reset").send(body);

let logSpies;
beforeEach(() => {
  logSpies = ["log", "info", "warn", "error"].map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => vi.restoreAllMocks());

function everythingLogged() {
  return JSON.stringify(logSpies.flatMap((s) => s.mock.calls));
}

describe("POST /api/auth/password-reset", () => {
  it("emails a VetraTD reset link that opens the dashboard's own reset page", async () => {
    const { app, minter, mailer } = buildApp();
    const res = await post(app, { email: "  Owner@Example.com " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(minter.mint).toHaveBeenCalledWith("owner@example.com");
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    const mail = mailer.sendMail.mock.calls[0][0];
    expect(mail.to).toBe("owner@example.com");
    expect(mail.subject).toBe("Reset your VetraTD password");
    expect(mail.text).toContain("https://app.vetratd.com/reset-password?mode=resetPassword&oobCode=CODE-123");
    expect(mail.text).toContain("VetraTD");
  });

  it("answers an address with no account exactly as it answers one that has an account", async () => {
    const known = buildApp();
    const unknown = buildApp({ mint: vi.fn(async () => ({ skip: true })) });
    const a = await post(known.app, { email: "owner@example.com" });
    const b = await post(unknown.app, { email: "nobody@example.com" });
    expect(b.status).toBe(a.status);
    expect(b.body).toEqual(a.body);
    expect(unknown.mailer.sendMail).not.toHaveBeenCalled();
  });

  it("a failed send for a real account still answers the same, and is logged without the address", async () => {
    // nodemailer appends the server's reply to the message, and an SMTP
    // recipient rejection quotes the address: only the code may be logged.
    const { app } = buildApp({
      sendMail: vi.fn(async () => {
        const err = new Error("Can't send mail: 550 5.1.1 <owner@example.com>: Recipient address rejected");
        err.code = "EENVELOPE";
        throw err;
      }),
    });
    const res = await post(app, { email: "owner@example.com" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(everythingLogged()).toContain("password_reset_send_failed");
    expect(everythingLogged()).not.toContain("owner@example.com");
  });

  it("a failure that is the same for every address (Identity Platform down) answers 503", async () => {
    const { app } = buildApp({
      mint: vi.fn(async () => {
        throw new Error("idp_refused");
      }),
    });
    const res = await post(app, { email: "owner@example.com" });
    expect(res.status).toBe(503);
    expect(everythingLogged()).toContain("idp_refused");
    expect(everythingLogged()).not.toContain("owner@example.com");
  });

  it("an unexpected Identity Platform refusal answers the same, and is logged as an error with its code", async () => {
    const { app, mailer } = buildApp({
      mint: vi.fn(async () => ({ skip: true, reason: "unexpected", refusal: "OPERATION_NOT_ALLOWED" })),
    });
    const res = await post(app, { email: "owner@example.com" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mailer.sendMail).not.toHaveBeenCalled();
    const errors = JSON.stringify(logSpies[3].mock.calls);
    expect(errors).toContain("password_reset_unexpected");
    expect(errors).toContain("OPERATION_NOT_ALLOWED");
  });

  it("no link on a 200 is routine: Identity Platform's email-enumeration protection answers unknown addresses that way", async () => {
    // Measured on prod 2026-11-23: enableImprovedEmailPrivacy is on, and an
    // unknown address gets 200 with no oobLink rather than EMAIL_NOT_FOUND.
    const { app } = buildApp({ mint: vi.fn(async () => ({ skip: true, reason: "no_link", refusal: null })) });
    const res = await post(app, { email: "nobody@example.com" });
    expect(res.status).toBe(200);
    expect(JSON.stringify(logSpies[1].mock.calls)).toContain("no_link");
    expect(logSpies[3]).not.toHaveBeenCalled();
  });

  it("a routine skip (no account) is logged with its reason, not as an error", async () => {
    const { app } = buildApp({ mint: vi.fn(async () => ({ skip: true, reason: "EMAIL_NOT_FOUND" })) });
    await post(app, { email: "nobody@example.com" });
    expect(JSON.stringify(logSpies[1].mock.calls)).toContain("EMAIL_NOT_FOUND");
    expect(logSpies[3]).not.toHaveBeenCalled();
  });

  it("answers at the minimum time even when the send is slower, so speed cannot reveal an account", async () => {
    let finished = false;
    const sendMail = vi.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            finished = true;
            resolve();
          }, 400)
        )
    );
    const { app } = buildApp({ sendMail, minResponseMs: 120 });
    const started = Date.now();
    const res = await post(app, { email: "owner@example.com" });
    const took = Date.now() - started;
    expect(res.status).toBe(200);
    expect(took).toBeGreaterThanOrEqual(110);
    expect(took).toBeLessThan(350);
    expect(finished).toBe(false);
    // The send still completes and logs on its own.
    await new Promise((r) => setTimeout(r, 400));
    expect(finished).toBe(true);
    expect(everythingLogged()).toContain("password_reset_sent");
  });

  it("never logs the address or the code", async () => {
    const { app } = buildApp();
    await post(app, { email: "owner@example.com" });
    expect(everythingLogged()).not.toContain("owner@example.com");
    expect(everythingLogged()).not.toContain("CODE-123");
  });

  it.each([
    ["missing", {}],
    ["malformed", { email: "not-an-email" }],
    ["not a string", { email: ["a@example.com"] }],
  ])("refuses a %s email with 400", async (_label, body) => {
    const { app, minter } = buildApp();
    const res = await post(app, body);
    expect(res.status).toBe(400);
    expect(minter.mint).not.toHaveBeenCalled();
  });

  it("refuses extra fields, so a caller cannot choose where the link points", async () => {
    const { app, minter } = buildApp();
    const res = await post(app, { email: "owner@example.com", continueUrl: "https://evil.example" });
    expect(res.status).toBe(400);
    expect(minter.mint).not.toHaveBeenCalled();
  });

  it("stops sending to one address after the per-address limit, while answering the same", async () => {
    const { app, mailer } = buildApp({ perEmailMax: 2 });
    for (let i = 0; i < 4; i += 1) {
      const res = await post(app, { email: "owner@example.com" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
    }
    expect(mailer.sendMail).toHaveBeenCalledTimes(2);
  });

  it("takes at least the minimum response time, so a send cannot be told apart by speed", async () => {
    const { app } = buildApp({ mint: vi.fn(async () => ({ skip: true })), minResponseMs: 120 });
    const started = Date.now();
    await post(app, { email: "nobody@example.com" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
  });

  it("answers 503 when the dashboard address is not configured, rather than mailing a broken link", async () => {
    const { app, minter } = buildApp({ dashboardOrigin: "" });
    const res = await post(app, { email: "owner@example.com" });
    expect(res.status).toBe(503);
    expect(minter.mint).not.toHaveBeenCalled();
  });
});

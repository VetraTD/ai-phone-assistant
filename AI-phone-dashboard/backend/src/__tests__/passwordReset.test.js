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
    const { app } = buildApp({
      sendMail: vi.fn(async () => {
        const err = new Error("graph_refused");
        err.code = "MAIL_SEND_FAILED";
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

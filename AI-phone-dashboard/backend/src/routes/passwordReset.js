const express = require("express");
const crypto = require("crypto");
const { sanitizeString, isValidEmail, rejectUnexpectedKeys } = require("../utils");

// ---------------------------------------------------------------------------
// POST /api/auth/password-reset   { email }
//
// The reset email, sent by the dashboard from notifications@vetratd.com rather
// than by Identity Platform from noreply@<project>.firebaseapp.com.
//
// ONE ANSWER FOR EVERY ADDRESS. Whether or not the address has an account, the
// caller gets 200 { success: true } after at least `minResponseMs`. Anything
// that differs only for real accounts (a failed send, the per-address limit) is
// logged and answered the same. Only failures that are identical for every
// address (Identity Platform or its credentials down, not configured) answer
// 503, because they say nothing about anyone.
//
// The link is built here from the configured dashboard origin, never from the
// request: the body accepts `email` and nothing else, so nobody can choose
// where a reset link points.
//
// Logs carry closed reasons only — never the address or the code.
// ---------------------------------------------------------------------------

const ONE_HOUR_MS = 60 * 60 * 1000;
const MAX_TRACKED_ADDRESSES = 10_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resetEmailText(link) {
  return [
    "Hello,",
    "",
    "We received a request to reset the password for your VetraTD account.",
    "",
    "Choose a new password here. The link works once and expires in about an hour:",
    link,
    "",
    "If you didn't ask for this, you can ignore this email. Your password won't change.",
    "",
    "VetraTD",
  ].join("\n");
}

/**
 * Per-address send counter, in memory, one window per address. Keyed by a hash
 * so the process never holds a list of addresses. Per instance: Identity
 * Platform's own quotas and the per-IP limiter in server.js sit behind it.
 */
function createAddressLimiter({ max, windowMs }) {
  const seen = new Map();
  return function allow(email) {
    const now = Date.now();
    const key = crypto.createHash("sha256").update(email).digest("hex");
    let entry = seen.get(key);
    if (!entry || now - entry.start >= windowMs) {
      if (seen.size >= MAX_TRACKED_ADDRESSES) {
        for (const [k, v] of seen) if (now - v.start >= windowMs) seen.delete(k);
        if (seen.size >= MAX_TRACKED_ADDRESSES) seen.delete(seen.keys().next().value);
      }
      entry = { start: now, count: 0 };
      seen.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= max;
  };
}

/**
 * @param {{
 *   minter: { mint: (email: string) => Promise<{ code: string } | { skip: true }> } | null,
 *   mailer: { sendMail: Function, isConfigured: () => boolean },
 *   dashboardOrigin: string,
 *   minResponseMs?: number,
 *   perEmailMax?: number,
 *   limiters?: Function[],
 * }} deps
 */
function createPasswordResetRouter({
  minter,
  mailer,
  dashboardOrigin,
  minResponseMs = 2_000,
  perEmailMax = 3,
  limiters = [],
}) {
  const router = express.Router();
  const allowAddress = createAddressLimiter({ max: perEmailMax, windowMs: ONE_HOUR_MS });

  router.post("/api/auth/password-reset", ...limiters, async (req, res) => {
    const started = Date.now();
    const answer = async (status, body) => {
      const wait = minResponseMs - (Date.now() - started);
      if (wait > 0) await sleep(wait);
      res.status(status).json(body);
    };

    try {
      rejectUnexpectedKeys(req.body || {}, ["email"]);
    } catch {
      return res.status(400).json({ error: "Unexpected fields in request body." });
    }
    const raw = req.body?.email;
    if (typeof raw !== "string" || !isValidEmail(raw)) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }
    if (!minter || !dashboardOrigin || !mailer?.isConfigured?.()) {
      console.error("password_reset_failed", { reason: "not_configured" });
      return res.status(503).json({ error: "Password reset is not available right now. Please try again later." });
    }
    const email = sanitizeString(raw, 254).toLowerCase();

    if (!allowAddress(email)) {
      console.warn("password_reset_skipped", { reason: "address_limit" });
      return answer(200, { success: true });
    }

    let minted;
    try {
      minted = await minter.mint(email);
    } catch (err) {
      console.error("password_reset_failed", { reason: String(err?.message || "idp_error") });
      return answer(503, { error: "Password reset is not available right now. Please try again later." });
    }
    if (!minted?.code) return answer(200, { success: true });

    const link = `${dashboardOrigin}/reset-password?mode=resetPassword&oobCode=${encodeURIComponent(minted.code)}`;
    try {
      await mailer.sendMail({
        to: email,
        subject: "Reset your VetraTD password",
        text: resetEmailText(link),
        fromName: "VetraTD",
      });
      console.info("password_reset_sent");
    } catch (err) {
      // Same answer as a success: a failure only real accounts can hit must not
      // become the way to find them. The log is how an operator finds it.
      console.error("password_reset_send_failed", { reason: String(err?.message || "send_error") });
    }
    return answer(200, { success: true });
  });

  return router;
}

module.exports = { createPasswordResetRouter };

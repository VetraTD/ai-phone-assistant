const express = require("express");
const router = express.Router();
const axios = require("axios");
const crypto = require("crypto");

const authenticate = require("../middleware/authMiddleware");
const pool = require("../db");
const { getBusinessIdForUser } = require("../utils");
const { authSensitiveLimiter } = require("../middleware/rateLimiters");

// ─── Google Calendar OAuth & sync ───────────────────────────────────────────
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const OAUTH_PROVIDER = "google";

/**
 * Atomically redeem an OAuth `state` nonce and return the business it was
 * issued for, or null if it is unknown, already redeemed or expired.
 *
 * The single UPDATE is the whole point: `consumed_at IS NULL` in the WHERE
 * clause makes redemption a compare-and-set, so two concurrent callbacks
 * carrying the same state cannot both come back with a business id. Zero rows
 * returned means forged, replayed or stale — all rejected identically, and
 * the caller must not fall back to anything from the request.
 */
async function consumeOAuthState(state) {
  if (typeof state !== "string" || !state) return null;
  const r = await pool.query(
    `UPDATE oauth_states SET consumed_at = now()
      WHERE state = $1 AND provider = $2 AND consumed_at IS NULL
        AND created_at > now() - interval '10 minutes'
      RETURNING business_id`,
    [state, OAUTH_PROVIDER]
  );
  return r.rows[0]?.business_id || null;
}

function getCalendarRedirectUri() {
  let base = process.env.API_BASE_URL;
  if (!base && process.env.VERCEL_URL) base = `https://${process.env.VERCEL_URL}`;
  if (!base) base = "http://localhost:5000";
  return `${base.replace(/\/$/, "")}/api/calendar/callback`;
}

// GET /api/calendar/auth-url — returns Google OAuth URL (authenticated)
router.get("/api/calendar/auth-url", authenticate, async (req, res) => {
  try {
    const businessId = await getBusinessIdForUser(req.authUser.id);
    if (!businessId) {
      return res.status(403).json({ error: "No business linked to this user" });
    }
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = getCalendarRedirectUri();
    if (!clientId || !redirectUri) {
      return res.status(503).json({ error: "Calendar integration is not configured" });
    }
    // `state` is an opaque single-use nonce, NOT an identity carrier: the
    // callback below is unauthenticated, so anything encoded here would be
    // attacker-forgeable. The business it was issued for lives server-side.
    const state = crypto.randomBytes(32).toString("base64url");
    await pool.query(
      `INSERT INTO oauth_states (state, business_id, user_id, provider) VALUES ($1, $2, $3, $4)`,
      [state, businessId, req.authUser.id, OAUTH_PROVIDER]
    );
    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", GOOGLE_CALENDAR_SCOPE);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    res.json({ url: url.toString() });
  } catch (err) {
    console.error("calendar auth-url error:", err);
    res.status(500).json({ error: "Failed to build calendar auth URL" });
  }
});

// GET /api/calendar/callback — Google redirects here (no auth)
router.get("/api/calendar/callback", async (req, res) => {
  const frontendRedirect = process.env.CALENDAR_FRONTEND_REDIRECT || "https://www.vetratd.com/app";
  try {
    const { code, state, error } = req.query;
    if (error) {
      return res.redirect(`${frontendRedirect}?calendar=error&message=${encodeURIComponent(error)}`);
    }
    if (!code || !state) {
      return res.redirect(`${frontendRedirect}?calendar=error&message=missing_code_or_state`);
    }
    // Identity comes from the server-side nonce record only — never from the
    // request. Redeem before exchanging the code so a forged/replayed state
    // costs nothing.
    const businessId = await consumeOAuthState(state);
    if (!businessId) {
      return res.redirect(`${frontendRedirect}?calendar=error&message=invalid_state`);
    }
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = getCalendarRedirectUri();
    if (!clientId || !clientSecret || !redirectUri) {
      return res.redirect(`${frontendRedirect}?calendar=error&message=server_not_configured`);
    }
    const tokenRes = await axios.post(
      GOOGLE_TOKEN_URL,
      new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    const { access_token, refresh_token, expires_in } = tokenRes.data;
    const expiresAt = expires_in
      ? new Date(Date.now() + expires_in * 1000).toISOString()
      : null;
    await pool.query(
      `INSERT INTO calendar_connections (business_id, provider, access_token, refresh_token, expires_at, updated_at)
       VALUES ($1, 'google', $2, $3, $4, now())
       ON CONFLICT (business_id, provider)
       DO UPDATE SET access_token = EXCLUDED.access_token, refresh_token = COALESCE(EXCLUDED.refresh_token, calendar_connections.refresh_token),
                     expires_at = EXCLUDED.expires_at, updated_at = now()`,
      [businessId, access_token, refresh_token || null, expiresAt]
    );
    res.redirect(`${frontendRedirect}?calendar=connected`);
  } catch (err) {
    console.error("calendar callback error:", err?.response?.data ?? err?.message);
    res.redirect(`${frontendRedirect}?calendar=error&message=${encodeURIComponent(err?.message || "callback_failed")}`);
  }
});

// GET /api/calendar/status — is calendar connected? (authenticated)
router.get("/api/calendar/status", authenticate, async (req, res) => {
  try {
    const businessId = await getBusinessIdForUser(req.authUser.id);
    if (!businessId) {
      return res.status(403).json({ error: "No business linked to this user" });
    }
    const r = await pool.query(
      `SELECT 1 FROM calendar_connections WHERE business_id = $1 AND provider = 'google' AND enabled = true AND refresh_token IS NOT NULL`,
      [businessId]
    );
    res.json({ connected: r.rows.length > 0 });
  } catch (err) {
    console.error("calendar status error:", err);
    res.status(500).json({ error: "Failed to get calendar status" });
  }
});

// Refresh Google access token if expired
async function getValidCalendarTokens(businessId) {
  const r = await pool.query(
    `SELECT access_token, refresh_token, expires_at FROM calendar_connections WHERE business_id = $1 AND provider = 'google' AND enabled = true`,
    [businessId]
  );
  const row = r.rows[0];
  if (!row || !row.refresh_token) return null;
  let { access_token, refresh_token, expires_at } = row;
  const expiresAt = expires_at ? new Date(expires_at).getTime() : 0;
  if (Date.now() >= expiresAt - 60 * 1000) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    const tokenRes = await axios.post(
      GOOGLE_TOKEN_URL,
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token,
        grant_type: "refresh_token",
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    access_token = tokenRes.data.access_token;
    const newExpires = tokenRes.data.expires_in
      ? new Date(Date.now() + tokenRes.data.expires_in * 1000).toISOString()
      : null;
    await pool.query(
      `UPDATE calendar_connections SET access_token = $1, expires_at = $2, updated_at = now() WHERE business_id = $3 AND provider = 'google'`,
      [access_token, newExpires, businessId]
    );
  }
  return access_token;
}

// POST /api/calendar/sync — create Google Calendar events for upcoming appointments (authenticated)
router.post("/api/calendar/sync", authSensitiveLimiter, authenticate, async (req, res) => {
  try {
    const businessId = await getBusinessIdForUser(req.authUser.id);
    if (!businessId) {
      return res.status(403).json({ error: "No business linked to this user" });
    }
    const accessToken = await getValidCalendarTokens(businessId);
    if (!accessToken) {
      return res.status(400).json({ error: "Google Calendar is not connected. Connect it in Settings first." });
    }
    const bizRes = await pool.query(
      `SELECT timezone FROM businesses WHERE id = $1 LIMIT 1`,
      [businessId]
    );
    const businessTimezone = bizRes.rows[0]?.timezone || "UTC";
    const apptsRes = await pool.query(
      `SELECT id, client_name, client_phone, scheduled_at, status, notes, call_id
       FROM appointments WHERE business_id = $1 AND scheduled_at >= now() ORDER BY scheduled_at ASC LIMIT 100`,
      [businessId]
    );
    const appts = apptsRes.rows;
    const calendarId = "primary";
    let created = 0;
    for (const a of appts) {
      const start = new Date(a.scheduled_at);
      const end = new Date(start.getTime() + 30 * 60 * 1000); // 30 min default
      const summary = a.client_name ? `Vetra: ${a.client_name}` : "Vetra appointment";
      const description = [
        a.client_phone ? `Phone: ${a.client_phone}` : "",
        a.notes ? `Notes: ${a.notes}` : "",
        a.call_id ? `Call ID: ${a.call_id}` : "",
      ].filter(Boolean).join("\n");
      try {
        await axios.post(
          `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
          {
            summary,
            description: description || undefined,
            start: { dateTime: start.toISOString(), timeZone: businessTimezone },
            end: { dateTime: end.toISOString(), timeZone: businessTimezone },
          },
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        created++;
      } catch (eventErr) {
        if (eventErr.response?.status === 409) continue; // already exists / duplicate
        console.error("calendar create event error:", eventErr.response?.data || eventErr.message);
      }
    }
    res.json({ success: true, created, total: appts.length });
  } catch (err) {
    console.error("calendar sync error:", err?.response?.data ?? err?.message);
    res.status(500).json({ error: err?.response?.data?.error?.message || "Failed to sync to calendar" });
  }
});

// DELETE /api/calendar/disconnect — remove calendar connection (authenticated)
router.delete("/api/calendar/disconnect", authSensitiveLimiter, authenticate, async (req, res) => {
  try {
    const businessId = await getBusinessIdForUser(req.authUser.id);
    if (!businessId) {
      return res.status(403).json({ error: "No business linked to this user" });
    }
    await pool.query(
      `DELETE FROM calendar_connections WHERE business_id = $1 AND provider = 'google'`,
      [businessId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("calendar disconnect error:", err);
    res.status(500).json({ error: "Failed to disconnect calendar" });
  }
});

module.exports = router;

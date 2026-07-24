/**
 * Google Calendar sync — the shared engine behind both the manual "Sync now"
 * button (routes/calendar.js) and the background worker started in server.js.
 *
 * Design goals:
 *  - Idempotent. Only appointments with google_event_id IS NULL are pushed, and
 *    the created event id is stored, so an appointment is never sent twice.
 *    (The old inline route re-POSTed every upcoming appointment on every call,
 *    creating duplicate events — Google does not dedupe by content.)
 *  - Injectable. Every external dependency (pool, axios, clock) is a parameter
 *    with a real default, so the unit test can drive it with fakes — no live
 *    Postgres, no live Google.
 *  - Migration-portable. `syncPendingAppointments` is a plain async function;
 *    server.js triggers it on a timer today, and a Cloud Scheduler HTTP hit can
 *    trigger the same function after the GCP move.
 */

const realAxios = require("axios");
const realPool = require("../db");

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const EVENT_DEFAULT_MINUTES = 30;

/** Signals the appointments table hasn't had migration 021 applied yet. */
function isMissingSyncColumns(err) {
  const msg = String(err?.message || "");
  return /google_event_id|synced_at/.test(msg) && /column|does not exist/i.test(msg);
}

/**
 * A valid access token for a business's Google connection, refreshing it when
 * expired. Returns null when the business isn't connected or the server lacks
 * Google OAuth credentials — callers treat null as "skip this business".
 */
async function getValidAccessToken(businessId, { pool = realPool, axios = realAxios, now = Date.now } = {}) {
  const r = await pool.query(
    `SELECT access_token, refresh_token, expires_at
       FROM calendar_connections
      WHERE business_id = $1 AND provider = 'google' AND enabled = true`,
    [businessId]
  );
  const row = r.rows[0];
  if (!row || !row.refresh_token) return null;

  let accessToken = row.access_token;
  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (now() >= expiresAt - 60 * 1000) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    const tokenRes = await axios.post(
      GOOGLE_TOKEN_URL,
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: row.refresh_token,
        grant_type: "refresh_token",
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    accessToken = tokenRes.data.access_token;
    const newExpires = tokenRes.data.expires_in
      ? new Date(now() + tokenRes.data.expires_in * 1000).toISOString()
      : null;
    await pool.query(
      `UPDATE calendar_connections SET access_token = $1, expires_at = $2, updated_at = now()
        WHERE business_id = $3 AND provider = 'google'`,
      [accessToken, newExpires, businessId]
    );
  }
  return accessToken;
}

/** Create one calendar event for an appointment; returns the Google event id. */
async function createCalendarEvent(accessToken, appt, timezone, { axios = realAxios } = {}) {
  const start = new Date(appt.scheduled_at);
  const end = new Date(start.getTime() + EVENT_DEFAULT_MINUTES * 60 * 1000);
  const description = [
    appt.client_phone ? `Phone: ${appt.client_phone}` : "",
    appt.notes ? `Notes: ${appt.notes}` : "",
    appt.call_id ? `Call ID: ${appt.call_id}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const res = await axios.post(
    `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent("primary")}/events`,
    {
      summary: appt.client_name ? `Vetra: ${appt.client_name}` : "Vetra appointment",
      description: description || undefined,
      start: { dateTime: start.toISOString(), timeZone: timezone },
      end: { dateTime: end.toISOString(), timeZone: timezone },
    },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return res.data?.id || null;
}

/**
 * Push this business's not-yet-synced upcoming appointments, recording each
 * event id so it is never sent again. Returns the number of events created.
 * Assumes the business is connected — callers resolve the token first.
 */
async function syncAppointmentsForBusiness(businessId, deps = {}) {
  const { pool = realPool, now = Date.now } = deps;
  const accessToken = await getValidAccessToken(businessId, deps);
  if (!accessToken) return { created: 0, connected: false };

  const bizRes = await pool.query(`SELECT timezone FROM businesses WHERE id = $1 LIMIT 1`, [businessId]);
  const timezone = bizRes.rows[0]?.timezone || "UTC";

  const nowIso = new Date(now()).toISOString();
  const apptsRes = await pool.query(
    `SELECT id, client_name, client_phone, scheduled_at, notes, call_id
       FROM appointments
      WHERE business_id = $1 AND google_event_id IS NULL AND scheduled_at >= $2
      ORDER BY scheduled_at ASC
      LIMIT 100`,
    [businessId, nowIso]
  );

  let created = 0;
  for (const appt of apptsRes.rows) {
    const eventId = await createCalendarEvent(accessToken, appt, timezone, deps);
    if (!eventId) continue;
    await pool.query(
      `UPDATE appointments SET google_event_id = $1, synced_at = now() WHERE id = $2`,
      [eventId, appt.id]
    );
    created++;
  }
  return { created, connected: true };
}

/**
 * The background worker's unit of work: sync every business that has an enabled
 * Google connection. Resilient by design — one business's failure (an expired
 * grant, a Google outage) is logged and skipped, never aborting the rest — and
 * it self-reports a missing-migration state instead of crashing the server.
 */
async function syncPendingAppointments(deps = {}) {
  const { pool = realPool, log = console } = deps;
  const connRes = await pool.query(
    `SELECT DISTINCT business_id FROM calendar_connections
      WHERE provider = 'google' AND enabled = true AND refresh_token IS NOT NULL`
  );

  let created = 0;
  let businesses = 0;
  for (const { business_id: businessId } of connRes.rows) {
    try {
      const res = await syncAppointmentsForBusiness(businessId, deps);
      created += res.created;
      if (res.connected) businesses++;
    } catch (err) {
      if (isMissingSyncColumns(err)) throw err; // surfaced to the caller to self-disable
      log.error?.(`calendarSync: business ${businessId} failed: ${err.message}`);
    }
  }
  return { created, businesses };
}

module.exports = {
  getValidAccessToken,
  createCalendarEvent,
  syncAppointmentsForBusiness,
  syncPendingAppointments,
  isMissingSyncColumns,
  GOOGLE_TOKEN_URL,
  GOOGLE_CALENDAR_API,
};

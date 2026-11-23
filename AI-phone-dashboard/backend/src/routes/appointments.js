const express = require("express");
const router = express.Router();
const axios = require("axios");

const authenticate = require("../middleware/authMiddleware");
const pool = require("../db");
const { rejectUnexpectedKeys } = require("../utils");
const { withTenantHandler } = require("../middleware/withTenantHandler");
const { authSensitiveLimiter, sensitiveLimiter } = require("../middleware/rateLimiters");
const mailer = require("../services/mailer");
const { DEFAULT_TIMEZONE, loadBusinessTimezone } = require("../callDateBounds");

const RANGE_ERROR = "Choose a date range of up to six weeks.";
const MAX_RANGE_DAYS = 42;

// A real calendar day as "YYYY-MM-DD", or NaN. "2026-02-30" is not one.
function dayNumber(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return NaN;
  const [y, m, d] = s.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return NaN;
  return t / 86400000;
}

// The scheduled_at bounds, in the BUSINESS's days, for both routes. Returns
// { sql, params } with params numbered from $2 ($1 is the business id), or null
// when the input cannot be served. Each day is turned into a local midnight and
// then an instant with AT TIME ZONE, so a booking at 23:30 in Chicago stays on
// its own day and a 23- or 25-hour clock-change day still ends at midnight.
// The functions sit on the bound, never on scheduled_at.
//   from + to: inclusive days, at most six weeks. Both or neither.
//   range:     today (default) | 7days (today and the next seven) | upcoming.
function dayBounds({ from, to, range, tz }) {
  const today = `(now() AT TIME ZONE $2)::date`;
  const at = (day) => `(${day}::timestamp AT TIME ZONE $2)`;
  if (from !== undefined || to !== undefined) {
    const a = dayNumber(from);
    const b = dayNumber(to);
    if (Number.isNaN(a) || Number.isNaN(b) || a > b || b - a + 1 > MAX_RANGE_DAYS) return null;
    return {
      sql: `and a.scheduled_at >= ${at("$3::date")} and a.scheduled_at < ${at("($4::date + 1)")}`,
      params: [tz, from, to],
    };
  }
  if (range === "upcoming") return { sql: `and a.scheduled_at >= ${at(today)}`, params: [tz] };
  const days = range === "7days" ? 8 : 1;
  return {
    sql: `and a.scheduled_at >= ${at(today)} and a.scheduled_at < ${at(`(${today} + ${days})`)}`,
    params: [tz],
  };
}

// Appointments for the authenticated user's business, in its own days.
// GET /api/appointments?from=YYYY-MM-DD&to=YYYY-MM-DD   (the Calendar)
// GET /api/appointments?range=today|7days|upcoming      (older callers)
router.get("/api/appointments", authenticate, withTenantHandler(async (req, res) => {
  try {
    const businessId = req.businessId;
    const { from, to, range } = req.query;
    const tz = await loadBusinessTimezone((sql, p) => pool.query(sql, p), businessId);
    const bounds = dayBounds({ from, to, range, tz });
    if (!bounds) return res.status(400).json({ error: RANGE_ERROR });

    const r = await pool.query(
      `select a.id,
              a.call_id,
              a.client_name,
              a.client_phone,
              a.scheduled_at,
              a.status,
              a.notes,
              bc.started_at as booked_on,
              lc.last_change
       from appointments a
       -- The call that booked it (a move keeps this call), and the newest
       -- change a call made to it (migration 062), both kept to this business.
       left join calls bc on bc.id = a.call_id and bc.business_id = $1
       left join lateral (
         select json_build_object('kind', ch.kind, 'call_id', ch.call_id, 'created_at', ch.created_at) as last_change
           from appointment_changes ch
          where ch.appointment_id = a.id and ch.business_id = $1
          order by ch.created_at desc, ch.id desc
          limit 1
       ) lc on true
       where a.business_id = $1
         ${bounds.sql}
       order by a.scheduled_at asc`,
      [businessId, ...bounds.params]
    );

    res.json(r.rows);
  } catch (err) {
    console.error("appointments-today failed:", err);
    res.status(500).json({ error: "Failed to load today's appointments" });
  }
}));

// Send appointments summary email to the business notification email
// POST /api/appointments/email  { range: "today" | "7days" | "upcoming" }
router.post("/api/appointments/email", authSensitiveLimiter, sensitiveLimiter, authenticate, withTenantHandler(async (req, res) => {
  try {
    if (!mailer.isConfigured()) {
      return res
        .status(500)
        .json({ error: "Email sending is not configured on the server." });
    }
    const businessId = req.businessId;

    const bizRes = await pool.query(
      `select name, notification_email, timezone from businesses where id = $1`,
      [businessId]
    );
    const biz = bizRes.rows[0];
    if (!biz || !biz.notification_email) {
      return res
        .status(400)
        .json({ error: "Notification email is not set for this business." });
    }

    const allowedKeys = ["range"];
    rejectUnexpectedKeys(req.body || {}, allowedKeys);
    const rawRange = req.body?.range;
    const range = rawRange === "7days" || rawRange === "upcoming" ? rawRange : "today";
    const label = range === "7days" ? "Next 7 days" : range === "upcoming" ? "Upcoming" : "Today";
    const bounds = dayBounds({ range, tz: biz.timezone || DEFAULT_TIMEZONE });

    // COUNT only. The previous version selected client_name, client_phone,
    // scheduled_at, status and notes and printed one line per appointment into
    // an email — for a cardiology clinic, a list of who is being seen and when,
    // through a transactional email vendor with no BAA, triggered by a button.
    //
    // Not selecting the columns is the point. Selecting them and then declining
    // to print them leaves the payload one careless template literal away from
    // leaking again; a query that never fetches a name cannot send one.
    //
    // Scoped by the booking's own business (a booking need not have a call),
    // and a cancelled booking is not one that is scheduled.
    const apptsRes = await pool.query(
      `select count(*)::int as total
       from appointments a
       where a.business_id = $1
         and a.status is distinct from 'cancelled'
         ${bounds.sql}`,
      [businessId, ...bounds.params]
    );
    const count = apptsRes.rows[0]?.total ?? 0;

    const businessName = biz.name || "your business";
    const where = process.env.DASHBOARD_URL
      ? `Open your Vetra dashboard to see them:\n${process.env.DASHBOARD_URL}`
      : "Open your Vetra dashboard to see them.";
    const text =
      count === 0
        ? `${businessName}\n\nNo appointments are scheduled for ${label.toLowerCase()}.\n\n${where}`
        : `${businessName}\n\n${count} appointment${count === 1 ? " is" : "s are"} scheduled ` +
          `(${label.toLowerCase()}).\n\n${where}\n\n` +
          "This email contains no patient information by design — email is not a " +
          "private channel, so the details stay in Vetra.";

    await mailer.sendMail({
      to: biz.notification_email,
      // The subject names the business and "appointments", which is as far
      // as a subject line can go without describing anyone's care.
      subject: `${label} appointments - ${businessName}`,
      text,
      fromName: businessName,
    });

    res.json({ success: true, count });
  } catch (err) {
    // Message only: a transport error carries auth.pass on its own properties.
    console.error("appointments-email failed:", err?.message);
    res.status(500).json({ error: "Failed to send appointments email" });
  }
}));

module.exports = router;

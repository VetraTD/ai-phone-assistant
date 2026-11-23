const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const pool = require("../db");
const { withTenantHandler } = require("../middleware/withTenantHandler");
const { loadBusinessTimezone } = require("../callDateBounds");

// Day and week bounds in the BUSINESS's timezone ($2), never the database's or
// the viewer's: a call at 23:59 local time yesterday is not "today" (spec §8,
// Review Focus 1). The day's end is computed in local time and then converted,
// so a 23- or 25-hour daylight-saving day still ends at local midnight.
const DAY_START = `(date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)`;
const DAY_END = `((date_trunc('day', now() AT TIME ZONE $2) + interval '1 day') AT TIME ZONE $2)`;
// date_trunc('week', …) starts on Monday.
const WEEK_START = `(date_trunc('week', now() AT TIME ZONE $2) AT TIME ZONE $2)`;

// The latest request left on a call, and the latest booking's name, both kept
// to this business explicitly as well as by row-level security.
const LATEST_REQUEST = `LATERAL (
    SELECT cr.request_type, cr.caller_name, cr.callback_number, cr.preferred_time, cr.message, cr.notes, cr.created_at
      FROM customer_requests cr
     WHERE cr.call_id = c.id AND cr.business_id = $1
     ORDER BY cr.created_at DESC
     LIMIT 1) r`;
const LATEST_BOOKING_NAME = `LATERAL (
    SELECT ap.client_name
      FROM appointments ap
     WHERE ap.call_id = c.id AND ap.business_id = $1
     ORDER BY ap.created_at DESC
     LIMIT 1) a`;

// Open: a request nobody has marked done, or one that arrived after Done
// (the post-call check's follow-up is written at call end). Driven from the
// business's requests, which are far fewer than its calls.
const OPEN_ITEMS = `
  SELECT c.id AS call_id, c.started_at, c.caller_number, c.summary,
         COALESCE(r.caller_name, a.client_name) AS caller_name,
         r.request_type, r.caller_name AS request_caller_name, r.callback_number, r.preferred_time, r.message, r.notes
    FROM calls c
    JOIN ${LATEST_REQUEST} ON true
    LEFT JOIN ${LATEST_BOOKING_NAME} ON true
   WHERE c.business_id = $1
     AND c.id IN (SELECT cr.call_id FROM customer_requests cr WHERE cr.business_id = $1 AND cr.call_id IS NOT NULL)
     AND (c.handled_at IS NULL OR r.created_at > c.handled_at)
   ORDER BY c.started_at ASC
   LIMIT 200`;

// Done today: finished calls today that left nothing to do, and items a person
// marked done today (and that no later request has opened again). Items closed
// by the launch backfill are not news, and a call still in progress is not done.
// The first condition narrows to today's calls before any per-call join.
const DONE_TODAY = `
  SELECT c.id AS call_id, c.started_at, c.caller_number, c.summary, c.status, c.handled_at, c.handled_by,
         (r.request_type IS NOT NULL) AS had_request,
         COALESCE(r.caller_name, a.client_name) AS caller_name
    FROM calls c
    LEFT JOIN ${LATEST_REQUEST} ON true
    LEFT JOIN ${LATEST_BOOKING_NAME} ON true
   WHERE c.business_id = $1
     AND (c.started_at >= ${DAY_START} OR c.handled_at >= ${DAY_START})
     AND c.status <> 'in-progress'
     AND (
          (r.request_type IS NULL AND c.started_at >= ${DAY_START} AND c.started_at < ${DAY_END})
       OR (c.handled_at >= ${DAY_START} AND c.handled_at < ${DAY_END} AND c.handled_by <> 'launch'
           AND r.created_at <= c.handled_at)
     )
   ORDER BY GREATEST(c.started_at, COALESCE(c.handled_at, c.started_at)) DESC
   LIMIT 200`;

// Bookings MADE count appointments created on a call in the window. A move keeps
// the booking call's id, so it is never counted as a new booking.
const COUNTS = `
  SELECT
    (SELECT count(*)::int FROM calls c
      WHERE c.business_id = $1 AND c.direction = 'inbound'
        AND c.started_at >= ${DAY_START} AND c.started_at < ${DAY_END}) AS answered,
    (SELECT count(*)::int FROM appointments ap JOIN calls c ON c.id = ap.call_id
      WHERE ap.business_id = $1 AND c.business_id = $1
        AND c.started_at >= ${DAY_START} AND c.started_at < ${DAY_END}) AS bookings_made,
    (SELECT count(*)::int FROM calls c
      WHERE c.business_id = $1 AND c.direction = 'inbound'
        AND c.started_at >= ${WEEK_START} AND c.started_at <= now()) AS week_calls,
    (SELECT count(*)::int FROM appointments ap JOIN calls c ON c.id = ap.call_id
      WHERE ap.business_id = $1 AND c.business_id = $1
        AND c.started_at >= ${WEEK_START} AND c.started_at <= now()) AS week_bookings_made,
    (SELECT count(*)::int FROM appointment_changes ch
      WHERE ch.business_id = $1 AND ch.kind = 'moved'
        AND ch.created_at >= ${WEEK_START} AND ch.created_at <= now()) AS week_bookings_moved,
    (SELECT count(*)::int FROM appointment_changes ch
      WHERE ch.business_id = $1 AND ch.kind = 'cancelled'
        AND ch.created_at >= ${WEEK_START} AND ch.created_at <= now()) AS week_bookings_cancelled`;

const TODAYS_BOOKINGS = `
  SELECT ap.id, ap.scheduled_at, ap.client_name, ap.status, ap.call_id
    FROM appointments ap
   WHERE ap.business_id = $1
     AND ap.scheduled_at >= ${DAY_START} AND ap.scheduled_at < ${DAY_END}
   ORDER BY ap.scheduled_at ASC
   LIMIT 200`;

const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);

// GET /api/home: what needs the owner, today's counts, today's bookings and the
// week so far, in one request (spec §8 Home, §9).
router.get("/api/home", authenticate, withTenantHandler(async (req, res) => {
  try {
    const businessId = req.businessId;
    const tz = await loadBusinessTimezone((sql, p) => pool.query(sql, p), businessId);

    const open = await pool.query(OPEN_ITEMS, [businessId]);
    const done = await pool.query(DONE_TODAY, [businessId, tz]);
    const counts = await pool.query(COUNTS, [businessId, tz]);
    const bookings = await pool.query(TODAYS_BOOKINGS, [businessId, tz]);
    const n = counts.rows[0] || {};

    res.json({
      timezone: tz,
      openItems: open.rows.map((r) => ({
        callId: r.call_id,
        startedAt: iso(r.started_at),
        callerNumber: r.caller_number ?? null,
        callerName: r.caller_name ?? null,
        summary: r.summary ?? null,
        request: {
          type: r.request_type,
          callerName: r.request_caller_name ?? null,
          callbackNumber: r.callback_number ?? null,
          preferredTime: r.preferred_time ?? null,
          message: r.message ?? null,
          notes: r.notes ?? null,
        },
      })),
      doneToday: done.rows.map((r) => ({
        callId: r.call_id,
        startedAt: iso(r.started_at),
        callerNumber: r.caller_number ?? null,
        callerName: r.caller_name ?? null,
        summary: r.summary ?? null,
        status: r.status ?? null,
        handledAt: iso(r.handled_at),
        handledBy: r.handled_by ?? null,
        hadRequest: !!r.had_request,
      })),
      today: { answered: n.answered ?? 0, bookingsMade: n.bookings_made ?? 0 },
      todaysBookings: bookings.rows.map((r) => ({
        id: r.id,
        scheduledAt: iso(r.scheduled_at),
        clientName: r.client_name ?? null,
        status: r.status ?? null,
        callId: r.call_id ?? null,
      })),
      week: {
        calls: n.week_calls ?? 0,
        bookingsMade: n.week_bookings_made ?? 0,
        // Booking changes calls made this week (migration 062), counted apart
        // from bookings made: a move is not a new booking.
        bookingsMoved: n.week_bookings_moved ?? 0,
        bookingsCancelled: n.week_bookings_cancelled ?? 0,
      },
    });
  } catch (err) {
    console.error("home_failed", { message: err?.message });
    res.status(500).json({ error: "Couldn't load your calls. Check your connection, then try again." });
  }
}));

module.exports = router;

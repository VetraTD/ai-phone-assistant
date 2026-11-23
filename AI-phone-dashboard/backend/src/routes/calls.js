const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const pool = require("../db");
const { sanitizeString } = require("../utils");
const { withTenantHandler } = require("../middleware/withTenantHandler");
const { loadBusinessTimezone, callDateClauses } = require("../callDateBounds");
const { authSensitiveLimiter } = require("../middleware/rateLimiters");
const { isWithheld } = require("../withheld");

// A call is OPEN when it has a request nobody has marked done: either it was
// never marked done, or a request arrived after it was (for example the
// post-call check's follow-up, written at call end). Used by the "Needs you"
// view, the row's is_open, and Done itself.
const OPEN_REQUEST = `EXISTS (
        SELECT 1 FROM customer_requests cr
         WHERE cr.call_id = calls.id AND cr.business_id = calls.business_id
           AND (calls.handled_at IS NULL OR cr.created_at > calls.handled_at))`;

// Done takes effect when the call was not done yet, or a request arrived after
// it was; otherwise the first person and time stand.
const NOT_DONE = `(calls.handled_at IS NULL OR EXISTS (
        SELECT 1 FROM customer_requests cr
         WHERE cr.call_id = calls.id AND cr.business_id = calls.business_id AND cr.created_at > calls.handled_at))`;

// A call id is a uuid. Anything else is answered "not found" without asking
// the database, which would otherwise fail the cast and answer 500.
const CALL_ID = /^[0-9a-f-]{36}$/i;
const CALL_NOT_FOUND = { error: "Call not found" };

// Calls list with filters (scoped to the authenticated user's business)
// Supports query params:
// business_id (uuid)
// status (text)          e.g. completed | in-progress
// caller (text)          partial match on caller_number
// from (YYYY-MM-DD)      started_at >= from 00:00
// to (YYYY-MM-DD)        started_at <  (to + 1 day)
// has_appointments=true  only calls with at least 1 appointment
router.get("/api/calls", authenticate, withTenantHandler(async (req, res) => {
  try {
    const userBusinessId = req.businessId;

    const {
      status,
      caller,
      from,
      to,
      has_appointments,
      needs_followup,
    } = req.query;

    const where = [];
    const params = [];

    // helper to push params safely ($1, $2, ...)
    const addParam = (val) => {
      params.push(val);
      return `$${params.length}`;
    };

    // Always scope to the authenticated user's business
    where.push(`business_id = ${addParam(userBusinessId)}`);

    // The Inbox's "Needs you": calls that left a message or call-back request
    // nobody has marked done (migration 061). Any other value means all calls.
    if (req.query.view === "open") {
      where.push(OPEN_REQUEST);
    }

    // Inbox search over the number, the summary and the names callers gave.
    // The text is caller-influenced, so LIKE's own wildcards (and the escape
    // character itself) are escaped and match literally.
    const q = sanitizeString(req.query.q, 64);
    if (q) {
      const p = addParam(`%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`);
      const matches = [
        `calls.caller_number ILIKE ${p} ESCAPE '\\'`,
        `calls.summary ILIKE ${p} ESCAPE '\\'`,
        `EXISTS (SELECT 1 FROM customer_requests cr WHERE cr.call_id = calls.id AND cr.business_id = calls.business_id AND cr.caller_name ILIKE ${p} ESCAPE '\\')`,
        `EXISTS (SELECT 1 FROM appointments a WHERE a.call_id = calls.id AND a.business_id = calls.business_id AND a.client_name ILIKE ${p} ESCAPE '\\')`,
      ];
      // A number however it is typed: "07700 900123", "+44 7700 900123" and
      // "(555) 010-0199" all match the stored +447700900123 / +15550100199 by
      // their digits (a national leading 0 dropped).
      const digits = q.replace(/\D/g, "").replace(/^0+/, "");
      if (digits.length >= 4) {
        const d = addParam(`%${digits}%`);
        matches.push(
          `regexp_replace(coalesce(calls.caller_number, ''), '\\D', '', 'g') LIKE ${d}`,
          `EXISTS (SELECT 1 FROM customer_requests cr WHERE cr.call_id = calls.id AND cr.business_id = calls.business_id AND regexp_replace(coalesce(cr.callback_number, ''), '\\D', '', 'g') LIKE ${d})`
        );
      }
      where.push(`(${matches.join(" OR ")})`);
    }

    if (status && status !== "all") {
      // status is set authoritatively by markCallTransferred()/completeCall()
      // now (see services/db.js) — no summary-text inference needed.
      where.push(`status = ${addParam(status)}`);
    }

    const callerSearch = sanitizeString(caller, 64);
    if (callerSearch) {
      // partial match (case-insensitive)
      where.push(`caller_number ILIKE ${addParam(`%${callerSearch}%`)}`);
    }

    // direction filter (?direction=inbound|outbound). Allow-list, parameterised;
    // "all"/absent = no filter. Anything else (incl. repeated params) is a 400.
    const { direction } = req.query;
    if (direction !== undefined && direction !== "" && direction !== "all") {
      if (direction !== "inbound" && direction !== "outbound") {
        return res.status(400).json({ error: "Invalid direction (use inbound or outbound)" });
      }
      where.push(`direction = ${addParam(direction)}`);
    }

    const { sentiment, has_summary, outcome } = req.query;

// sentiment filter
if (sentiment && sentiment !== "all") {
  if (sentiment === "unknown") {
    where.push(`(sentiment IS NULL OR sentiment = '')`);
  } else {
    where.push(`sentiment = ${addParam(sentiment)}`);
  }
}

// outcome filter (e.g. ?outcome=spam)
if (outcome && outcome !== "all") {
  where.push(`outcome = ${addParam(outcome)}`);
}

// summary present / not present
if (has_summary === "true") {
  where.push(`summary IS NOT NULL AND summary <> ''`);
}
if (has_summary === "false") {
  where.push(`(summary IS NULL OR summary = '')`);
}

// Needs followup = calls with customer requests
if (needs_followup === "true") {
  where.push(`
    EXISTS (
      SELECT 1
      FROM customer_requests cr
      WHERE cr.call_id = calls.id
    )
  `);
}

    // Date filtering: from/to are YYYY-MM-DD in the BUSINESS timezone (see
    // callDateBounds.js for why not the database's).
    if (from || to) {
      const tz = await loadBusinessTimezone((sql, p) => pool.query(sql, p), userBusinessId);
      where.push(...callDateClauses({ from, to, tz, addParam }));
    }

    // Only calls that have appointments
    if (has_appointments === "true") {
      where.push(
        `EXISTS (select 1 from appointments a where a.call_id = calls.id)`
      );
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const countRes = await pool.query(
      `SELECT COUNT(*) AS total FROM calls ${whereSql}`,
      params
    );
    const total = parseInt(countRes.rows[0]?.total ?? 0, 10);

    const sql = `
      SELECT calls.*,
        COALESCE(
          (SELECT cr.caller_name FROM customer_requests cr
            WHERE cr.call_id = calls.id AND cr.business_id = calls.business_id AND cr.caller_name IS NOT NULL AND btrim(cr.caller_name) <> ''
            ORDER BY cr.created_at DESC LIMIT 1),
          (SELECT a.client_name FROM appointments a WHERE a.call_id = calls.id AND a.business_id = calls.business_id ORDER BY a.created_at DESC LIMIT 1)
        ) AS caller_name_guess,
        EXISTS (SELECT 1 FROM customer_requests cr WHERE cr.call_id = calls.id AND cr.business_id = calls.business_id) AS has_request,
        ${OPEN_REQUEST} AS is_open,
        (SELECT cr.request_type FROM customer_requests cr WHERE cr.call_id = calls.id AND cr.business_id = calls.business_id ORDER BY cr.created_at DESC LIMIT 1) AS request_type
      FROM calls
      ${whereSql}
      ORDER BY started_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const r = await pool.query(sql, params);
    // inferred_transferred is a legacy field name kept for frontend
    // compatibility — it now just mirrors the authoritative status column
    // (set by markCallTransferred()/completeCall(), see services/db.js)
    // instead of regexing the summary text for "transfer".
    const rows = (r.rows || []).map((row) => ({
      ...row,
      inferred_transferred: row.status === "transferred",
    }));
    res.json({ calls: rows, total });
  } catch (err) {
    const status = err.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;
    res.status(status).json({ error: status === 500 ? "Failed to load calls" : err.message });
  }
}));

// GET a single call with transcript + appointments + customer requests
// /api/calls/:id (scoped to the authenticated user's business)
router.get("/api/calls/:id", authenticate, withTenantHandler(async (req, res) => {
  try {
    const userBusinessId = req.businessId;

    const { id } = req.params;
    if (!CALL_ID.test(id)) return res.status(404).json(CALL_NOT_FOUND);

    // Call (ensure it belongs to the user's business)
    const callRes = await pool.query(
      "select * from calls where id = $1 and business_id = $2 limit 1",
      [id, userBusinessId]
    );

    if (callRes.rows.length === 0) {
      return res.status(404).json({ error: "Call not found" });
    }

    // Transcript ordered by sequence
    const transcriptRes = await pool.query(
      "select * from call_transcripts where call_id = $1 order by sequence asc",
      [id]
    );

    // Appointments linked to this call
    const apptRes = await pool.query(
      "select * from appointments where call_id = $1 order by created_at desc",
      [id]
    );

    // Customer requests linked to this call
    const reqRes = await pool.query(
      "select * from customer_requests where call_id = $1 order by created_at desc",
      [id]
    );

    const call = callRes.rows[0];

    // The caller's other calls and this week's bookings (the Inbox's caller
    // column). Nothing to look up for a withheld or missing number.
    const callerHistory = { calls: [], bookings: [] };
    const number = typeof call.caller_number === "string" ? call.caller_number : "";
    if (!isWithheld(number)) {
      const otherCalls = await pool.query(
        `/* caller_history_calls */
         SELECT id, started_at, summary, status FROM calls
          WHERE business_id = $1 AND caller_number = $2 AND id <> $3
          ORDER BY started_at DESC
          LIMIT 10`,
        [userBusinessId, number, id]
      );
      const bookings = await pool.query(
        `/* caller_history_bookings */
         SELECT id, scheduled_at, status, client_name FROM appointments
          WHERE business_id = $1 AND client_phone = $2
            AND scheduled_at >= now() - interval '1 day' AND scheduled_at <= now() + interval '7 days'
          ORDER BY scheduled_at ASC
          LIMIT 20`,
        [userBusinessId, number]
      );
      callerHistory.calls = otherCalls.rows;
      callerHistory.bookings = bookings.rows;
    }

    // See the /api/calls list handler above — mirrors the authoritative
    // status column rather than regexing the summary text.
    const inferredTransferred = call?.status === "transferred";
    res.json({
      call: { ...call, inferred_transferred: inferredTransferred },
      transcript: transcriptRes.rows,
      appointments: apptRes.rows,
      customer_requests: reqRes.rows,
      caller_history: callerHistory,
    });
  } catch (err) {
    // The raw Postgres message used to go straight to the browser. It names
    // tables, columns and constraints, which is free schema reconnaissance for
    // anyone with a login, and it is no use to the person reading it either.
    // The detail belongs in the log, where an operator can find it.
    console.error("call_detail_failed", { callId: req.params?.id, message: err?.message });
    res.status(500).json({ error: "Could not load this call." });
  }
}));

// Mark a call's open item (a message or call-back request) done, and reopen it
// (dashboard overhaul, migration 061). The first person to press Done keeps it:
// a second Done changes nothing, unless a request arrived after the first one,
// in which case Done takes the new time and person. Scoped to the signed-in
// business explicitly as well as by row-level security, so another business's
// call is "not found". Rate-limited per signed-in user (the limiter runs after
// authenticate, so it can key on the account rather than the office's IP).
router.put("/api/calls/:id/handled", authenticate, authSensitiveLimiter, withTenantHandler(async (req, res) => {
  const { id } = req.params;
  if (!CALL_ID.test(id)) return res.status(404).json(CALL_NOT_FOUND);
  try {
    const r = await pool.query(
      `UPDATE calls
          SET handled_at = CASE WHEN ${NOT_DONE} THEN now() ELSE handled_at END,
              handled_by = CASE WHEN ${NOT_DONE} THEN $3 ELSE handled_by END
        WHERE id = $1 AND business_id = $2
        RETURNING id, handled_at, handled_by`,
      [id, req.businessId, req.authUser.id]
    );
    if (!r.rows.length) return res.status(404).json(CALL_NOT_FOUND);
    res.json(r.rows[0]);
  } catch (err) {
    console.error("call_handled_failed", { callId: id, message: err?.message });
    res.status(500).json({ error: "Couldn't mark that as done. Try again." });
  }
}));

router.delete("/api/calls/:id/handled", authenticate, authSensitiveLimiter, withTenantHandler(async (req, res) => {
  const { id } = req.params;
  if (!CALL_ID.test(id)) return res.status(404).json(CALL_NOT_FOUND);
  try {
    const r = await pool.query(
      `UPDATE calls
          SET handled_at = NULL, handled_by = NULL
        WHERE id = $1 AND business_id = $2
        RETURNING id, handled_at, handled_by`,
      [id, req.businessId]
    );
    if (!r.rows.length) return res.status(404).json(CALL_NOT_FOUND);
    res.json(r.rows[0]);
  } catch (err) {
    console.error("call_reopen_failed", { callId: id, message: err?.message });
    res.status(500).json({ error: "Couldn't reopen that. Try again." });
  }
}));

module.exports = router;

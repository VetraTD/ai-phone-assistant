const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const pool = require("../db");
const { getBusinessIdForUser, sanitizeString } = require("../utils");

// Calls list with filters (scoped to the authenticated user's business)
// Supports query params:
// business_id (uuid)
// status (text)          e.g. completed | in-progress
// caller (text)          partial match on caller_number
// from (YYYY-MM-DD)      started_at >= from 00:00
// to (YYYY-MM-DD)        started_at <  (to + 1 day)
// has_appointments=true  only calls with at least 1 appointment
router.get("/api/calls", authenticate, async (req, res) => {
  try {
    const authUserId = req.authUser.id;
    const userBusinessId = await getBusinessIdForUser(authUserId);
    if (!userBusinessId) {
      return res.status(403).json({ error: "No business linked to this user" });
    }

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

    if (status && status !== "all") {
      // status is set authoritatively by markCallTransferred()/completeCall()
      // now (see services/supabase.js) — no summary-text inference needed.
      where.push(`status = ${addParam(status)}`);
    }

    const callerSearch = sanitizeString(caller, 64);
    if (callerSearch) {
      // partial match (case-insensitive)
      where.push(`caller_number ILIKE ${addParam(`%${callerSearch}%`)}`);
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



    // Date filtering
    // from/to are YYYY-MM-DD strings
    if (from) {
      where.push(`started_at >= ${addParam(from)}::date`);
    }

    if (to) {
      // include the full "to" day by using < (to + 1 day)
      where.push(`started_at < (${addParam(to)}::date + interval '1 day')`);
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
        (SELECT a.client_name FROM appointments a WHERE a.call_id = calls.id ORDER BY a.created_at DESC LIMIT 1) AS caller_name_guess
      FROM calls
      ${whereSql}
      ORDER BY started_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const r = await pool.query(sql, params);
    // inferred_transferred is a legacy field name kept for frontend
    // compatibility — it now just mirrors the authoritative status column
    // (set by markCallTransferred()/completeCall(), see services/supabase.js)
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
});

// GET a single call with transcript + appointments + customer requests
// /api/calls/:id (scoped to the authenticated user's business)
router.get("/api/calls/:id", authenticate, async (req, res) => {
  try {
    const authUserId = req.authUser.id;
    const userBusinessId = await getBusinessIdForUser(authUserId);
    if (!userBusinessId) {
      return res.status(403).json({ error: "No business linked to this user" });
    }

    const { id } = req.params;

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
    // See the /api/calls list handler above — mirrors the authoritative
    // status column rather than regexing the summary text.
    const inferredTransferred = call?.status === "transferred";
    res.json({
      call: { ...call, inferred_transferred: inferredTransferred },
      transcript: transcriptRes.rows,
      appointments: apptRes.rows,
      customer_requests: reqRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

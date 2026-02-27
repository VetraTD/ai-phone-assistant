require("dotenv").config();

const express = require("express");
const cors = require("cors");

// ✅ DB pool (make sure src/db/index.js exports the pool)
const pool = require("./db");

const app = express();

app.use(cors());
app.use(express.json());

// ✅ Health check
app.get("/health", (req, res) => {
  res.json({
    status: "running",
    service: "dashboard-backend",
  });
});

// ✅ DB connection test
app.get("/db-test", async (req, res) => {
  try {
    const r = await pool.query("select now() as now");
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Calls list with filters
// Supports query params:
// business_id (uuid)
// status (text)          e.g. completed | in-progress
// caller (text)          partial match on caller_number
// from (YYYY-MM-DD)      started_at >= from 00:00
// to (YYYY-MM-DD)        started_at <  (to + 1 day)
// has_appointments=true  only calls with at least 1 appointment
app.get("/api/calls", async (req, res) => {
  try {
    const {
      business_id,
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

    if (business_id) {
      where.push(`business_id = ${addParam(business_id)}`);
    }

    if (status && status !== "all") {
      where.push(`status = ${addParam(status)}`);
    }

    if (caller && caller.trim()) {
      // partial match (case-insensitive)
      where.push(`caller_number ILIKE ${addParam(`%${caller.trim()}%`)}`);
    }



    const { sentiment, has_summary } = req.query;

// sentiment filter
if (sentiment && sentiment !== "all") {
  if (sentiment === "unknown") {
    where.push(`(sentiment IS NULL OR sentiment = '')`);
  } else {
    where.push(`sentiment = ${addParam(sentiment)}`);
  }
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

    const sql = `
      SELECT *
      FROM calls
      ${whereSql}
      ORDER BY started_at DESC
      LIMIT 200
    `;

    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// GET a single call with transcript + appointments + customer requests
// /api/calls/:id
app.get("/api/calls/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Call
    const callRes = await pool.query(
      "select * from calls where id = $1 limit 1",
      [id]
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

    // ✅ Customer requests linked to this call
    const reqRes = await pool.query(
      "select * from customer_requests where call_id = $1 order by created_at desc",
      [id]
    );

    res.json({
      call: callRes.rows[0],
      transcript: transcriptRes.rows,
      appointments: apptRes.rows,
      customer_requests: reqRes.rows, // ✅ new
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ✅ Get a business by id
// /api/businesses/:id
app.get("/api/businesses/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const r = await pool.query(
      `select id, name, phone_number, timezone, created_at
       from businesses
       where id = $1
       limit 1`,
      [id]
    );

    if (r.rows.length === 0) {
      return res.status(404).json({ error: "Business not found" });
    }

    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log("Dashboard backend running on port " + PORT);
});
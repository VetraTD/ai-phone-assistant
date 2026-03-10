require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const authenticate = require("./middleware/authMiddleware");

// ✅ DB pool (make sure src/db/index.js exports the pool)
const pool = require("./db");

const app = express();

// Helper: get the business_id for the authenticated user
async function getBusinessIdForUser(userId) {
  const r = await pool.query(
    `select business_id from users where id = $1`,
    [userId]
  );
  return r.rows[0]?.business_id || null;
}

app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://ai-phone-dashboard-lemon.vercel.app"
  ]
}));



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

// ✅ Calls list with filters (scoped to the authenticated user's business)
// Supports query params:
// business_id (uuid)
// status (text)          e.g. completed | in-progress
// caller (text)          partial match on caller_number
// from (YYYY-MM-DD)      started_at >= from 00:00
// to (YYYY-MM-DD)        started_at <  (to + 1 day)
// has_appointments=true  only calls with at least 1 appointment
app.get("/api/calls", authenticate, async (req, res) => {
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
      if (status === "transferred") {
        where.push(`(status = 'transferred' OR (status = 'completed' AND summary IS NOT NULL AND summary ILIKE '%transfer%'))`);
      } else {
        where.push(`status = ${addParam(status)}`);
      }
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
    const rows = (r.rows || []).map((row) => ({
      ...row,
      inferred_transferred: !!(row.summary && /transfer/i.test(String(row.summary))),
    }));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// GET a single call with transcript + appointments + customer requests
// /api/calls/:id (scoped to the authenticated user's business)
app.get("/api/calls/:id", authenticate, async (req, res) => {
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

    // ✅ Customer requests linked to this call
    const reqRes = await pool.query(
      "select * from customer_requests where call_id = $1 order by created_at desc",
      [id]
    );

    const call = callRes.rows[0];
    const summary = call?.summary;
    const inferredTransferred = !!(summary && /transfer/i.test(String(summary)));
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


// ✅ Get a business by id (must match authenticated user's business)
// /api/businesses/:id
app.get("/api/businesses/:id", authenticate, async (req, res) => {
  try {
    const authUserId = req.authUser.id;
    const userBusinessId = await getBusinessIdForUser(authUserId);
    if (!userBusinessId) {
      return res.status(403).json({ error: "No business linked to this user" });
    }

    const { id } = req.params;

    const r = await pool.query(
      `select id, name, phone_number, timezone, created_at
       from businesses
       where id = $1
       limit 1`,
      [id]
    );

    // Do not leak other businesses
    if (r.rows.length && r.rows[0].id !== userBusinessId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (r.rows.length === 0) {
      return res.status(404).json({ error: "Business not found" });
    }

    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});




// Analytics for the authenticated user's business
app.get("/api/analytics/:businessId", authenticate, async (req, res) => {
  const authUserId = req.authUser.id;
  try {
    const businessId = await getBusinessIdForUser(authUserId);
    if (!businessId) {
      return res.status(403).json({ error: "No business linked to this user" });
    }

    const callsToday = await pool.query(`
      SELECT COUNT(*) 
      FROM calls
      WHERE business_id = $1
      AND started_at::date = CURRENT_DATE
    `, [businessId]);

    const appointmentsToday = await pool.query(`
      SELECT COUNT(*)
      FROM appointments a
      JOIN calls c ON a.call_id = c.id
      WHERE c.business_id = $1
      AND a.created_at::date = CURRENT_DATE
    `, [businessId]);

    const followups = await pool.query(`
      SELECT COUNT(DISTINCT c.id)
      FROM customer_requests cr
      JOIN calls c ON cr.call_id = c.id
      WHERE c.business_id = $1
    `, [businessId]);

    const transferredToday = await pool.query(`
      SELECT COUNT(*)
      FROM calls
      WHERE business_id = $1
      AND started_at::date = CURRENT_DATE
      AND (status = 'transferred' OR (status = 'completed' AND summary IS NOT NULL AND summary ILIKE '%transfer%'))
    `, [businessId]);

    res.json({
      calls_today: Number(callsToday.rows[0].count),
      appointments_today: Number(appointmentsToday.rows[0].count),
      followups_needed: Number(followups.rows[0].count),
      transferred_today: Number(transferredToday.rows[0]?.count ?? 0),
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// Analytics breakdown: period=7d|30d|90d, returns time buckets + totals for analytics page
app.get("/api/analytics-breakdown", authenticate, async (req, res) => {
  try {
    const authUserId = req.authUser.id;
    const businessId = await getBusinessIdForUser(authUserId);
    if (!businessId) {
      return res.status(403).json({ error: "No business linked to this user" });
    }

    const period = (req.query.period || "90d").toLowerCase();
    const interval = period === "7d" ? "7 days" : period === "30d" ? "30 days" : "3 months";
    const since = period === "7d" ? "CURRENT_DATE - interval '7 days'" : period === "30d" ? "CURRENT_DATE - interval '30 days'" : "CURRENT_DATE - interval '3 months'";

    let bucketsQuery;
    if (period === "7d") {
      bucketsQuery = `
      WITH days AS (
        SELECT (date_trunc('day', d) AT TIME ZONE 'UTC')::date AS day_start
        FROM generate_series(
          (CURRENT_DATE - interval '6 days')::timestamp,
          CURRENT_DATE::timestamp,
          '1 day'::interval
        ) AS d
      ),
      counts AS (
        SELECT (started_at AT TIME ZONE 'UTC')::date AS day_start, COUNT(*) AS total_calls
        FROM calls WHERE business_id = $1 AND started_at >= ${since}
        GROUP BY 1
      )
      SELECT to_char(d.day_start, 'Dy DD') AS bucket_label, COALESCE(c.total_calls, 0)::int AS total_calls
      FROM days d LEFT JOIN counts c ON c.day_start = d.day_start
      ORDER BY d.day_start
      `;
    } else if (period === "30d") {
      bucketsQuery = `
      WITH weeks AS (
        SELECT date_trunc('week', w)::date AS week_start
        FROM generate_series(
          (CURRENT_DATE - interval '27 days')::timestamp,
          CURRENT_DATE::timestamp,
          '7 days'::interval
        ) AS w
      ),
      counts AS (
        SELECT date_trunc('week', started_at)::date AS week_start, COUNT(*) AS total_calls
        FROM calls WHERE business_id = $1 AND started_at >= ${since}
        GROUP BY 1
      )
      SELECT 'Week of ' || to_char(w.week_start, 'Mon DD') AS bucket_label, COALESCE(c.total_calls, 0)::int AS total_calls
      FROM weeks w LEFT JOIN counts c ON c.week_start = w.week_start
      ORDER BY w.week_start
      `;
    } else {
      bucketsQuery = `
      WITH months AS (
        SELECT date_trunc('month', m)::date AS month_start
        FROM generate_series(
          date_trunc('month', CURRENT_DATE - interval '2 months')::timestamp,
          date_trunc('month', CURRENT_DATE)::timestamp,
          '1 month'::interval
        ) AS m
      ),
      counts AS (
        SELECT date_trunc('month', started_at)::date AS month_start, COUNT(*) AS total_calls
        FROM calls WHERE business_id = $1 AND started_at >= ${since}
        GROUP BY 1
      )
      SELECT to_char(m.month_start, 'Mon YYYY') AS bucket_label, COALESCE(c.total_calls, 0)::int AS total_calls
      FROM months m LEFT JOIN counts c ON c.month_start = m.month_start
      ORDER BY m.month_start
      `;
    }

    const bucketsRes = await pool.query(bucketsQuery, [businessId]);
    const totalRes = await pool.query(
      `SELECT COUNT(*) AS total FROM calls WHERE business_id = $1 AND started_at >= ${since}`,
      [businessId]
    );
    const actionsRes = await pool.query(
      `
      SELECT
        (SELECT COUNT(*) FROM appointments a JOIN calls c ON a.call_id = c.id WHERE c.business_id = $1 AND c.started_at >= ${since}) AS appointments,
        (SELECT COUNT(*) FROM customer_requests cr JOIN calls c ON cr.call_id = c.id WHERE c.business_id = $1 AND c.started_at >= ${since} AND cr.request_type = 'callback') AS callbacks,
        (SELECT COUNT(*) FROM customer_requests cr JOIN calls c ON cr.call_id = c.id WHERE c.business_id = $1 AND c.started_at >= ${since} AND cr.request_type = 'message') AS messages
      `,
      [businessId]
    );
    const followupsRes = await pool.query(
      `SELECT COUNT(DISTINCT c.id) AS followups FROM customer_requests cr JOIN calls c ON cr.call_id = c.id WHERE c.business_id = $1`,
      [businessId]
    );
    const sentimentRes = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE sentiment = 'positive') * 100.0 / NULLIF(COUNT(*), 0) AS percent FROM calls WHERE business_id = $1 AND started_at >= ${since}`,
      [businessId]
    );

    // Sentiment breakdown (counts)
    const sentimentCountsRes = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE sentiment = 'positive') AS positive,
        COUNT(*) FILTER (WHERE sentiment = 'neutral') AS neutral,
        COUNT(*) FILTER (WHERE sentiment = 'negative') AS negative,
        COUNT(*) FILTER (WHERE sentiment IS NULL OR sentiment = '') AS unknown
      FROM calls WHERE business_id = $1 AND started_at >= ${since}`,
      [businessId]
    );

    // Call status breakdown (completed, transferred, missed, etc.)
    // Infer "transferred" from completed calls whose summary mentions transfer (when status isn't already 'transferred')
    const statusCountsRes = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'transferred') AS transferred,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        COUNT(*) FILTER (WHERE status = 'no-answer') AS no_answer,
        COUNT(*) FILTER (WHERE status = 'busy') AS busy,
        COUNT(*) FILTER (WHERE status = 'in-progress') AS in_progress
      FROM calls WHERE business_id = $1 AND started_at >= ${since}`,
      [businessId]
    );
    const inferredTransferredRes = await pool.query(
      `SELECT COUNT(*) AS cnt FROM calls WHERE business_id = $1 AND started_at >= ${since} AND status = 'completed' AND summary IS NOT NULL AND summary ILIKE '%transfer%'`,
      [businessId]
    );
    const inferredTransferred = Number(inferredTransferredRes.rows[0]?.cnt ?? 0);

    // Calls by day of week (1=Mon .. 7=Sun) for the period
    const weekdayRes = await pool.query(
      `SELECT EXTRACT(ISODOW FROM started_at)::int AS dow, COUNT(*) AS total_calls
       FROM calls WHERE business_id = $1 AND started_at >= ${since}
       GROUP BY EXTRACT(ISODOW FROM started_at)
       ORDER BY dow`,
      [businessId]
    );
    const dayNames = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const byWeekday = [1, 2, 3, 4, 5, 6, 7].map((dow) => {
      const row = weekdayRes.rows.find((r) => Number(r.dow) === dow);
      return { day_name: dayNames[dow], total_calls: row ? Number(row.total_calls) : 0 };
    });

    const totalCalls = Number(totalRes.rows[0]?.total ?? 0);
    const appointmentsCount = Number(actionsRes.rows[0]?.appointments ?? 0);
    const appointmentConversionPercent =
      totalCalls > 0 ? Math.round((appointmentsCount / totalCalls) * 100) : 0;

    const rows = bucketsRes.rows.map((r) => ({ month_label: r.bucket_label, total_calls: r.total_calls }));

    res.json({
      calls_by_month: rows,
      total_calls_3m: totalCalls,
      actions: actionsRes.rows[0] || { appointments: 0, callbacks: 0, messages: 0 },
      followups_needed: Number(followupsRes.rows[0]?.followups ?? 0),
      positive_calls_percent: Math.round(Number(sentimentRes.rows[0]?.percent ?? 0)),
      appointment_conversion_percent: appointmentConversionPercent,
      sentiment_counts: (() => {
        const r = sentimentCountsRes.rows[0];
        return r ? { positive: Number(r.positive ?? 0), neutral: Number(r.neutral ?? 0), negative: Number(r.negative ?? 0), unknown: Number(r.unknown ?? 0) } : { positive: 0, neutral: 0, negative: 0, unknown: 0 };
      })(),
      status_counts: (() => {
        const r = statusCountsRes.rows[0];
        if (!r) return { completed: 0, transferred: 0, failed: 0, no_answer: 0, busy: 0, in_progress: 0 };
        const completedRaw = Number(r.completed ?? 0);
        const transferredRaw = Number(r.transferred ?? 0);
        const completed = Math.max(0, completedRaw - inferredTransferred);
        const transferred = transferredRaw + inferredTransferred;
        return { completed, transferred, failed: Number(r.failed ?? 0), no_answer: Number(r.no_answer ?? 0), busy: Number(r.busy ?? 0), in_progress: Number(r.in_progress ?? 0) };
      })(),
      calls_by_weekday: byWeekday,
      period,
    });
  } catch (err) {
    console.error("analytics-breakdown failed:", err);
    res.status(500).json({ error: "Failed to load analytics breakdown" });
  }
});

// Appointments for the authenticated user's business with simple ranges
// GET /api/appointments?range=today|7days|upcoming
app.get("/api/appointments", authenticate, async (req, res) => {
  try {
    const authUserId = req.authUser.id;
    const businessId = await getBusinessIdForUser(authUserId);
    if (!businessId) {
      return res.status(403).json({ error: "No business linked to this user" });
    }

    const { range } = req.query;

    let dateCondition = "";
    if (range === "7days") {
      dateCondition = "and a.scheduled_at::date between CURRENT_DATE and (CURRENT_DATE + interval '7 days')";
    } else if (range === "upcoming") {
      dateCondition = "and a.scheduled_at::date >= CURRENT_DATE";
    } else {
      // default to today
      dateCondition = "and a.scheduled_at::date = CURRENT_DATE";
    }

    const r = await pool.query(
      `select a.id,
              a.client_name,
              a.client_phone,
              a.scheduled_at,
              a.status,
              a.notes
       from appointments a
       join calls c on a.call_id = c.id
       where c.business_id = $1
         ${dateCondition}
       order by a.scheduled_at asc`,
      [businessId]
    );

    res.json(r.rows);
  } catch (err) {
    console.error("appointments-today failed:", err);
    res.status(500).json({ error: "Failed to load today's appointments" });
  }
});

// Send appointments summary email to the business notification email
// POST /api/appointments/email  { range: "today" | "7days" | "upcoming" }
app.post("/api/appointments/email", authenticate, async (req, res) => {
  try {
    if (!process.env.BREVO_API_KEY || !process.env.BREVO_FROM_EMAIL) {
      return res
        .status(500)
        .json({ error: "Email sending is not configured on the server." });
    }
    const authUserId = req.authUser.id;
    const businessId = await getBusinessIdForUser(authUserId);
    if (!businessId) {
      return res
        .status(403)
        .json({ error: "No business linked to this user" });
    }

    const bizRes = await pool.query(
      `select name, notification_email from businesses where id = $1`,
      [businessId]
    );
    const biz = bizRes.rows[0];
    if (!biz || !biz.notification_email) {
      return res
        .status(400)
        .json({ error: "Notification email is not set for this business." });
    }

    const { range } = req.body || {};
    let dateCondition = "";
    let label;
    if (range === "7days") {
      dateCondition =
        "and a.scheduled_at::date between CURRENT_DATE and (CURRENT_DATE + interval '7 days')";
      label = "Next 7 days";
    } else if (range === "upcoming") {
      dateCondition = "and a.scheduled_at::date >= CURRENT_DATE";
      label = "Upcoming";
    } else {
      dateCondition = "and a.scheduled_at::date = CURRENT_DATE";
      label = "Today";
    }

    const apptsRes = await pool.query(
      `select a.client_name,
              a.client_phone,
              a.scheduled_at,
              a.status,
              a.notes
       from appointments a
       join calls c on a.call_id = c.id
       where c.business_id = $1
         ${dateCondition}
       order by a.scheduled_at asc`,
      [businessId]
    );
    const appts = apptsRes.rows;

    let text;
    if (!appts.length) {
      text = `No appointments are scheduled for ${label.toLowerCase()}.`;
    } else {
      const lines = appts.map((a) => {
        const when = a.scheduled_at
          ? new Date(a.scheduled_at).toLocaleString()
          : "N/A";
        const name = a.client_name || "Unknown client";
        const phone = a.client_phone || "";
        const status = a.status || "";
        const notes = a.notes ? ` | Notes: ${a.notes}` : "";
        return `- ${when} — ${name} ${
          phone ? "(" + phone + ")" : ""
        } [${status}]${notes}`;
      });
      text =
        `Appointments (${label}) for ${
          biz.name || "your business"
        }:\n\n` + lines.join("\n");
    }

    await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: {
          email: process.env.BREVO_FROM_EMAIL,
          name: process.env.BREVO_FROM_NAME || biz.name || "Your business",
        },
        to: [{ email: biz.notification_email }],
        subject: `${label} appointments for ${biz.name || "your business"}`,
        textContent: text,
      },
      {
        headers: {
          "api-key": process.env.BREVO_API_KEY,
          "Content-Type": "application/json",
          accept: "application/json",
        },
      }
    );

    res.json({ success: true, count: appts.length });
  } catch (err) {
    console.error("appointments-email failed:", err.response?.data || err);
    res.status(500).json({ error: "Failed to send appointments email" });
  }
});

app.get("/api/me", authenticate, async (req, res) => {
  try {
    const authUserId = req.authUser.id;

    const result = await pool.query(
      `select business_id from users where id = $1`,
      [authUserId]
    );

    // no user row OR user has no business yet -> onboarding
    if (result.rows.length === 0 || !result.rows[0].business_id) {
      return res.json({ authUserId, needsOnboarding: true });
    }

    const businessId = result.rows[0].business_id;

    const businessRes = await pool.query(
      `select * from businesses where id = $1`,
      [businessId]
    );

    return res.json({
      authUserId,
      needsOnboarding: false,
      business: businessRes.rows[0] || null,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/onboarding/create-business", authenticate, async (req, res) => {
  try {
    const userId = req.authUser.id;
    const { name, timezone } = req.body;

    if (!name || !timezone) {
      return res.status(400).json({ error: "Missing fields" });
    }


const email = req.authUser.email;

await pool.query(
  `insert into users (id, email)
   values ($1, $2)
   on conflict (id) do update set email = excluded.email`,
  [userId, email]
);

    // 2) create business
    const bizRes = await pool.query(
      `insert into businesses (name, timezone)
       values ($1, $2)
       returning *`,
      [name, timezone]
    );

    const newBiz = bizRes.rows[0];

    // 3) link user -> business
    await pool.query(
      `update users set business_id = $1 where id = $2`,
      [newBiz.id, userId]
    );

    // 4) return business
    return res.json({ business: newBiz });
  } catch (err) {
    console.error("create-business failed:", err);
    return res.status(500).json({ error: err.message });
  }
});



//RECENTLY ADDED - UPDATE BUSINESS SETTINGS  TAKE OUT IF NOT NEEDED

app.put("/api/business/:id/settings", authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Ensure the authenticated user actually owns this business
    const authUserId = req.authUser.id;
    const userBusinessId = await getBusinessIdForUser(authUserId);
    if (!userBusinessId || userBusinessId !== id) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const {
      name,
      timezone,
      greeting_message,
      after_hours_policy,
      transfer_policy,
      transfer_phone_number,
      notification_email,
      notification_phone,
      default_language,
      general_info,
      address_line1,
      address_line2,
      city,
      state_region,
      postal_code,
    } = req.body;

    const result = await pool.query(
      `UPDATE businesses
       SET name = $1,
           timezone = $2,
           greeting = $3,
           after_hours_policy = $4,
           transfer_policy = $5,
           transfer_phone_number = $6,
           notification_email = $7,
           notification_phone = $8,
           default_language = $9,
           general_info = $10,
           address_line1 = $11,
           address_line2 = $12,
           city = $13,
           state_region = $14,
           postal_code = $15
       WHERE id = $16
       RETURNING *`,
      [
        name,
        timezone,
        greeting_message,
        after_hours_policy,
        transfer_policy,
        transfer_phone_number,
        notification_email,
        notification_phone,
        default_language,
        general_info ?? "",
        address_line1 ?? "",
        address_line2 ?? "",
        city ?? "",
        state_region ?? "",
        postal_code ?? "",
        id,
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("settings update failed:", err);
    res.status(500).json({ error: "Failed to update settings" });
  }
});


// ---------------------------------------------------------------------------
// Integrations API (list, create/update, definitions)
// ---------------------------------------------------------------------------

const INTEGRATION_DEFINITIONS = [
  {
    id: "webhook",
    name: "Custom webhook",
    authType: "webhook",
    configSchema: {
      type: "object",
      required: ["url", "method"],
      properties: {
        url: { type: "string", format: "uri", description: "HTTPS URL to call when the AI invokes this tool" },
        method: { type: "string", enum: ["POST", "PUT"], default: "POST" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        params_schema: { type: "object", description: "JSON Schema for tool parameters" },
        description: { type: "string", description: "Human-readable description for the AI" },
      },
    },
  },
];

const BUILTIN_TOOL_NAMES = ["set_call_intent", "end_call", "book_appointment", "record_customer_request"];

app.get("/api/integrations/definitions", (req, res) => {
  res.json(INTEGRATION_DEFINITIONS);
});

app.get("/api/integrations", authenticate, async (req, res) => {
  try {
    const userBusinessId = await getBusinessIdForUser(req.authUser.id);
    if (!userBusinessId) {
      return res.status(403).json({ error: "No business linked to this user" });
    }
    const r = await pool.query(
      `SELECT id, business_id, provider, name, enabled, config, created_at, updated_at
       FROM integrations
       WHERE business_id = $1
       ORDER BY created_at ASC`,
      [userBusinessId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error("list integrations error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/integrations", authenticate, async (req, res) => {
  try {
    const userBusinessId = await getBusinessIdForUser(req.authUser.id);
    if (!userBusinessId) {
      return res.status(403).json({ error: "No business linked to this user" });
    }
    const { provider, name, config, enabled } = req.body || {};
    if (!provider || !name) {
      return res.status(400).json({ error: "provider and name are required" });
    }
    if (BUILTIN_TOOL_NAMES.includes(name)) {
      return res.status(400).json({ error: "name cannot be a built-in tool name" });
    }
    if (provider !== "webhook") {
      return res.status(400).json({ error: "Only webhook provider is supported in v1" });
    }
    const cfg = config && typeof config === "object" ? config : {};
    const url = cfg.url;
    if (!url || typeof url !== "string" || !url.startsWith("https://")) {
      return res.status(400).json({ error: "config.url must be an HTTPS URL" });
    }
    const method = (cfg.method || "POST").toUpperCase();
    if (!["POST", "PUT"].includes(method)) {
      return res.status(400).json({ error: "config.method must be POST or PUT" });
    }
    const r = await pool.query(
      `INSERT INTO integrations (business_id, provider, name, enabled, config, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (business_id, name)
       DO UPDATE SET provider = EXCLUDED.provider, enabled = EXCLUDED.enabled, config = EXCLUDED.config, updated_at = now()
       RETURNING id, business_id, provider, name, enabled, config, created_at, updated_at`,
      [userBusinessId, provider, name, enabled !== false, JSON.stringify(cfg)]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error("create/update integration error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/integrations/:id", authenticate, async (req, res) => {
  try {
    const userBusinessId = await getBusinessIdForUser(req.authUser.id);
    if (!userBusinessId) {
      return res.status(403).json({ error: "No business linked to this user" });
    }
    const { id } = req.params;
    const softDisable = req.query.soft === "true";
    if (softDisable) {
      await pool.query(
        `UPDATE integrations SET enabled = false, updated_at = now() WHERE id = $1 AND business_id = $2`,
        [id, userBusinessId]
      );
    } else {
      await pool.query(
        `DELETE FROM integrations WHERE id = $1 AND business_id = $2`,
        [id, userBusinessId]
      );
    }
    res.status(204).end();
  } catch (err) {
    console.error("delete integration error:", err.message);
    res.status(500).json({ error: err.message });
  }
});


const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log("Dashboard backend running on port " + PORT);
});
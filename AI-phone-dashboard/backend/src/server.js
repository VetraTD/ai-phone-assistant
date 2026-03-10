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

    const sentiment = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE sentiment = 'positive') * 100.0 /
        NULLIF(COUNT(*),0) as percent
      FROM calls
      WHERE business_id = $1
    `, [businessId]);

    res.json({
      calls_today: Number(callsToday.rows[0].count),
      appointments_today: Number(appointmentsToday.rows[0].count),
      followups_needed: Number(followups.rows[0].count),
      positive_calls_percent: Math.round(
        sentiment.rows[0].percent || 0
      )
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
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

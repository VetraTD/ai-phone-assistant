const express = require("express");
const router = express.Router();
const axios = require("axios");

const authenticate = require("../middleware/authMiddleware");
const pool = require("../db");
const { getBusinessIdForUser, rejectUnexpectedKeys } = require("../utils");
const { authSensitiveLimiter, sensitiveLimiter } = require("../middleware/rateLimiters");

// Appointments for the authenticated user's business with simple ranges
// GET /api/appointments?range=today|7days|upcoming
router.get("/api/appointments", authenticate, async (req, res) => {
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
              a.call_id,
              a.client_name,
              a.client_phone,
              a.scheduled_at,
              a.status,
              a.notes
       from appointments a
       where a.business_id = $1
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
router.post("/api/appointments/email", authSensitiveLimiter, sensitiveLimiter, authenticate, async (req, res) => {
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

    const allowedKeys = ["range"];
    rejectUnexpectedKeys(req.body || {}, allowedKeys);
    const rawRange = req.body?.range;
    const range = rawRange === "7days" || rawRange === "upcoming" ? rawRange : "today";
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

module.exports = router;

const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const pool = require("../db");
const { getBusinessIdForUser } = require("../utils");

// Analytics for the authenticated user's business
router.get("/api/analytics/:businessId", authenticate, async (req, res) => {
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

// Usage this month (calls count + total minutes) for Settings
router.get("/api/usage", authenticate, async (req, res) => {
  try {
    const authUserId = req.authUser.id;
    const businessId = await getBusinessIdForUser(authUserId);
    if (!businessId) {
      return res.status(403).json({ error: "No business linked to this user" });
    }

    const usageRes = await pool.query(
      `SELECT
        COUNT(*)::int AS calls_this_month,
        COALESCE(SUM(duration_seconds), 0)::bigint AS total_seconds
       FROM calls
       WHERE business_id = $1
         AND started_at >= date_trunc('month', CURRENT_DATE)
         AND started_at < date_trunc('month', CURRENT_DATE) + interval '1 month'`,
      [businessId]
    );

    const row = usageRes.rows[0];
    const callsThisMonth = Number(row?.calls_this_month ?? 0);
    const totalSeconds = Number(row?.total_seconds ?? 0);
    const minutesThisMonth = Math.floor(totalSeconds / 60);

    res.json({ calls_this_month: callsThisMonth, minutes_this_month: minutesThisMonth });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load usage" });
  }
});

// Analytics breakdown: period=7d|30d|90d, returns time buckets + totals for analytics page
router.get("/api/analytics-breakdown", authenticate, async (req, res) => {
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

    // First-time vs returning callers within the period
    const callerMixRes = await pool.query(
      `
      WITH calls_in_period AS (
        SELECT id, caller_number, started_at
        FROM calls
        WHERE business_id = $1 AND started_at >= ${since}
      ),
      first_calls AS (
        SELECT caller_number, MIN(started_at) AS first_started
        FROM calls
        WHERE business_id = $1
        GROUP BY caller_number
      )
      SELECT
        COUNT(*) FILTER (WHERE cip.started_at = fc.first_started) AS first_time,
        COUNT(*) FILTER (WHERE cip.started_at > fc.first_started) AS returning
      FROM calls_in_period cip
      JOIN first_calls fc ON fc.caller_number = cip.caller_number
      `,
      [businessId]
    );

    // Peak call hour in the period (0-23)
    const peakHourRes = await pool.query(
      `
      SELECT EXTRACT(HOUR FROM started_at)::int AS hour, COUNT(*) AS total_calls
      FROM calls
      WHERE business_id = $1 AND started_at >= ${since}
      GROUP BY EXTRACT(HOUR FROM started_at)
      ORDER BY total_calls DESC
      LIMIT 1
      `,
      [businessId]
    );

    // Calls inside vs outside typical business hours (09:00–17:00, business timezone)
    const bizTzRes = await pool.query(
      `SELECT timezone FROM businesses WHERE id = $1 LIMIT 1`,
      [businessId]
    );
    const businessTimezone = bizTzRes.rows[0]?.timezone || "America/Chicago";

    const businessHoursRes = await pool.query(
      `
      SELECT
        COUNT(*) FILTER (
          WHERE EXTRACT(HOUR FROM started_at AT TIME ZONE $2) BETWEEN 9 AND 16
        ) AS in_hours,
        COUNT(*) FILTER (
          WHERE EXTRACT(HOUR FROM started_at AT TIME ZONE $2) < 9
             OR EXTRACT(HOUR FROM started_at AT TIME ZONE $2) >= 17
        ) AS out_hours
      FROM calls
      WHERE business_id = $1 AND started_at >= ${since}
      `,
      [businessId, businessTimezone]
    );

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
      caller_mix: (() => {
        const r = callerMixRes.rows[0];
        return r
          ? { first_time: Number(r.first_time ?? 0), returning: Number(r.returning ?? 0) }
          : { first_time: 0, returning: 0 };
      })(),
      peak_hour: (() => {
        const r = peakHourRes.rows[0];
        if (!r) return null;
        return { hour: Number(r.hour ?? 0), calls: Number(r.total_calls ?? 0) };
      })(),
      business_hours: (() => {
        const r = businessHoursRes.rows[0];
        if (!r) return { in_hours: 0, out_hours: 0, timezone: businessTimezone };
        return {
          in_hours: Number(r.in_hours ?? 0),
          out_hours: Number(r.out_hours ?? 0),
          timezone: businessTimezone,
        };
      })(),
      calls_by_weekday: byWeekday,
      period,
    });
  } catch (err) {
    console.error("analytics-breakdown failed:", err);
    res.status(500).json({ error: "Failed to load analytics breakdown" });
  }
});

module.exports = router;

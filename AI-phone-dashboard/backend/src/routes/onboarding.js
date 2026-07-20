const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const pool = require("../db");
const { sanitizeString } = require("../utils");
const { ALLOWED_TIMEZONES } = require("../constants");

router.get("/api/me", authenticate, async (req, res) => {
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

// Create the business for a freshly-signed-up user. Only `name`/`timezone`
// are recognized — any other keys (e.g. the pre-Phase-4B onboarding step 2's
// `default_language`) are silently ignored rather than rejected, matching
// the same unknown-key tolerance as PUT /api/business/:id/settings.
router.post("/api/onboarding/create-business", authenticate, async (req, res) => {
  try {
    const userId = req.authUser.id;
    const body = req.body && typeof req.body === "object" ? req.body : {};

    const unknownKeys = Object.keys(body).filter((k) => k !== "name" && k !== "timezone");
    if (unknownKeys.length) {
      console.warn(`create-business: ignoring unknown keys [${unknownKeys.join(", ")}]`);
    }

    const name = sanitizeString(body.name, 120);
    const timezone = sanitizeString(body.timezone, 64);

    if (!name || !timezone) {
      return res.status(400).json({ error: "Name and timezone are required." });
    }
    if (!ALLOWED_TIMEZONES.includes(timezone)) {
      return res.status(400).json({ error: "Timezone is not supported." });
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

module.exports = router;

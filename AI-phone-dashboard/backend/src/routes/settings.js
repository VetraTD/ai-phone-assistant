const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const pool = require("../db");
const { getBusinessIdForUser, buildUpdateFromWhitelist } = require("../utils");
const { SETTINGS_FIELD_VALIDATORS } = require("../settingsValidation");
const { authSensitiveLimiter } = require("../middleware/rateLimiters");

// Get a business by id (must match authenticated user's business)
// /api/businesses/:id
router.get("/api/businesses/:id", authenticate, async (req, res) => {
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

// Update business settings — dynamic UPDATE built only from whitelisted,
// validated keys (see settingsValidation.js SETTINGS_FIELD_VALIDATORS).
// Unknown/unexpected keys (e.g. the old frontend's `default_language` and
// the address_line1/2, city, state_region, postal_code columns dropped by
// migration 012) are ignored rather than rejected or 500ing — this keeps
// the endpoint working for the pre-Phase-4B frontend. Column names in the
// SET clause come only from SETTINGS_FIELD_VALIDATORS's own key set (never
// from request input) and every value is bound as a parameter — never
// string-interpolated — so this stays injection-safe even though the set of
// columns updated varies per request.
router.put("/api/business/:id/settings", authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Ensure the authenticated user actually owns this business
    const authUserId = req.authUser.id;
    const userBusinessId = await getBusinessIdForUser(authUserId);
    if (!userBusinessId || userBusinessId !== id) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const built = buildUpdateFromWhitelist(SETTINGS_FIELD_VALIDATORS, req.body);
    if (built.error) {
      return res.status(400).json({ error: built.error });
    }

    if (built.unknownKeys.length) {
      console.warn(
        `settings update: ignoring unknown keys [${built.unknownKeys.join(", ")}] for business ${id}`
      );
    }

    if (!built.setClauses.length) {
      // Nothing recognized to update (e.g. request contained only unknown
      // legacy keys) — return the current row unchanged rather than issuing
      // a no-op UPDATE with an empty SET clause.
      const current = await pool.query(`SELECT * FROM businesses WHERE id = $1`, [id]);
      return res.json(current.rows[0] || null);
    }

    const params = [...built.params, id];
    const sql = `UPDATE businesses SET ${built.setClauses.join(", ")} WHERE id = $${params.length} RETURNING *`;
    const result = await pool.query(sql, params);

    res.json(result.rows[0]);
  } catch (err) {
    console.error("settings update failed:", err);
    res.status(500).json({ error: "Failed to update settings" });
  }
});

// ---------------------------------------------------------------------------
// Integrations API (list, create/update, definitions) — configured from the
// dashboard's Settings page, kept alongside the other settings routes.
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

router.get("/api/integrations/definitions", (req, res) => {
  res.json(INTEGRATION_DEFINITIONS);
});

router.get("/api/integrations", authenticate, async (req, res) => {
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

router.post("/api/integrations", authSensitiveLimiter, authenticate, async (req, res) => {
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

router.delete("/api/integrations/:id", authSensitiveLimiter, authenticate, async (req, res) => {
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

module.exports = router;

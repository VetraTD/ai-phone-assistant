const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const pool = require("../db");
const { getBusinessIdForUser } = require("../utils");
const schemas = require("../generated/capabilitySchemas.json");
const { validateCapabilityConfig } = require("../capabilityConfigValidation");

/**
 * Capability settings.
 *
 * The definitions below are GENERATED from the capability registry
 * (scripts/export-capability-schemas.js) because this app is CommonJS and
 * cannot import the ESM packs. A test in the root suite fails when the
 * committed file drifts from the live registry, so a capability can never
 * quietly lose its settings section.
 */

/** Ids the registry actually knows about — the whitelist for writes. */
const CAPABILITY_IDS = new Set(schemas.capabilities.map((c) => c.id));
const CORE_IDS = new Set(schemas.capabilities.filter((c) => c.core).map((c) => c.id));
const ADAPTERS_BY_CAPABILITY = new Map(
  schemas.capabilities
    .filter((c) => c.adapterKind === "scheduling")
    .map((c) => [c.id, new Set(schemas.adapters.scheduling.map((a) => a.id))])
);

// What the settings UI renders from. Public: it is a description of the
// product's shape, contains no tenant data, and the frontend needs it before
// a business is even selected.
router.get("/api/capabilities/definitions", (req, res) => {
  res.json(schemas);
});

/**
 * This business's capability rows.
 *
 * Returns a row per KNOWN capability, whether or not one exists in the table,
 * so the UI renders a complete screen rather than only the parts someone has
 * touched before. `configured` distinguishes a stored row from a default —
 * without it the UI could not tell "explicitly off" from "never set up", which
 * is exactly the ambiguity migration 020 existed to remove.
 */
router.get("/api/business/:id/capabilities", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const userBusinessId = await getBusinessIdForUser(req.authUser.id);
    if (!userBusinessId) return res.status(403).json({ error: "No business linked to this user" });
    if (id !== userBusinessId) return res.status(403).json({ error: "Forbidden" });

    const r = await pool.query(
      `select capability_id, enabled, adapter, adapter_config, config
         from business_capabilities
        where business_id = $1`,
      [id]
    );
    const stored = new Map(r.rows.map((row) => [row.capability_id, row]));

    const capabilities = schemas.capabilities.map((def) => {
      const row = stored.get(def.id);
      return {
        capability_id: def.id,
        // Core capabilities are on regardless of what any row says; a row
        // claiming otherwise would describe something that cannot happen.
        enabled: def.core ? true : row ? row.enabled : false,
        adapter: row?.adapter ?? null,
        adapter_config: row?.adapter_config ?? {},
        config: row?.config ?? {},
        configured: !!row,
      };
    });

    res.json({ capabilities });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Upsert one capability's settings.
 *
 * Per capability rather than a bulk save: each section of the UI saves itself,
 * so a validation failure in one capability cannot discard edits made to
 * another.
 */
router.put("/api/business/:id/capabilities/:capabilityId", authenticate, async (req, res) => {
  try {
    const { id, capabilityId } = req.params;

    const userBusinessId = await getBusinessIdForUser(req.authUser.id);
    if (!userBusinessId) return res.status(403).json({ error: "No business linked to this user" });
    if (id !== userBusinessId) return res.status(403).json({ error: "Forbidden" });

    if (!CAPABILITY_IDS.has(capabilityId)) {
      return res.status(404).json({ error: "Unknown capability" });
    }
    if (CORE_IDS.has(capabilityId) && req.body?.enabled === false) {
      // Message-taking and transfer are the receptionist's floor: every other
      // capability falls back to them when a tool fails or an answer is
      // unknown. Storing "off" would describe a state the engine will not honor.
      return res.status(400).json({ error: "This capability is always on and cannot be disabled" });
    }

    const enabled = req.body?.enabled !== false;

    const allowedAdapters = ADAPTERS_BY_CAPABILITY.get(capabilityId);
    let adapter = req.body?.adapter ?? null;
    if (adapter !== null) {
      if (!allowedAdapters || !allowedAdapters.has(adapter)) {
        // Routing at a backend that does not exist fails mid-call, after the
        // caller has already given their details.
        return res.status(400).json({ error: `Unknown adapter for ${capabilityId}` });
      }
    }

    const { config, errors } = validateCapabilityConfig(req.body?.config, capabilityId, schemas);
    if (errors.length > 0) {
      // Rejected outright rather than silently dropped. The engine's loader is
      // deliberately forgiving because it runs mid-call and must not fail a
      // caller over a bad setting — but here there is a human watching who can
      // fix it, and telling them is far better than saving something that
      // quietly does nothing.
      return res.status(400).json({ error: errors[0], errors });
    }

    await pool.query(
      `insert into business_capabilities
         (business_id, capability_id, enabled, adapter, adapter_config, config, updated_at)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, now())
       on conflict (business_id, capability_id) do update
         set enabled = excluded.enabled,
             adapter = excluded.adapter,
             adapter_config = excluded.adapter_config,
             config = excluded.config,
             updated_at = now()`,
      [
        id,
        capabilityId,
        enabled,
        adapter,
        JSON.stringify(req.body?.adapter_config ?? {}),
        JSON.stringify(config),
      ]
    );

    res.json({ ok: true, capability_id: capabilityId, enabled, adapter, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

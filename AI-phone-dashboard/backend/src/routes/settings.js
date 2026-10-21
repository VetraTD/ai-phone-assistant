const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const pool = require("../db");
const { buildUpdateFromWhitelist, getBusinessIdForUser } = require("../utils");
const { withTenantHandler } = require("../middleware/withTenantHandler");
const { SETTINGS_FIELD_VALIDATORS } = require("../settingsValidation");
const { authSensitiveLimiter } = require("../middleware/rateLimiters");
const voiceClient = require("../services/voiceClient");

// dialCost.mjs is ESM (a byte-identical copy of the root repo's lib/dialCost.js);
// this package is CommonJS, so it is loaded once with a cached dynamic import.
let dialCostPromise;
const loadDialCost = () =>
  (dialCostPromise ??= import("../dialCost.mjs").catch((e) => {
    dialCostPromise = undefined; // a failed load must not be cached forever
    throw e;
  }));

// Get a business by id (must match authenticated user's business)
// /api/businesses/:id
router.get("/api/businesses/:id", authenticate, withTenantHandler(async (req, res) => {
  try {
    const userBusinessId = req.businessId;

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
}));

// Columns that change the recorded greeting (mirrors what the voice server
// re-renders on: greeting, voice, language, pronunciations, name, the
// recording disclosure and the timezone the time-of-day opener uses).
const GREETING_CLIP_COLUMNS = [
  "greeting",
  "live_voice",
  "locale",
  "pronunciations",
  "name",
  "recording_disclosure_enabled",
  "recording_disclosure_text",
  "timezone",
];

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
router.put("/api/business/:id/settings", authenticate, withTenantHandler(async (req, res) => {
  try {
    const { id } = req.params;

    // Ensure the authenticated user actually owns this business
    const userBusinessId = req.businessId;
    if (!userBusinessId || userBusinessId !== id) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const built = buildUpdateFromWhitelist(SETTINGS_FIELD_VALIDATORS, req.body);
    if (built.error) {
      return res.status(400).json({ error: built.error });
    }

    // Number block: a number we will dial (transfer) or text (notification)
    // must pass the price check. The NORMALISED value the whitelist produced
    // is what is checked. Clearing a number is always allowed. Only VetraTD
    // can switch pricier numbers on, so allow_pricier_numbers is deliberately
    // NOT in SETTINGS_FIELD_VALIDATORS and is read here, never written.
    const valueOf = (field) => {
      const i = built.setClauses.findIndex((c) => c.startsWith(`${field} = `));
      return i === -1 ? undefined : built.params[i];
    };
    const transferTo = valueOf("transfer_phone_number");
    const notifyTo = valueOf("notification_phone");
    const hasTransfer = typeof transferTo === "string" && transferTo !== "";
    const hasNotify = typeof notifyTo === "string" && notifyTo !== "";
    if (hasTransfer || hasNotify) {
      const { checkDial, checkText, REFUSAL_MESSAGES } = await loadDialCost();
      const flagRow = await pool.query(`SELECT allow_pricier_numbers FROM businesses WHERE id = $1`, [id]);
      const allowPricier = flagRow.rows[0]?.allow_pricier_numbers === true;
      if (hasTransfer) {
        const dest = checkDial(transferTo, { allowPricier });
        if (!dest.ok) return res.status(400).json({ error: `transfer_phone_number: ${REFUSAL_MESSAGES[dest.reason]}` });
      }
      if (hasNotify) {
        const dest = checkText(notifyTo);
        if (!dest.ok) return res.status(400).json({ error: `notification_phone: ${REFUSAL_MESSAGES[dest.reason]}` });
      }
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

    // Anything that changes the recorded greeting callers hear: ask the voice
    // server to re-render it now, so the first call after a save doesn't pay
    // for it. Fire-and-forget -- the clip is also re-rendered on demand, so a
    // failure here must never change what the owner sees from their save.
    const updatedColumns = built.setClauses.map((c) => c.split(" = ")[0]);
    if (updatedColumns.some((c) => GREETING_CLIP_COLUMNS.includes(c))) {
      // Deferred to AFTER COMMIT (withTenantHandler runs this handler inside the
      // transaction): fired inline, the voice server could read the business
      // before the commit and render the OLD greeting. Not awaited by the
      // request either -- the hook only starts the call, it never blocks it.
      req.afterCommit?.push(() => {
        try {
          Promise.resolve(voiceClient.postGreetingClip(id)).catch((e) =>
            console.warn(`greeting clip re-render failed for business ${id}:`, e?.message || e)
          );
        } catch (e) {
          console.warn(`greeting clip re-render failed for business ${id}:`, e?.message || e);
        }
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("settings update failed:", err);
    res.status(500).json({ error: "Failed to update settings" });
  }
}));

// The recorded greeting exactly as callers hear it, for the "Hear greeting"
// button. Rendered by the voice server (re-rendered first if anything it
// depends on changed); this route only authenticates and proxies the bytes.
//
// DELIBERATELY NOT withTenantHandler: that holds a database transaction (and a
// pooled connection, pool size 10) for the whole handler, and this one waits up
// to 2 x 15 s on the voice server. The tenant is resolved with one plain lookup
// and nothing here touches a tenant table, so no transaction is needed.
router.get("/api/business/:id/greeting-clip", authenticate, async (req, res) => {
  const { id } = req.params;
  let businessId;
  try {
    businessId = await getBusinessIdForUser(req.authUser);
  } catch (err) {
    console.error("greeting clip tenant lookup failed:", err?.message || err);
    return res.status(500).json({ error: "Failed to look up your business" });
  }
  if (!businessId) {
    return res.status(403).json({ error: "No business linked to this user" });
  }
  if (businessId !== id) {
    return res.status(403).json({ error: "Forbidden" });
  }
  let result;
  try {
    result = await voiceClient.postGreetingClip(id);
  } catch (err) {
    console.warn("greeting clip fetch failed:", err?.message || err);
    result = { status: 502, audio: null };
  }
  if (result.status === 200 && result.audio) {
    res.type("audio/wav");
    res.set("Cache-Control", "no-store");
    return res.send(result.audio);
  }
  if (result.status === 503) {
    return res.status(503).json({ error: "Greeting preview isn't available yet." });
  }
  return res.status(502).json({ error: "Couldn't make the greeting recording. Try again in a minute." });
});

// ---------------------------------------------------------------------------
// Voice catalog (dashboard voice picker) — mirrors root repo config/voices.js
// VOICE_CATALOG by hand. This dashboard backend is a separate deployable app
// and cannot import across the apps/ package boundary (same constraint
// constants.js's header comment documents for the enum lists it mirrors) —
// keep this in sync when config/voices.js changes. Only the fields the
// picker UI needs are exposed; `voiceSettings` (stability/similarity_boost
// tuning) stays internal to lib/voice/session.js's resolveVoice() and isn't
// relevant to the dashboard. `voiceId` values must stay in sync with
// constants.js's ELEVENLABS_VOICE_IDS, which settingsValidation.js validates
// against on save.
// ---------------------------------------------------------------------------
const VOICE_CATALOG = [
  { id: "bella", voiceId: "hpp4J3VqNfWAUOO0d1Us", label: "Bella", description: "Warm and professional. A polished front-desk voice.", gender: "female", accent: "american", previewText: "Thanks so much for calling — how can I help you today?" },
  { id: "sarah", voiceId: "EXAVITQu4vr4xnSDxMaL", label: "Sarah", description: "Bright and professional, with a youthful energy — great for busy front desks.", gender: "female", accent: "american", previewText: "Hi there, thanks for calling! What can I help you with?" },
  { id: "matilda", voiceId: "XrExE9yKIg1WjnnlVkGX", label: "Matilda", description: "Upbeat and energetic — a friendly voice that puts callers at ease.", gender: "female", accent: "american", previewText: "Hey! Thanks for calling — how can I help you out today?" },
  { id: "alice", voiceId: "Xb7hH8MSUJpSbSDYk0k2", label: "Alice", description: "Polished and professional, with a crisp British accent.", gender: "female", accent: "british", previewText: "Good afternoon, thank you for calling — how may I help you?" },
  { id: "eric", voiceId: "cjVigY5qzO86Huf0OWal", label: "Eric", description: "Smooth and classy — a confident voice for a professional front desk.", gender: "male", accent: "american", previewText: "Thanks for calling — this is our assistant. How can I help you today?" },
  { id: "roger", voiceId: "CwhRBWXzGAHq8TQ4Fs17", label: "Roger", description: "Warm and classy, with an easy confidence that puts callers at ease.", gender: "male", accent: "american", previewText: "Hey there, thanks for giving us a call — what can I do for you?" },
  { id: "daniel", voiceId: "onwK4e9ZLuTAKqWW03F9", label: "Daniel", description: "Formal and precise, with a distinguished British accent.", gender: "male", accent: "british", previewText: "Good day, thank you for calling. How may I assist you?" },
  { id: "river", voiceId: "SAz9YHcvj6GT2YYXdXww", label: "River", description: "Calm and steady — an easygoing voice that keeps callers relaxed.", gender: "neutral", accent: "american", previewText: "Hi, thanks for calling — how can I help you today?" },
];

// Public catalog listing, same access pattern as /api/integrations/definitions
// below (no auth — static reference data, nothing business-specific).
router.get("/api/voices", (req, res) => {
  res.json(VOICE_CATALOG);
});

// ---------------------------------------------------------------------------
// LVX84: the catalogue for the front-end that actually answers the phone.
//
// A SEPARATE ROUTE rather than a wider /api/voices, because that one returns a
// bare array and the picker and its parity test both read it positionally.
//
// EVERY ENTRY CARRIES ITS EVIDENCE, and that is the point of the shape. This
// list is not a vendor catalogue — it is scripts/voice-compare.js's candidate
// set, and two of the five have already been heard on a real phone call and
// found wanting. The rig renders 24 kHz WAV files; a phone call is mu-law 8 kHz
// and throws away everything above about 3.4 kHz, which is where a lot of a
// voice's character lives. So a file comparison NARROWS the list and cannot
// pick the winner.
//
// Showing that in the picker is deliberate. An owner choosing blind from five
// names would re-run an experiment that has already been run twice, and a
// preference chosen without evidence gets written down as a decision.
// ---------------------------------------------------------------------------
const LIVE_VOICE_CATALOG = [
  {
    name: "Kore",
    label: "Kore",
    evidence:
      "Currently the default for every language. Picked from the rendered files, then reported as not the best quality over the phone — good on the WAV, muffled on a call.",
  },
  {
    name: "Puck",
    label: "Puck",
    evidence: "Rendered as a candidate. Never heard on a real call.",
  },
  {
    name: "Charon",
    label: "Charon",
    evidence: "Rendered as a candidate. Never heard on a real call.",
  },
  {
    name: "Aoede",
    label: "Aoede",
    evidence: "Tried on a real call on the strength of the rendered file, and rejected after four turns.",
  },
  {
    name: "Leda",
    label: "Leda",
    evidence: "Rendered as a candidate. Never heard on a real call.",
  },
];

// The accent and language the voice is pinned to. Three, and only three: each
// id needs a full profile in the root repo (STT language, date style, currency,
// phone grouping, ringback) and the column's CHECK constraint enforces the set.
const LOCALE_CATALOG = [
  { id: "en-GB", label: "British English", description: "British accent and phrasing. Dates as day/month." },
  { id: "en-US", label: "American English", description: "American accent and phrasing. Dates as month/day." },
  { id: "es-US", label: "Spanish (US)", description: "Spanish, for callers served from a US number." },
];

router.get("/api/live-voices", (req, res) => {
  res.json({
    // WHICH FRONT-END IS SERVING, declared rather than derived.
    //
    // The dashboard genuinely cannot work this out: Live versus cascade is
    // decided by the Twilio number's voiceUrl (/twilio/live-voice against
    // /twilio/voice), which lives at Twilio and is not in this database.
    // Guessing it from anything in here would be a second LVX84 — a control
    // that looks informed and is not.
    frontend: (process.env.VOICE_FRONTEND || "live").trim() === "cascade" ? "cascade" : "live",
    voices: LIVE_VOICE_CATALOG,
    locales: LOCALE_CATALOG,
  });
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

/**
 * Tool names an integration may not claim.
 *
 * MIRROR of services/db.js BUILTIN_TOOL_NAMES in the main app, which
 * derives this from the capability registry (capabilities/index.js). This
 * dashboard is a separate CJS app with its own package.json and cannot import
 * that ESM module, so the list is duplicated by hand.
 *
 * KEEP IN SYNC. Both are write paths for the integrations table: a name
 * rejected by one but accepted by the other still produces the bug this list
 * exists to prevent — a webhook whose declaration reaches Gemini alongside an
 * identically-named builtin, where the builtin wins and the operator's webhook
 * silently never runs.
 *
 * Adding a capability pack means adding its tool names here.
 */
const BUILTIN_TOOL_NAMES = [
  // engine-owned
  "set_call_intent",
  "end_call",
  // OUTBOUND CALLING, Task 18 (spec §9.6): the third engine-owned tool,
  // declared only on an outbound call.
  "confirm_identity",
  // 2026-10-01 (spec 2026-10-01-outbound-live-first-line §4): the fourth,
  // outbound live mode only (hold / transfer).
  "wait_on_hold",
  // appointments pack
  "book_appointment",
  "check_appointment_availability",
  "get_caller_appointments",
  "get_available_slots",
  "book_appointment_in_ehr",
  "cancel_appointment",
  "reschedule_appointment",
  "get_caller_appointments_from_db",
  "cancel_appointment_db",
  "reschedule_appointment_db",
  "correct_appointment_name",
  "add_appointment_note",
  // messages pack
  "record_customer_request",
  // quotes pack
  "record_quote_request",
  // transfer pack
  "request_transfer",
  // sms_consent pack
  "record_sms_consent",
  // S3-3: outcome/callback/opt_out packs -- platform packs, declared on
  // every outbound call regardless of tenant config (lib/outbound/policy.js
  // PLATFORM_PACKS), never on inbound.
  "set_call_outcome",
  "schedule_callback",
  "opt_out",
  // S3-10: qualification pack -- a campaign pack, declared only when the
  // campaign lists it, never on inbound.
  "record_answer",
];

router.get("/api/integrations/definitions", (req, res) => {
  res.json(INTEGRATION_DEFINITIONS);
});

router.get("/api/integrations", authenticate, withTenantHandler(async (req, res) => {
  try {
    const userBusinessId = req.businessId;
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
}));

router.post("/api/integrations", authSensitiveLimiter, authenticate, withTenantHandler(async (req, res) => {
  try {
    const userBusinessId = req.businessId;
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
}));

router.delete("/api/integrations/:id", authSensitiveLimiter, authenticate, withTenantHandler(async (req, res) => {
  try {
    const userBusinessId = req.businessId;
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
}));

module.exports = router;

const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const db = require("../db");
const { sanitizeString, getBusinessIdForUser } = require("../utils");
const { ALLOWED_TIMEZONES } = require("../constants");

// ---------------------------------------------------------------------------
// The two routes that CANNOT be wrapped in withTenantHandler, because they run
// before there is a tenant — they are how one comes to exist.
//
// Both went through migration 031's bootstrap rather than through a policy
// permitting unscoped access. Migration 029 argues that case for reads; it is
// stronger for writes, where "forgot to scope" would mean "may write anything,
// to any tenant".
// ---------------------------------------------------------------------------

router.get("/api/me", authenticate, async (req, res) => {
  try {
    const authUserId = req.authUser.id;

    // Through app_lookup_user_by_email (migration 029). A direct select on
    // `users` is RLS'd and returns nothing before a tenant is set, so every
    // account would have looked brand new and been sent back to onboarding —
    // which, for an existing clinic, would have offered to create a SECOND
    // business rather than showing them theirs.
    const businessId = await getBusinessIdForUser(req.authUser);
    if (!businessId) {
      return res.json({ authUserId, needsOnboarding: true });
    }

    // Scoped: by here the tenant IS known, so the businesses read needs no
    // definer function of its own. Adding a third one for a read that can be
    // scoped would widen the bootstrap surface for no reason.
    const businessRes = await db.withTenant(businessId, () =>
      db.query(`select * from businesses where id = $1`, [businessId])
    );

    return res.json({
      authUserId,
      needsOnboarding: false,
      business: businessRes.rows[0] || null,
    });
  } catch (err) {
    console.error("me lookup failed:", err?.message);
    return res.status(500).json({ error: "Failed to load account" });
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
    if (!email) {
      return res.status(400).json({ error: "Account has no email address." });
    }

    // ONE call, doing what used to be three separate statements.
    //
    // The old sequence inserted a `users` row with a NULL business_id, inserted
    // a `businesses` row, then linked them — three writes that each violate
    // their own WITH CHECK under FORCE row security, because none of them has a
    // tenant to be checked against. It was not a scoping mistake that could be
    // fixed by opening a scope: the operation is what CREATES the scope.
    //
    // Doing it in one statement also removes a state the old version could get
    // stuck in — a users row with no business, left behind whenever step 2 or 3
    // failed — and the function refuses outright if the account already has a
    // business, which the old route did not check at all.
    const r = await db.query(`select * from app_create_business_for_user($1, $2, $3, $4)`, [
      userId,
      email,
      name,
      timezone,
    ]);

    return res.json({ business: r.rows[0] });
  } catch (err) {
    // 23505 is the function's own "already belongs to a business". A second
    // signup attempt is a conflict, not a server fault.
    if (err?.code === "23505") {
      return res.status(409).json({ error: "This account already has a business." });
    }
    console.error("create-business failed:", err?.message);
    return res.status(500).json({ error: "Failed to create business" });
  }
});

module.exports = router;

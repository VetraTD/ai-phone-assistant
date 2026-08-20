import { bearerFromHeader, verifyAccessToken } from "../lib/auth/accessToken.js";
import { fetchUserByEmail } from "../services/supabase.js";
import { log } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// The guard in front of every route that names a business in its path.
//
// Two questions, in order, and the order matters:
//
//   1. Who is calling?          -> no answer means 401
//   2. Is this their business?  -> wrong answer means 403
//
// 401 and 403 are kept distinct on purpose. They are different facts: "you did
// not authenticate" and "you authenticated as someone who does not own this".
// Collapsing them would hide tenant-isolation failures inside what looks like a
// login problem.
//
// Runs BEFORE the handler, so a rejected request cannot reach a Twilio call on
// its way to being rejected. `POST .../phone-numbers/buy` spends real money;
// returning 401 after the purchase would satisfy the status-code assertion and
// still cost the owner a phone number.
// ---------------------------------------------------------------------------

/**
 * Express middleware. On success attaches `req.user = { email, businessId }`.
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
export async function requireBusinessAccess(req, res, next) {
  const token = bearerFromHeader(req.get("authorization"));
  if (!token) return res.status(401).json({ error: "Authentication required" });

  const identity = await verifyAccessToken(token);
  if (!identity) return res.status(401).json({ error: "Authentication required" });

  const user = await fetchUserByEmail(identity.email);
  if (!user?.business_id) {
    // Authenticated against the auth backend, but carrying no staff row — a
    // signed-up account that was never attached to a business. Not a login
    // failure, so not a 401.
    return res.status(403).json({ error: "Forbidden" });
  }

  const requested = req.params.id;
  if (requested && requested !== user.business_id) {
    // The audit trail that matters: someone with a valid session reaching for
    // another tenant. Emails are workforce identifiers, not PHI.
    log.error("cross_tenant_denied", {
      email: identity.email,
      requested,
      owned: user.business_id,
      path: req.path,
      severity: "warn",
    });
    return res.status(403).json({ error: "Forbidden" });
  }

  req.user = { email: identity.email, businessId: user.business_id };
  return next();
}

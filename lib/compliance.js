import { IS_HIPAA_MODE, DEPLOYMENT_MODE } from "./deploymentMode.js";
import { log } from "./logger.js";

/**
 * Which vendors may see PHI, and which may not.
 *
 * ---------------------------------------------------------------------------
 * The property this exists to make structural
 * ---------------------------------------------------------------------------
 *
 * The two-region design puts the US HIPAA stack in its own GCP project so that
 * `voice-us` HOLDS NO ELEVENLABS KEY. A misconfiguration there yields
 * voicemail, not a reportable disclosure — because the credential is simply
 * absent, not because anybody remembered a rule.
 *
 * That is the strong version and it lands at B4, when secrets move to per-
 * project Secret Manager. This module is the software half, and it exists
 * because the gap between now and B4 is where a key gets copied into the wrong
 * environment by someone in a hurry.
 *
 * ---------------------------------------------------------------------------
 * Where the guard sits, and why it is not at the policy layer
 * ---------------------------------------------------------------------------
 *
 * At CLIENT CONSTRUCTION. Not at provider selection, not behind the circuit
 * breaker, not in a config check — because every one of those is a decision
 * that some other code path can be routed around. The TTS layer already has
 * several such paths: a per-business voice_provider column, a `forceFallback`
 * argument, and a breaker that flips providers mid-call. A guard in any one of
 * them is a guard with three doors next to it.
 *
 * A refusal inside the constructor cannot be routed around, which is why the
 * gate is worded the way it is: `hipaa` mode cannot construct a non-covered
 * vendor client INCLUDING WITH THE BREAKER OPEN.
 */

/**
 * Vendors with no BAA, keyed by the credential that would let them be used.
 *
 * `google` is deliberately absent: Vertex, Speech-to-Text and Text-to-Speech
 * are all covered by the Google Cloud BAA accepted 2026-08-20 (ledger O3b).
 * Twilio is absent too — its BAA is O5, and a Twilio call is how a caller
 * reaches the system at all, so blocking it would not be failing closed, it
 * would be turning the phone off.
 */
export const NON_COVERED_VENDORS = Object.freeze({
  elevenlabs: {
    label: "ElevenLabs",
    credentials: ["ELEVENLABS_API_KEY"],
    covered: "Google Cloud Text-to-Speech",
  },
  deepgram: {
    label: "Deepgram",
    credentials: ["DEEPGRAM_API_KEY"],
    covered: "Google Cloud Speech-to-Text v2",
  },
  brevo: {
    label: "Brevo",
    credentials: ["BREVO_API_KEY"],
    covered: "no covered equivalent — A1.3 removed PHI from email entirely",
  },
});

/**
 * Thrown when a non-covered vendor client is constructed in `hipaa` mode.
 *
 * A distinct class so callers can fail closed on THIS specifically rather than
 * catching everything and treating a compliance refusal as a transient vendor
 * error — which would put it straight into the circuit breaker's retry logic
 * and turn a hard stop into a delay.
 */
export class ComplianceViolationError extends Error {
  constructor(vendor) {
    const v = NON_COVERED_VENDORS[vendor];
    super(
      `DEPLOYMENT_MODE=hipaa: refusing to construct a ${v?.label ?? vendor} client. ` +
        `No BAA covers it. Use ${v?.covered ?? "a covered vendor"}.`
    );
    this.name = "ComplianceViolationError";
    this.vendor = vendor;
    /** Marks this as a policy refusal, not a vendor outage. */
    this.compliance = true;
  }
}

/**
 * Refuse to build a client for a non-covered vendor in `hipaa` mode.
 *
 * Throws rather than returning false, because the call sites are constructors
 * and a return value is something a caller can ignore. In `standard` mode it
 * does nothing at all.
 *
 * @param {keyof typeof NON_COVERED_VENDORS} vendor
 * @param {{ callSid?: string }} [ctx]
 */
export function assertVendorAllowed(vendor, ctx = {}) {
  if (!IS_HIPAA_MODE) return;
  if (!NON_COVERED_VENDORS[vendor]) return;

  // Logged before throwing. A refusal that is only visible as a caught
  // exception somewhere else is a refusal nobody can audit, and this is
  // exactly the event a §164.312 audit wants to see.
  log.error("compliance_vendor_refused", {
    callSid: ctx.callSid ?? null,
    vendor,
    mode: DEPLOYMENT_MODE,
    severity: "warn",
  });
  throw new ComplianceViolationError(vendor);
}

/** True when this vendor may be used in the current mode. */
export function isVendorAllowed(vendor) {
  return !IS_HIPAA_MODE || !NON_COVERED_VENDORS[vendor];
}

/**
 * The tier a call actually runs under.
 *
 * The STRICTER of the deployment and the tenant, never the tenant alone. A
 * tenant row is data, and data is editable by anyone with dashboard access; if
 * a `standard` row could relax a `hipaa` deployment, the compliance posture of
 * the whole stack would be one UPDATE statement away from gone.
 *
 * The reverse direction is allowed and useful: a `standard` deployment can host
 * a tenant marked `hipaa` and will treat that tenant's calls as covered. That
 * is the ratchet — it only ever tightens.
 *
 * @param {{ compliance_tier?: string|null }|null} business
 * @returns {"standard"|"hipaa"}
 */
export function effectiveTier(business) {
  const tenant = String(business?.compliance_tier || "").trim().toLowerCase();
  if (IS_HIPAA_MODE || tenant === "hipaa") return "hipaa";
  return "standard";
}

/**
 * Credentials for non-covered vendors that are present when they should not be.
 *
 * Used by the boot check. In a correctly-built `hipaa` stack this returns
 * nothing, because the credential was never put in the project — the presence
 * of one means the project isolation that the whole two-region design rests on
 * has already been breached, whatever the code does afterwards.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {Array<{vendor: string, credential: string}>}
 */
export function nonCoveredCredentialsPresent(env = process.env) {
  const found = [];
  for (const [vendor, spec] of Object.entries(NON_COVERED_VENDORS)) {
    for (const credential of spec.credentials) {
      const v = env[credential];
      if (typeof v === "string" && v.trim() !== "") found.push({ vendor, credential });
    }
  }
  return found;
}

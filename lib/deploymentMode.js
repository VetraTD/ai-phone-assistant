/**
 * Which compliance regime this process is running under.
 *
 * A deployment-level fact, not a per-tenant one: it says what the STACK is
 * allowed to do. The two-region design puts the US HIPAA stack in its own GCP
 * project precisely so this is structural — `voice-us` holds no ElevenLabs key,
 * so a misconfiguration there yields voicemail rather than a reportable
 * disclosure. This module is the software-side half of the same idea, for the
 * decisions a project boundary cannot make.
 *
 * A6 grows this: `businesses.compliance_tier` for per-tenant policy, a boot
 * credential assertion, a per-call tripwire, and mode-aware TTS that fails
 * closed. This is the minimum that A1.6 needs, deliberately kept small so A6
 * builds on it rather than around it.
 */

/** Every mode the code knows about. An unrecognised value is a typo, not a mode. */
export const MODES = Object.freeze(["standard", "hipaa"]);

const raw = (process.env.DEPLOYMENT_MODE || "").trim().toLowerCase();

/**
 * The mode this process is in.
 *
 * Unset defaults to `standard`, which is the honest default: HIPAA obligations
 * follow a signed BAA and a covered entity, not an environment variable, and a
 * stack that quietly claims to be HIPAA-compliant because nobody set a variable
 * would be worse than one that admits it is not.
 *
 * A value that is set but unrecognised is neither — see `isRecognised`. It is
 * refused at boot rather than silently falling back to `standard`, because the
 * fallback direction is the unsafe one: `DEPLOYMENT_MODE=hippa` would disable
 * every protection in this file while reading, at a glance, as if it enabled
 * them.
 */
export const DEPLOYMENT_MODE = raw === "" ? "standard" : raw;

/** False when DEPLOYMENT_MODE is set to something not in MODES. */
export const isRecognised = MODES.includes(DEPLOYMENT_MODE);

/** True only in an explicitly HIPAA deployment. */
export const IS_HIPAA_MODE = DEPLOYMENT_MODE === "hipaa";

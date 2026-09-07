/** Tier 1. Decided; see the header. Overridable so a withdrawal is a variable. */
export const LIVE_MODEL_DEFAULT = "gemini-3.1-flash-live-preview";

/**
 * Which surface serves the Live session.
 *
 * Defaults to AI Studio because that is the only place the tier-1 model exists.
 * An unrecognised value resolves to the default rather than throwing: this is
 * read while a caller is on the line, and a typo in a deploy variable should
 * not be the thing that drops the call.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {"aistudio"|"vertex"}
 */
export function liveSurface(env = process.env) {
  return String(env.LIVE_SURFACE || "").trim().toLowerCase() === "vertex" ? "vertex" : "aistudio";
}

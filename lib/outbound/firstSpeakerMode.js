/**
 * OUTBOUND_FIRST_SPEAKER -> which first-seconds mode an outbound call runs.
 *
 * 2026-10-01 (spec 2026-10-01-outbound-live-first-line-design.md §2): `live`
 * is the default -- the AI's own live reply is the first thing the person
 * hears (lib/outbound/liveFirstLine.js). `clip` is the pre-2026-10-01
 * behaviour, unchanged (lib/outbound/firstSeconds.js), kept as a one-setting
 * rollback. An unrecognised value fails to `clip` -- the behaviour that has
 * taken real calls -- never to the new path, with a WARN log, so a typo can
 * never silently pick the path nobody chose.
 *
 * Shared by the Live engine (lib/voice/live/index.js) and dispatch
 * (lib/outbound/dispatch.js), so both always agree on the mode.
 *
 * @param {unknown} raw - the env value as read
 * @param {{error?: Function}} [log]
 * @param {object} [logFields] - merged into the warn log (callSid, attemptId)
 * @returns {"live"|"clip"}
 */
export function resolveFirstSpeaker(raw, log, logFields = {}) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "" || value === "live") return "live";
  if (value === "clip") return "clip";
  log?.error?.("outbound_first_speaker_invalid", { ...logFields, value, severity: "warn" });
  return "clip";
}

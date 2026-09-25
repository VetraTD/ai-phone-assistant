/**
 * Outbound calling's environment, read once. Spec §14. OFF unless the literal
 * string "true" -- the switch is a safety control, and "1" or "yes" silently
 * meaning ON is how a kill switch stops being one.
 */
const E164 = /^\+[1-9]\d{6,14}$/;

export function outboundEnv(env = process.env) {
  const maxConcurrent = Math.max(1, parseInt(env.OUTBOUND_MAX_CONCURRENT || "8", 10) || 8);
  let inboundReserve = Math.max(0, parseInt(env.OUTBOUND_INBOUND_RESERVE || "2", 10) || 0);
  if (inboundReserve >= maxConcurrent) inboundReserve = Math.max(0, Math.min(2, maxConcurrent - 1));
  const allowlist = new Set(
    String(env.OUTBOUND_TEST_ALLOWLIST || "").split(",").map((s) => s.trim()).filter((s) => E164.test(s))
  );
  return Object.freeze({
    enabled: env.OUTBOUND_ENABLED === "true",
    allowlist,
    maxConcurrent,
    inboundReserve,
    tasksQueue: env.OUTBOUND_TASKS_QUEUE || null,
    tasksSa: env.OUTBOUND_TASKS_SA || null,
    baseUrl: (env.BASE_URL || "").replace(/\/$/, "") || null,
  });
}

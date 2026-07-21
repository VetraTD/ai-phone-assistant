import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// ttsHealth.js — process-wide ElevenLabs health circuit breaker.
//
// When ElevenLabs is down (credits exhausted, auth revoked, outage), every
// turn previously re-attempted the WS connection, paid the 3s connect
// timeout, and only then fell back to Google — the dominant cause of the
// observed 2-3s per-turn latency during an outage, and of nudges arriving in
// a different voice mid-call. The breaker remembers recent failures so
// subsequent turns (and subsequent calls) skip ElevenLabs immediately.
//
// Policy:
//   - quota/auth-class failure (WS close 1008/4001, or a message mentioning
//     quota/unauthorized): open for QUOTA_COOLDOWN_MS on the FIRST failure —
//     these do not self-heal within a call.
//   - other failures (connect timeout, socket error, unexpected close):
//     open for TRANSIENT_COOLDOWN_MS after CONSECUTIVE_THRESHOLD in a row.
//   - any success fully closes the breaker.
//
// Module-level singleton state, shared across calls; `now` is injectable for
// tests via createTtsHealth.
// ---------------------------------------------------------------------------

export const QUOTA_COOLDOWN_MS = 5 * 60 * 1000;
export const TRANSIENT_COOLDOWN_MS = 60 * 1000;
export const CONSECUTIVE_THRESHOLD = 2;

function isQuotaOrAuthFailure(err) {
  const msg = String(err?.message || "").toLowerCase();
  return (
    err?.closeCode === 1008 ||
    err?.closeCode === 4001 ||
    msg.includes("quota") ||
    msg.includes("unauthorized") ||
    msg.includes("401")
  );
}

/** @param {{now?: function(): number}} [opts] */
export function createTtsHealth({ now = () => Date.now() } = {}) {
  let consecutiveFailures = 0;
  let openUntil = 0; // epoch ms; breaker open (skip ElevenLabs) until then
  let openReason = null;

  function recordFailure(err) {
    consecutiveFailures++;
    const quota = isQuotaOrAuthFailure(err);
    let cooldown = 0;
    if (quota) {
      cooldown = QUOTA_COOLDOWN_MS;
    } else if (consecutiveFailures >= CONSECUTIVE_THRESHOLD) {
      cooldown = TRANSIENT_COOLDOWN_MS;
    }
    if (cooldown > 0) {
      const until = now() + cooldown;
      if (until > openUntil) {
        openUntil = until;
        openReason = quota ? "quota_or_auth" : "consecutive_failures";
        log.error("tts_el_breaker_open", {
          reason: openReason,
          code: err?.code,
          closeCode: err?.closeCode,
          cooldownMs: cooldown,
        });
      }
    }
  }

  function recordSuccess() {
    if (openUntil > now() || consecutiveFailures > 0) {
      log.info("tts_el_breaker_closed", { reason: "success" });
    }
    consecutiveFailures = 0;
    openUntil = 0;
    openReason = null;
  }

  function isHealthy() {
    return now() >= openUntil;
  }

  function getState() {
    const open = !isHealthy();
    return {
      open,
      reason: open ? openReason : null,
      openUntil: open ? openUntil : null,
      consecutiveFailures,
    };
  }

  return { recordFailure, recordSuccess, isHealthy, getState };
}

/** Shared process-wide instance used by lib/voice/ttsStream.js. */
export const ttsHealth = createTtsHealth();

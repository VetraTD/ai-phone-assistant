// ---------------------------------------------------------------------------
// The per-call clock (batch-3 S2): wrap-up, goodbye, hard end.
//
// Gemini Live closes a session at ~9m49s (CAdfeb9d) and leaves the phone line
// open and silent. The clock ends the call ourselves, politely, before that:
// a wrap-up note at 8:30, a goodbye at 9:00, a hard end at 9:30.
//
// PURE: no import from index.js, no globals. Timers go only through the
// injected setTimer / clearTimer, so a test drives 9.5 minutes deterministically.
// ---------------------------------------------------------------------------

import { log } from "../../logger.js";

export const DEFAULT_WRAP_UP_SEC = 510;
export const DEFAULT_GOODBYE_SEC = 540;
export const DEFAULT_HARD_END_SEC = 570;
/** Observed close 9m49s (CAdfeb9d); never schedule at or after this. */
export const GOOGLE_LIMIT_SEC = 589;

export const WRAP_UP_NOTE =
  "(System: this call has about one minute left. Tell the caller briefly and, if they still need anything, offer to take a message now.)";
export const GOODBYE_NOTE =
  "(System: the time limit is reached. Say one short, warm goodbye sentence now.)";
/** A time note not delivered at a turn end within this long is sent anyway. */
export const NOTE_FORCE_AFTER_MS = 20_000;

function defaults() {
  return {
    wrapUpSec: DEFAULT_WRAP_UP_SEC,
    goodbyeSec: DEFAULT_GOODBYE_SEC,
    hardEndSec: DEFAULT_HARD_END_SEC,
  };
}

// undefined / null / "" = unset (take the default); anything else must parse.
function readSec(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

/**
 * LIVE_CALL_WRAP_UP_SEC / LIVE_CALL_GOODBYE_SEC / LIVE_CALL_HARD_END_SEC.
 * Enforces 0 < wrap < goodbye < hardEnd < GOOGLE_LIMIT_SEC; otherwise ALL
 * THREE defaults, with one log line.
 */
export function resolveClockConfig(env = {}) {
  const e = env || {};
  const wrapUpSec = readSec(e.LIVE_CALL_WRAP_UP_SEC, DEFAULT_WRAP_UP_SEC);
  const goodbyeSec = readSec(e.LIVE_CALL_GOODBYE_SEC, DEFAULT_GOODBYE_SEC);
  const hardEndSec = readSec(e.LIVE_CALL_HARD_END_SEC, DEFAULT_HARD_END_SEC);
  const ok =
    Number.isFinite(wrapUpSec) &&
    Number.isFinite(goodbyeSec) &&
    Number.isFinite(hardEndSec) &&
    wrapUpSec > 0 &&
    wrapUpSec < goodbyeSec &&
    goodbyeSec < hardEndSec &&
    hardEndSec < GOOGLE_LIMIT_SEC;
  if (ok) return { wrapUpSec, goodbyeSec, hardEndSec };
  log.error("live_call_clock_config_refused", {
    wrapUpSec: e.LIVE_CALL_WRAP_UP_SEC ?? null,
    goodbyeSec: e.LIVE_CALL_GOODBYE_SEC ?? null,
    hardEndSec: e.LIVE_CALL_HARD_END_SEC ?? null,
    severity: "warn",
  });
  return defaults();
}

/**
 * @returns {{ start(): void, stop(): void }}
 * Each callback fires at most once; stop() is idempotent and silences everything.
 */
export function createCallClock({ setTimer, clearTimer, config, onWrapUp, onGoodbye, onHardEnd }) {
  const cfg = config || defaults();
  let started = false;
  let stopped = false;
  let handles = [];

  const arm = (stage, sec, cb) => {
    let fired = false;
    const handle = setTimer(() => {
      if (stopped || fired) return;
      fired = true;
      try {
        const r = cb?.();
        // An async callback's rejection is a failure of that stage too.
        if (r && typeof r.catch === "function") {
          r.catch((err) =>
            log.error("live_call_clock_callback_failed", { stage, reason: err?.message || String(err) }),
          );
        }
      } catch (err) {
        log.error("live_call_clock_callback_failed", { stage, reason: err?.message || String(err) });
      }
    }, sec * 1000);
    handle?.unref?.();
    handles.push(handle);
  };

  return {
    start() {
      if (started || stopped) return;
      started = true;
      arm("wrap_up", cfg.wrapUpSec, onWrapUp);
      arm("goodbye", cfg.goodbyeSec, onGoodbye);
      arm("hard_end", cfg.hardEndSec, onHardEnd);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      const outstanding = handles;
      handles = [];
      for (const h of outstanding) {
        try {
          clearTimer(h);
        } catch {
          /* clearing a dead timer is never worth a throw */
        }
      }
    },
  };
}

import { useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// §164.312(a)(2)(iii) automatic logoff — "implement electronic procedures that
// terminate an electronic session after a predetermined time of inactivity."
//
// Nothing did. A dashboard session lasted until the tab was closed: the auth
// backend issues a one-hour access token and refreshes it indefinitely, so an
// unattended browser on a clinic front desk stayed signed in overnight, in
// front of every patient record that clinic holds.
//
// 15 minutes is the default because it is the healthcare convention — the
// number an auditor expects to see without asking why. Configurable, because
// the right answer for a two-person clinic is not the right answer for a ward.
//
// WHAT THIS IS AND IS NOT. It terminates the SESSION in this browser: the timer
// fires, signOut() runs, and the refresh token is discarded so no further access
// tokens can be minted. It is not a bound on a token already stolen — that
// needs the server, and lib/auth/accessToken.js does it: SESSION_MAX_AGE_MINUTES
// refuses a token past a ceiling measured from its own `iat`.
// ---------------------------------------------------------------------------

/** Activity that counts as "the person is still there". */
const ACTIVITY_EVENTS = [
  "mousedown",
  "keydown",
  "touchstart",
  "scroll",
  "wheel",
  // Deliberately NOT "mousemove": a nudged desk, a cat, or a mouse resting on a
  // trackpad edge would keep a clinic's session open indefinitely, which is the
  // exact thing this exists to stop.
  "visibilitychange",
];

/** Read a positive integer from an env value, or fall back. */
function minutes(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const IDLE_TIMEOUT_MINUTES = minutes(
  typeof import.meta !== "undefined" ? import.meta.env?.VITE_IDLE_TIMEOUT_MINUTES : undefined,
  15
);

/** How long the warning is visible before the session ends. */
export const IDLE_WARNING_MINUTES = 2;

/**
 * Sign the user out after a period of no interaction, warning first.
 *
 * The warning is not a courtesy. Without it, someone typing a long note into a
 * knowledge-base entry — keystrokes count as activity, but a pause to think
 * does not — loses the work with no explanation and no way to tell a logout
 * from a crash. A visible countdown makes the control legible instead of
 * mysterious, which is the difference between a policy people follow and one
 * they work around.
 *
 * @param {{ enabled: boolean, onLogout: () => void, timeoutMinutes?: number, warningMinutes?: number }} opts
 * @returns {{ warning: boolean, secondsRemaining: number, stayActive: () => void }}
 */
export function useIdleLogout({
  enabled,
  onLogout,
  timeoutMinutes = IDLE_TIMEOUT_MINUTES,
  warningMinutes = IDLE_WARNING_MINUTES,
}) {
  const [warning, setWarning] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(0);

  // Refs, not state, for the timers and the callback: rescheduling on every
  // keystroke through state would re-render the whole dashboard while somebody
  // is typing into it.
  const warnTimer = useRef(null);
  const endTimer = useRef(null);
  const tick = useRef(null);
  const onLogoutRef = useRef(onLogout);
  onLogoutRef.current = onLogout;

  const resetRef = useRef(() => {});

  useEffect(() => {
    if (!enabled) return undefined;

    const warnAfterMs = Math.max(0, (timeoutMinutes - warningMinutes) * 60_000);
    const endAfterMs = timeoutMinutes * 60_000;

    function clearAll() {
      for (const t of [warnTimer, endTimer, tick]) {
        if (t.current) {
          clearTimeout(t.current);
          clearInterval(t.current);
          t.current = null;
        }
      }
    }

    function reset() {
      clearAll();
      setWarning(false);
      warnTimer.current = setTimeout(() => {
        setWarning(true);
        setSecondsRemaining(warningMinutes * 60);
        tick.current = setInterval(() => {
          setSecondsRemaining((s) => (s > 0 ? s - 1 : 0));
        }, 1000);
      }, warnAfterMs);
      endTimer.current = setTimeout(() => {
        clearAll();
        setWarning(false);
        onLogoutRef.current?.();
      }, endAfterMs);
    }

    resetRef.current = reset;

    function onActivity(event) {
      // A tab going to the BACKGROUND is not activity — it is the opposite, and
      // treating visibilitychange as a reset would let a minimised tab hold a
      // session open forever.
      if (event?.type === "visibilitychange" && document.visibilityState !== "visible") return;
      reset();
    }

    for (const name of ACTIVITY_EVENTS) {
      window.addEventListener(name, onActivity, { passive: true });
    }
    reset();

    return () => {
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onActivity);
      clearAll();
    };
  }, [enabled, timeoutMinutes, warningMinutes]);

  return {
    warning,
    secondsRemaining,
    stayActive: () => resetRef.current(),
  };
}

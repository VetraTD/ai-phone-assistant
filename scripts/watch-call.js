#!/usr/bin/env node
// ---------------------------------------------------------------------------
// watch-call.js — live turn-taking monitor for test calls.
//
// Reads the server's structured JSON log from stdin (lib/logger.js writes one
// JSON object per line to stdout) and renders the turn-taking decisions in
// call order: when the caller was heard, when the silence ladder was armed,
// suppressed or fired, when an unfinished sentence was held, and how a
// barge-in was cut. Ends each call with a summary.
//
// This exists because the interesting behavior is invisible in raw logs —
// "the nudge did NOT fire because the caller was still talking" is the
// absence of an event surrounded by dozens of unrelated lines.
//
//   node --env-file=.env.dev server.js | node scripts/watch-call.js --passthrough
//
// --passthrough re-emits every original line to stdout, so this can sit in a
// pipe without swallowing the server's own logging. Without it, only the
// rendered view is printed.
//
// Read-only: it never touches the server, the database, or any call.
// Requires LOG_LEVEL=DEBUG on the server for the hold/suppression detail —
// the nudge/hangup/latency lines are INFO and show up either way.
// ---------------------------------------------------------------------------

import readline from "node:readline";

const PASSTHROUGH = process.argv.includes("--passthrough");
const NO_COLOR = process.argv.includes("--no-color") || process.env.NO_COLOR;

const C = NO_COLOR
  ? new Proxy({}, { get: () => (s) => s })
  : {
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`,
      yellow: (s) => `\x1b[33m${s}\x1b[0m`,
      blue: (s) => `\x1b[34m${s}\x1b[0m`,
      magenta: (s) => `\x1b[35m${s}\x1b[0m`,
      cyan: (s) => `\x1b[36m${s}\x1b[0m`,
    };

/** Per-call rendering + tally state, keyed by callSid. */
const calls = new Map();

function callFor(sid) {
  if (!calls.has(sid)) {
    calls.set(sid, {
      startedAt: Date.now(),
      suppressing: false,
      tally: {
        nudges: 0,
        suppressions: 0,
        holds: 0,
        holdExtensions: 0,
        holdsCapped: 0,
        bargeIns: 0,
        turns: 0,
        latencySum: 0,
      },
    });
  }
  return calls.get(sid);
}

/** Seconds since this call started, right-aligned — e.g. "  12.4s". */
function stamp(call) {
  return C.dim((((Date.now() - call.startedAt) / 1000).toFixed(1) + "s").padStart(7));
}

function short(sid) {
  return sid ? String(sid).slice(-6) : "??????";
}

function emit(call, sid, icon, text) {
  process.stdout.write(`${stamp(call)} ${C.dim(short(sid))} ${icon} ${text}\n`);
}

function ms(v) {
  return typeof v === "number" ? `${Math.round(v)}ms` : "?";
}

function renderSummary(sid, call, reason) {
  const t = call.tally;
  const avg = t.turns > 0 ? Math.round(t.latencySum / t.turns) : null;
  const parts = [
    `turns ${t.turns}`,
    avg === null ? "avg —" : `avg ${avg}ms`,
    `nudges ${t.nudges > 0 ? C.yellow(t.nudges) : t.nudges}`,
    `suppressed ${t.suppressions}`,
    `holds ${t.holds}${t.holdExtensions ? `(+${t.holdExtensions})` : ""}`,
    t.holdsCapped ? C.yellow(`capped ${t.holdsCapped}`) : null,
    `barge-ins ${t.bargeIns}`,
  ].filter(Boolean);
  process.stdout.write(
    `${C.bold(`──── call ${short(sid)} ended`)} ${C.dim(`(${reason})`)}  ${parts.join("  ")}\n\n`
  );
}

/**
 * Render one parsed log entry. Unknown events are ignored — the server logs
 * plenty that has nothing to do with turn-taking.
 * @param {object} e
 */
function render(e) {
  const sid = e.callSid;
  if (!sid && e.event !== "turn_latency") return;
  const call = callFor(sid);

  switch (e.event) {
    case "call_started":
      call.startedAt = Date.now();
      process.stdout.write(
        `\n${C.bold(`──── call ${short(sid)}`)} ${C.dim(
          `${e.businessName ?? "?"} · from ${e.callerNumber ?? "?"}`
        )}\n`
      );
      break;

    case "caller_speech_started":
      call.suppressing = true;
      emit(call, sid, C.green("🎙"), `caller speaking ${C.dim(`(via ${e.source})`)}`);
      break;

    case "silence_armed":
      emit(
        call,
        sid,
        C.dim("⏱"),
        C.dim(`ladder armed · stage ${e.stage} · fires in ${ms(e.delayMs)} · ${e.step}`)
      );
      break;

    case "silence_suppressed":
      call.tally.suppressions++;
      // One line per check would be noise; announce the first of a run, then
      // only the running total every few seconds so a long hold-off is
      // visible as it happens.
      if (!call.suppressedNoted) {
        call.suppressedNoted = true;
        call.lastSuppressNote = e.suppressedForMs ?? 0;
        emit(
          call,
          sid,
          C.cyan("⏸"),
          `ladder held off — ${e.reason} ${C.dim(
            e.at === "arm" ? "(never scheduled)" : "(fired into speech)"
          )}`
        );
      } else if ((e.suppressedForMs ?? 0) - (call.lastSuppressNote ?? 0) >= 5_000) {
        call.lastSuppressNote = e.suppressedForMs;
        emit(call, sid, C.cyan("⏸"), C.dim(`still holding off — ${ms(e.suppressedForMs)}`));
      }
      break;

    case "silence_suppression_capped":
      emit(
        call,
        sid,
        C.yellow("⚠"),
        `suppression capped after ${ms(e.suppressedForMs)} — ladder resuming (noisy line?)`
      );
      break;

    case "silence_nudge":
      call.tally.nudges++;
      call.suppressedNoted = false;
      emit(call, sid, C.yellow("🔔"), C.yellow(`NUDGE ${e.nudgeNumber} · ${e.step}`));
      break;

    case "silence_hangup":
      emit(call, sid, C.red("☎"), C.red(`silence hangup · ${e.step}`));
      break;

    case "transcript_held":
      call.tally.holds++;
      call.suppressedNoted = false;
      emit(
        call,
        sid,
        C.blue("⋯"),
        `holding ${ms(e.holdMs)} — ${e.rule ?? "?"} ` +
          (e.tail ? C.dim(`…${e.tail}`) : "")
      );
      break;

    case "hold_extended":
      call.tally.holdExtensions++;
      emit(
        call,
        sid,
        C.blue("⋯"),
        `still talking — extended ${ms(e.extensionMs)} ${C.dim(`(held ${ms(e.totalHeldMs)})`)}`
      );
      break;

    case "hold_flushed":
      if (e.cappedByCeiling) call.tally.holdsCapped++;
      emit(
        call,
        sid,
        C.blue("→"),
        `flushed after ${ms(e.totalHeldMs)}${e.cappedByCeiling ? C.yellow(" (hit ceiling)") : ""}`
      );
      break;

    case "transcript_discarded":
      emit(call, sid, C.dim("✗"), C.dim(`discarded — ${e.reason}`));
      break;

    case "barge_in":
      // turnManager logs a decision line with `reason`; session.js logs the
      // actual cut with `fadeMs`. Only the cut is worth a line here.
      if (e.fadeMs === undefined) break;
      call.tally.bargeIns++;
      call.suppressedNoted = false;
      emit(
        call,
        sid,
        C.magenta("✂"),
        `barge-in — faded ${ms(e.fadeMs)}, dropped ${e.droppedFrames ?? "?"} frames ` +
          C.dim(`(${Math.round((e.droppedFrames ?? 0) * 20)}ms of speech never played)`)
      );
      break;

    case "turn_latency": {
      const c = callFor(e.callSid);
      if (typeof e.voice_to_voice_ms === "number") {
        c.tally.turns++;
        c.tally.latencySum += e.voice_to_voice_ms;
        const slow = e.voice_to_voice_ms > 1000;
        emit(
          c,
          e.callSid,
          slow ? C.yellow("⚡") : C.dim("⚡"),
          `${slow ? C.yellow(ms(e.voice_to_voice_ms)) : C.dim(ms(e.voice_to_voice_ms))} ` +
            C.dim(
              `voice-to-voice (hold ${ms(e.stt_tail_ms)}, llm ${ms(e.llm_ttfb_ms)}, tts ${ms(
                e.tts_ttfb_ms
              )})${e.barged_in ? " · barged" : ""}`
            )
        );
      }
      break;
    }

    case "call_ended":
      renderSummary(sid, call, e.reason ?? "?");
      calls.delete(sid);
      break;

    default:
      break;
  }
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (PASSTHROUGH) process.stdout.write(line + "\n");
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return;
  let entry;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return; // not a structured log line (stack traces, tool output, ...)
  }
  try {
    render(entry);
  } catch {
    // A rendering bug must never kill the pipe the server is writing into.
  }
});

process.stdout.write(
  C.dim(
    "watching for calls… (server needs LOG_LEVEL=DEBUG for hold/suppression detail)\n"
  )
);

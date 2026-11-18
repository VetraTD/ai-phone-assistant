// ---------------------------------------------------------------------------
// One place that opens a Live session, plays real caller audio at real time,
// prices it and closes it. Every gate goes through here so that a difference
// between gates is a difference in the QUESTION, not in how the session was
// driven.
//
// The `finally` that closes the session is the whole reason this is shared:
// GPT-Live bills per wall-clock second, so a gate that forgets to close bills
// until something else notices.
// ---------------------------------------------------------------------------
import { openSession, saveRaw, saveAudio, waitForSpeechQuiet, outputSpeechRuns } from "./gptlive.js";
import { loadUlaw, frames, FRAME_BYTES, paceFrames, silenceFrames } from "./audio.js";
import { reserve, commit, priceLive } from "./spendLive.js";

export const DEFAULT_MAX_SECONDS = 45;

/**
 * Play one or more fixtures into a fresh session.
 *
 * @param {object} o
 * @param {string} o.label            - raw/ and audio/ filename
 * @param {string} o.probe            - for the spend ledger
 * @param {string[]} o.fixtures       - caller fixtures, played in order
 * @param {string} o.instructions     - frontend instructions
 * @param {object} [o.delegation]
 * @param {number} [o.gapMs=0]        - silence between fixtures
 * @param {number} [o.tailMs=6000]    - silence after the last fixture
 * @param {number} [o.maxSeconds]
 * @param {(ctx)=>void} [o.onStarted] - called once the session is up
 * @param {(ctx)=>Promise<void>} [o.afterAudio] - called after the last fixture
 * @param {boolean} [o.greetFirst=true] - wait out the model's greeting before the caller speaks
 */
export async function runSession(o) {
  const {
    label, probe, fixtures, instructions, delegation,
    gapMs = 0, tailMs = 6000, maxSeconds = DEFAULT_MAX_SECONDS,
    onStarted, afterAudio, backendUsdGuess = 0.005,
    greetFirst = true, greetQuietMs = 900, greetMaxMs = 15000,
  } = o;

  reserve(`${probe}/${label}`, maxSeconds, backendUsdGuess);

  const t0 = Date.now();
  let session = null;
  let state = null;
  const marks = { fixtures: [] };

  try {
    session = await openSession({
      label, instructions, delegation, hardMs: maxSeconds * 1000,
    });
    state = session.state;
    marks.startedMs = state.startedAt - state.t0;
    onStarted?.({ session, state, marks });

    // Let the greeting finish before the caller speaks.
    //
    // Without this the model's opening line collides with caller audio that
    // started at t=0, and every overlap measurement downstream is measuring the
    // greeting rather than the thing under test. G3's first run found exactly
    // that: an identical 0.61s offset into two different fixtures.
    //
    // Silence is fed while waiting because Twilio never stops sending, and a
    // stream that simply stops is a stall rather than a pause.
    if (greetFirst) {
      const greetWait = paceFrames(silenceFrames("ulaw8k", greetMaxMs), (f) => session.sendAudio(f), {
        stop: () => Boolean(marks.greetingQuietAt),
      });
      const quiet = await waitForSpeechQuiet(state, { quietMs: greetQuietMs, timeoutMs: greetMaxMs });
      marks.greetingQuietAt = quiet.quietAt;
      marks.greetingSpeechRuns = quiet.runs.map((r) => r.ms);
      marks.greetingSawSpeech = quiet.sawSpeech;
      marks.greetingTimedOut = quiet.timedOut;
      await greetWait;
      marks.greetingAudioBytes = state.audioOut.reduce((a, b) => a + b.bytes, 0);
      marks.speechRunsBeforeCaller = outputSpeechRuns(state).runs.length;
      // Small beat, the way a caller pauses before answering.
      await paceFrames(silenceFrames("ulaw8k", 400), (f) => session.sendAudio(f));
    }

    for (let i = 0; i < fixtures.length; i++) {
      const fx = loadUlaw(fixtures[i]);
      const startAt = Date.now();
      await paceFrames(frames(fx.ulaw, FRAME_BYTES.ulaw8k), (f) => session.sendAudio(f));
      const speechEndAt = Date.now();
      marks.fixtures.push({ label: fixtures[i], startAt, speechEndAt, seconds: fx.seconds });

      if (gapMs && i < fixtures.length - 1) {
        await paceFrames(silenceFrames("ulaw8k", gapMs), (f) => session.sendAudio(f));
      }
    }

    marks.audioDoneAt = Date.now();
    if (afterAudio) await afterAudio({ session, state, marks });

    // Twilio never stops sending. A stream that simply stops is a stall, not a
    // pause -- padding is the harness finally behaving like the transport it
    // stands in for.
    await paceFrames(silenceFrames("ulaw8k", tailMs), (f) => session.sendAudio(f));
  } catch (err) {
    marks.error = err.message;
  } finally {
    if (session) await session.close();
  }

  const wall = (Date.now() - t0) / 1000;
  const priced = priceLive({
    seconds: state?.usageSeconds,
    wallClockSeconds: wall,
    backendModel: delegation?.responses?.model,
    backendTokens: sumBackendTokens(state),
  });
  commit({
    probe, arm: delegation?.type ?? "client", label, model: "gpt-live-1",
    usd: priced.usd, seconds: priced.breakdown.voice.seconds,
    estimated: priced.estimated, note: marks.error ? `ERROR: ${marks.error}` : undefined,
  });

  if (state) { saveRaw(state); saveAudio(state); }
  return { state, marks, priced, wall };
}

/**
 * Delegated Responses usage, summed out of the nested response.event stream.
 * Returns null when nothing reported usage -- a null is honest, a zero would
 * claim the backend was free.
 */
export function sumBackendTokens(state) {
  if (!state?.responseEvents?.length) return null;
  let input = 0, output = 0, seen = false;
  for (const r of state.responseEvents) {
    const u = r.inner?.response?.usage;
    if (!u) continue;
    seen = true;
    input += u.input_tokens || 0;
    output += u.output_tokens || 0;
  }
  return seen ? { input, output } : null;
}

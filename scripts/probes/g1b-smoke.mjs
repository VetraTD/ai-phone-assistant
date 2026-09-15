// ---------------------------------------------------------------------------
// G1b -- first contact with a real socket. ~$0.01.
//
// Everything in lib/gptlive.js was written from OpenAI's generated SDK types,
// not from a working connection. That is good evidence and it is not proof.
// This opens ONE session, sends two seconds of real mu-law, reads whatever
// comes back, and closes -- before any gate is allowed to depend on the
// protocol being what I read.
//
// Fail here and the round stops: the owner authorised falling back to
// re-testing gpt-realtime-2.1 on the corrected tool harness instead.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { openSession, audioRuns, inputText, outputText, saveRaw, saveAudio } from "./lib/gptlive.js";
import { loadUlaw, frames, FRAME_BYTES, paceFrames, silenceFrames } from "./lib/audio.js";
import { FRONTEND_INSTRUCTIONS } from "./lib/livePrompt.js";
import { reserve, commit, priceLive, summary } from "./lib/spendLive.js";

const MAX_SECONDS = 30;

async function main() {
  const before = reserve("G1b smoke", MAX_SECONDS, 0.0);
  console.log(`G1b smoke -- one session, <=${MAX_SECONDS}s. Budget: $${before.remaining.toFixed(4)} available.\n`);

  const fixture = loadUlaw("clean_open");
  console.log(`fixture clean_open: ${fixture.bytes}B = ${fixture.seconds.toFixed(2)}s of mu-law 8k`);

  let session = null;
  let state = null;
  const t0 = Date.now();

  try {
    session = await openSession({
      label: "g1b-smoke",
      instructions: FRONTEND_INSTRUCTIONS,
      hardMs: MAX_SECONDS * 1000,
    });
    state = session.state;

    console.log(`session.started after ${state.startedAt - state.t0}ms`);
    console.log(`resolved config: ${JSON.stringify(state.resolvedSession?.audio ?? {})}`);

    const callerFrames = frames(fixture.ulaw, FRAME_BYTES.ulaw8k);
    console.log(`sending ${callerFrames.length} frames at 20ms...`);
    await paceFrames(callerFrames, (f) => session.sendAudio(f));
    const lastFrameAt = Date.now();

    // Twilio never stops sending; a stream that simply stops is a stall, not a
    // pause. Keep feeding silence so the model hears the caller finish.
    const pad = silenceFrames("ulaw8k", 6000);
    await paceFrames(pad, (f) => session.sendAudio(f), {
      stop: () => state.audioOut.length > 0 && Date.now() - lastFrameAt > 5000,
    });

    const firstOut = state.audioOut[0];
    console.log("\n--- what came back ---");
    console.log(`server events: ${state.events.length}`);
    console.log(`event types seen: ${[...new Set(state.events.map((e) => e.type))].join(", ")}`);
    console.log(`input transcript fragments:  ${state.inputTranscript.length}`);
    console.log(`output transcript fragments: ${state.outputTranscript.length}`);
    console.log(`output audio deltas: ${state.audioOut.length}`);
    if (firstOut) console.log(`model_leg_ms (last caller frame -> first output audio): ${firstOut.at - lastFrameAt}ms`);
    console.log(`caller text : ${JSON.stringify(inputText(state))}`);
    console.log(`model text  : ${JSON.stringify(outputText(state))}`);
    console.log(`audio runs  : ${JSON.stringify(audioRuns(state).map((r) => Math.round(r.audioMs) + "ms"))}`);
    console.log(`usage seconds (server): ${state.usageSeconds}`);
    if (state.errors.length) console.log(`ERRORS: ${JSON.stringify(state.errors, null, 2)}`);
  } catch (err) {
    console.log(`\nSMOKE FAILED: ${err.message}`);
    if (state?.errors?.length) console.log(JSON.stringify(state.errors, null, 2));
  } finally {
    if (session) await session.close();
  }

  const wall = (Date.now() - t0) / 1000;
  const priced = priceLive({ seconds: state?.usageSeconds, wallClockSeconds: wall });
  commit({
    probe: "G1b", arm: "smoke", model: "gpt-live-1", usd: priced.usd,
    seconds: priced.breakdown.voice.seconds, estimated: priced.estimated,
    note: "first socket; protocol validation",
  });

  const ok = Boolean(
    state?.startedAt &&
    (state.audioOut.length > 0 || state.inputTranscript.length > 0) &&
    !state.errors.length
  );

  const verdict = {
    at: new Date().toISOString(),
    pass: ok,
    session_started: Boolean(state?.startedAt),
    pcmu_accepted: Boolean(state?.startedAt) && !state?.errors?.length,
    got_output_audio: (state?.audioOut?.length ?? 0) > 0,
    got_input_transcript: (state?.inputTranscript?.length ?? 0) > 0,
    got_output_transcript: (state?.outputTranscript?.length ?? 0) > 0,
    event_types: state ? [...new Set(state.events.map((e) => e.type))] : [],
    errors: state?.errors ?? [],
    wall_seconds: wall,
    usage_seconds: state?.usageSeconds ?? null,
    usd: priced.usd,
  };
  fs.writeFileSync("scripts/probes/results-g1b.json", JSON.stringify(verdict, null, 2) + "\n");

  if (state) { saveRaw(state); saveAudio(state); }

  console.log(`\nspend: $${priced.usd.toFixed(4)} | ${JSON.stringify(summary())}`);
  console.log(`\nG1b ${ok ? "PASSED -- protocol is what the SDK types said" : "FAILED -- see results-g1b.json"}`);
  process.exit(ok ? 0 : 1);
}

main();

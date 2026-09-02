// ---------------------------------------------------------------------------
// R3 — tool reliability, Gemini 3.1 Live vs OpenAI gpt-realtime-2.1.
//
//   node scripts/probes/r3-tools.mjs [--n 5] [--models 3.1,gpt] [--only T1,T4]
//
// The gap every earlier round left open. L1-L5 and R2 answered every tool call
// with a canned instant success, so no model was ever shown a refusal, a
// conflict, or a backend that failed — which is precisely where a booking
// receptionist breaks. Seven scenarios, scripted results, deterministic checks.
//
// TEXT-IN, AUDIO-OUT — a deliberate deviation, recorded here.
//   Caller turns are sent as text (`sendClientContent` / `conversation.item
//   .create`) rather than synthesized audio. Tool behaviour is what is under
//   test, and audio input would fold the vendor's own STT errors into every
//   result — round 2 already showed Gemini transcribing "Nithin" as "Nitin", and
//   that noise would masquerade as a tool-argument failure. Endpointing and
//   barge-in are measured on real audio in their own arms.
//   Output stays AUDIO because that is what ships, and the spoken transcript is
//   what the leak check reads.
// ---------------------------------------------------------------------------
import "dotenv/config";
import { GoogleGenAI, Modality } from "@google/genai";
import { openSession as openAiSession, billableUsage } from "./lib/openai.js";
import { SYSTEM_PROMPT, GEMINI_TOOLS, OPENAI_TOOLS } from "./lib/prompt.js";
import { emptyUsage, addUsage } from "./lib/geminiUsage.js";
import { makeScriptedExecutor, toolCalled, toolNotCalled, toolBefore,
         toolCalledWith, toolNotCalledWith, toolCalledAtMost,
         saidNotMatches, toolBlobLeak } from "./lib/toolScript.js";
import { reserve, commit, price, spent, CAP_USD } from "./lib/spend.js";
import { errorGuard, writeRaw } from "./lib/stats.js";

/**
 * Node terminates on an unhandled rejection by default, and three round-3 runs
 * died mid-suite immediately after a gpt-realtime-2.1 session — the OpenAI
 * driver answers tool calls from an ASYNC ws message handler, so anything that
 * throws in there (a send on a closing socket, a scripted result that raises)
 * takes the whole process with it and loses every result gathered so far.
 * Log and carry on instead; a lost trial is a data point, a lost suite is $0.75.
 */
process.on("unhandledRejection", (e) => console.log(`  [unhandledRejection] ${e?.message || e}`));
process.on("uncaughtException", (e) => console.log(`  [uncaughtException] ${e?.message || e}`));

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : d; };
const N = Number(argOf("--n", 5));
const MODELS = argOf("--models", "3.1,gpt").split(",");
const ONLY = argOf("--only", null)?.split(",") || null;
/** Separate output file per invocation, so a partial re-run cannot clobber a complete one. */
const TAG = argOf("--tag", "r3-tools");

const GEMINI_MODEL = "gemini-3.1-flash-live-preview";
/**
 * The third arm, added after the six-tool harness defect invalidated the
 * rounds 1-2 quality verdict against 2.5. 2.5 is the only Gemini on Vertex —
 * ADC auth, europe-west1 residency, not a preview model — and it held
 * trailing_lead_in 5/5 where 3.1 cuts in at every setting. If its conversation
 * quality survives the corrected tool set it wins on every axis that matters.
 */
const GEMINI25_MODEL = "gemini-live-2.5-flash-native-audio";
const VERTEX_PROJECT = "vetra-uk-edc8ca";
const VERTEX_LOCATION = "europe-west1";
const OPENAI_MODEL = "gpt-realtime-2.1";
const EST = { "3.1": 0.05, "2.5": 0.05, gpt: 0.12 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The slot the caller asks for, in the words the prompt will see. */
const WANTED = "Tuesday at 3 PM";
const isTuesday3 = (s) => /tue/i.test(String(s)) || /T15:00/.test(String(s)) || /15:00/.test(String(s));

// ---------------------------------------------------------------------------
// Scenarios. Each: scripted tool results + the caller's lines + assertions.
// ---------------------------------------------------------------------------
const SCENARIOS = [
  {
    id: "T1", name: "ordering — check availability before booking",
    script: { check_appointment_availability: () => ({ ok: true, available: true, slots: ["2026-09-08T15:00:00-05:00"] }) },
    turns: [`Hi, I'd like to book an appointment for ${WANTED}.`, "Yes please, that works. My name is Sarah Miller, date of birth March 3rd 1990.", "No that's all, thanks."],
    assert: (calls) => [
      toolCalled(calls, "check_appointment_availability"),
      toolBefore(calls, "check_appointment_availability", "book_appointment"),
    ],
  },
  {
    id: "T2", name: "conflict pivot — must not book a slot it was told is taken",
    script: {
      check_appointment_availability: () => ({ ok: true, available: false, reason: "that time is already booked",
        alternatives: ["2026-09-08T16:30:00-05:00", "2026-09-09T10:00:00-05:00"] }),
    },
    turns: [`Hi, I'd like to book an appointment for ${WANTED}.`, "Hmm, okay. What else do you have?", "Let me think about it. Thanks."],
    assert: (calls, said) => [
      toolCalled(calls, "check_appointment_availability"),
      toolNotCalledWith(calls, "book_appointment", (a) => isTuesday3(a.scheduled_at), "the taken slot"),
      saidNotMatches(said, /\b(booked|confirmed|all set|reserved)\b.{0,40}(three|3)\s*(pm|p\.m)/i, "did not claim the taken slot was booked"),
    ],
  },
  {
    // T2 with tool_choice PINNED to the availability tool on the turn where the
    // caller names a slot. gpt-realtime-2.1 skipped that check in 9 of 20 T2/T7
    // trials; this tests whether the documented tool_choice override actually
    // removes the skip, rather than assuming it does because the API supports it.
    id: "T2F", name: "conflict pivot with FORCED tool_choice on availability",
    forceTool: { turnIndex: 0, name: "check_appointment_availability" },
    script: {
      check_appointment_availability: () => ({ ok: true, available: false, reason: "that time is already booked",
        alternatives: ["2026-09-08T16:30:00-05:00", "2026-09-09T10:00:00-05:00"] }),
    },
    turns: [`Hi, I'd like to book an appointment for ${WANTED}.`, "Hmm, okay. What else do you have?", "Let me think about it. Thanks."],
    assert: (calls, said) => [
      toolCalled(calls, "check_appointment_availability"),
      toolNotCalledWith(calls, "book_appointment", (a) => isTuesday3(a.scheduled_at), "the taken slot"),
      saidNotMatches(said, /(booked|confirmed|all set|reserved).{0,40}(three|3)\s*(pm|p\.m)/i, "did not claim the taken slot was booked"),
    ],
  },
  {
    id: "T3", name: "argument fidelity — books the time the caller actually said",
    script: {
      check_appointment_availability: () => ({ ok: true, available: true }),
      book_appointment: () => ({ ok: true, confirmation_id: "PROBE-77" }),
    },
    // The fixture requires new/existing + name + DOB before booking. The first
    // version of this scenario stopped short of supplying them, so neither model
    // ever reached book_appointment and both were scored as failing for refusing
    // to book without required identity — correct behaviour, marked wrong.
    turns: [`I'd like an appointment ${WANTED} please.`, "I'm a new patient.",
            "Sarah Miller, date of birth March 3rd 1990.", "Yes, please book it.",
            "No, that's everything, thank you."],
    assert: (calls) => [
      toolCalled(calls, "book_appointment"),
      toolCalledWith(calls, "book_appointment", (a) => isTuesday3(a.scheduled_at), "scheduled_at = the requested slot"),
      toolCalledWith(calls, "book_appointment", (a) => /sarah/i.test(JSON.stringify(a)), "caller name carried"),
    ],
  },
  {
    id: "T4", name: "failure recovery — backend fails, must not claim success",
    script: {
      check_appointment_availability: () => ({ ok: true, available: true }),
      book_appointment: () => ({ ok: false, error: "calendar_unavailable", message: "The calendar could not be reached." }),
    },
    turns: [`Book me in for ${WANTED} please.`, "I'm a new patient.",
            "Sarah Miller, March 3rd 1990.", "Yes, go ahead and book it.",
            "Okay, so am I definitely booked in?"],
    assert: (calls, said) => [
      toolCalled(calls, "book_appointment"),
      saidNotMatches(said, /\b(you'?re booked|all set|confirmed|booking is confirmed|see you (on|at))\b/i, "did not claim a booking that failed"),
      toolCalledAtMost(calls, "book_appointment", 3),
    ],
  },
  {
    id: "T5", name: "end_call gating — ends when the caller says goodbye",
    script: {},
    turns: ["Hi, what are your opening hours?", "Great, thanks. That's all I needed. Bye!"],
    // Scans the FINAL turn only. The first version scanned the whole
    // transcript and flagged the legitimate "anything else?" that follows the
    // turn-1 hours answer, which is exactly the behaviour the prompt asks for.
    assert: (calls, said, turnSaid) => [
      toolCalled(calls, "end_call"),
      saidNotMatches(turnSaid[turnSaid.length - 1] || "", /anything else (i can help|you need)/i,
        "did not ask 'anything else' on the goodbye turn"),
    ],
  },
  {
    id: "T6", name: "no phantom tools — declines a capability it does not have",
    script: {},
    turns: ["Can you email me a copy of my invoice?", "Okay, no worries. Bye."],
    assert: (calls) => [
      toolNotCalled(calls, "send_email"),
      toolNotCalled(calls, "get_invoice"),
    ],
  },
  {
    id: "T7", name: "slow backend — 3s tool stall, must not go silent or double-book",
    script: {
      __delays: { check_appointment_availability: 3000 },
      check_appointment_availability: () => ({ ok: true, available: true }),
      book_appointment: () => ({ ok: true, confirmation_id: "PROBE-88" }),
    },
    turns: [`Do you have anything ${WANTED}?`, "Sarah Miller, March 3rd 1990. Yes book it.", "Thanks, bye."],
    assert: (calls) => [
      toolCalled(calls, "check_appointment_availability"),
      toolCalledAtMost(calls, "check_appointment_availability", 2),
      toolCalledAtMost(calls, "book_appointment", 1),
    ],
  },
];

// ---------------------------------------------------------------------------
// Gemini driver
// ---------------------------------------------------------------------------
async function runGemini(scn, idx, variant = "3.1") {
  const model = variant === "2.5" ? GEMINI25_MODEL : GEMINI_MODEL;
  reserve(`R3 ${scn.id} gemini${variant} ${idx + 1}`, EST[variant]);
  const ai = variant === "2.5"
    ? new GoogleGenAI({ vertexai: true, project: VERTEX_PROJECT, location: VERTEX_LOCATION })
    : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const exec = makeScriptedExecutor(scn.script);
  const state = { usage: emptyUsage(), said: "", turnSaid: [], mark: 0, firstAudioAt: null, lastAudioAt: null, turnComplete: false, err: null };
  let session = null;

  session = await ai.live.connect({
    model,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      tools: [GEMINI_TOOLS],
      outputAudioTranscription: {},
    },
    callbacks: {
      onmessage: async (m) => {
        if (m.usageMetadata) addUsage(state.usage, m.usageMetadata);
        if (m.toolCall) {
          const calls = m.toolCall.functionCalls || [];
          const responses = [];
          for (const c of calls) {
            const delay = exec.delayFor(c.name);
            if (delay) await sleep(delay);
            responses.push({ id: c.id, name: c.name, response: exec.resultFor(c.name, c.args) });
          }
          try { session.sendToolResponse({ functionResponses: responses }); } catch (e) { state.err = e?.message; }
        }
        const sc = m.serverContent;
        if (!sc) return;
        if (sc.modelTurn?.parts?.some((p) => p.inlineData?.data)) {
          state.lastAudioAt = Date.now();
          if (!state.firstAudioAt) state.firstAudioAt = Date.now();
        }
        if (sc.outputTranscription?.text) state.said += sc.outputTranscription.text;
        if (sc.turnComplete) state.turnComplete = true;
      },
      onerror: (e) => { state.err = e?.message || String(e); },
    },
  });

  try {
    await sleep(1200);
    for (const line of scn.turns) {
      state.turnComplete = false; state.lastAudioAt = null;
      state.mark = state.said.length;
      session.sendClientContent({ turns: [{ role: "user", parts: [{ text: line }] }], turnComplete: true });
      // Wait for the reply to finish arriving — a quiet period, not turnComplete
      // (round 2 proved audio keeps coming after that event).
      const until = Date.now() + 25000;
      while (Date.now() < until) {
        if (state.lastAudioAt && Date.now() - state.lastAudioAt > 900) break;
        await sleep(30);
      }
      await sleep(150);
      state.turnSaid.push(state.said.slice(state.mark));
    }
  } finally { try { session.close(); } catch {} await sleep(250); }

  const c = price(model, state.usage);
  commit({ probe: "R3", arm: `${scn.id}:gemini${variant}`, run: idx + 1, model, usage: state.usage, usd: c.usd });
  return { calls: exec.calls, said: state.said, turnSaid: state.turnSaid, usd: c.usd, err: state.err };
}

// ---------------------------------------------------------------------------
// OpenAI driver
// ---------------------------------------------------------------------------
async function runOpenAI(scn, idx) {
  reserve(`R3 ${scn.id} openai ${idx + 1}`, EST.gpt);
  const exec = makeScriptedExecutor(scn.script);
  const s = await openAiSession({
    model: OPENAI_MODEL, instructions: SYSTEM_PROMPT, tools: OPENAI_TOOLS,
    turnDetection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500, create_response: true, interrupt_response: true },
    answerTools: false, // this probe answers them, with scripted results
  });

  s.ws.on("message", async (raw) => {
    try {
      let e; try { e = JSON.parse(raw.toString()); } catch { return; }
      if (e.type !== "response.function_call_arguments.done") return;
      let args = {}; try { args = JSON.parse(e.arguments || "{}"); } catch {}
      const delay = exec.delayFor(e.name);
      if (delay) await sleep(delay);
      const result = exec.resultFor(e.name, args);
      s.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: e.call_id, output: JSON.stringify(result) } });
      s.send({ type: "response.create" });
    } catch (err) {
      console.log(`  [tool-response error] ${err?.message}`);
    }
  });

  try {
    const until0 = Date.now() + 10000;
    while (Date.now() < until0 && !s.state.sessionUpdated) await sleep(20);
    const turnSaid = [];
    let turnIdx = -1;
    for (const line of scn.turns) {
      turnIdx++;
      s.state.lastAudioAt = null;
      const mark = (s.state.outputTranscript || "").length;
      s.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: line }] } });
      // Forced tool choice, when the scenario asks for it. This is the documented
      // Realtime override; the probe exists to find out whether it actually
      // compels the call rather than merely being available.
      const force = scn.forceTool && scn.forceTool.turnIndex === turnIdx
        ? { response: { tool_choice: { type: "function", name: scn.forceTool.name } } }
        : {};
      s.send({ type: "response.create", ...force });
      const until = Date.now() + 25000;
      while (Date.now() < until) {
        if (s.state.lastAudioAt && Date.now() - s.state.lastAudioAt > 900) break;
        await sleep(30);
      }
      await sleep(150);
      turnSaid.push((s.state.outputTranscript || "").slice(mark));
    }
    s.state.__turnSaid = turnSaid;
  } finally { s.close(); await sleep(250); }

  const usage = billableUsage(s.state.usage);
  const c = price(OPENAI_MODEL, usage);
  commit({ probe: "R3", arm: `${scn.id}:openai`, run: idx + 1, model: OPENAI_MODEL, usage, usd: c.usd });
  return { calls: exec.calls, said: s.state.outputTranscript, turnSaid: s.state.__turnSaid || [], usd: c.usd, err: s.state.error };
}

// ---------------------------------------------------------------------------
async function main() {
  const scns = ONLY ? SCENARIOS.filter((s) => ONLY.includes(s.id)) : SCENARIOS;
  console.log(`R3 tool reliability — ${scns.length} scenarios x N=${N} x [${MODELS.join(", ")}]`);
  console.log(`text-in / audio-out. spent $${spent().toFixed(4)} / $${CAP_USD.toFixed(2)}\n`);
  const guard = errorGuard(3);
  const rows = [];

  for (const scn of scns) {
    console.log(`${scn.id} — ${scn.name}`);
    for (const m of MODELS) {
      const runner = m === "gpt" ? runOpenAI : (scn2, i2) => runGemini(scn2, i2, m);
      let passes = 0, total = 0, leaks = 0, errs = 0;
      const detail = [];
      for (let i = 0; i < N; i++) {
        try {
          const r = await runner(scn, i);
          guard.ok();
          const checks = [...scn.assert(r.calls, r.said, r.turnSaid || []), toolBlobLeak(r.said)];
          const p = checks.filter((c) => c.pass).length;
          passes += p; total += checks.length;
          if (!toolBlobLeak(r.said).pass) leaks++;
          detail.push({ trial: i + 1, model: m, checks, calls: r.calls.map((c) => ({ name: c.name, args: c.args })), said: r.said.slice(0, 400), turnSaid: r.turnSaid || [], usd: r.usd });
          // Persist after every TRIAL, not every cell. Cell-level writes still
          // lost everything when a run was killed part-way through a cell, which
          // happened twice on Gemini 2.5 and cost $0.51 for zero saved data.
          writeRaw(TAG, { at: new Date().toISOString(), n: N, models: MODELS,
            rows: [...rows, { scenario: scn.id, model: m, passes, total, leaks, errs, detail, partial: i + 1 < N }] });
        } catch (e) {
          if (e.name === "BudgetExceeded" || e.name === "SocketErrorStreak") throw e;
          errs++; detail.push({ trial: i + 1, model: m, error: e.message?.slice(0, 140) });
          guard.fail(e);
        }
      }
      rows.push({ scenario: scn.id, model: m, passes, total, leaks, errs, detail });
      // Incremental write: three runs were killed mid-suite and each lost every
      // result because raw was only written at the end.
      writeRaw(TAG, { at: new Date().toISOString(), n: N, models: MODELS, rows });
      const failed = detail.flatMap((d) => (d.checks || []).filter((c) => !c.pass).map((c) => c.name));
      console.log(`   ${({ "3.1": "gemini-3.1", "2.5": "gemini-2.5", gpt: "gpt-2.1  " })[m].padEnd(11)} checks ${passes}/${total}  leaks ${leaks}/${N}  errors ${errs}` +
        (failed.length ? `\n      failed: ${[...new Set(failed)].join(", ")}` : ""));
    }
  }

  writeRaw(TAG, { at: new Date().toISOString(), n: N, models: MODELS, rows });
  console.log(`\nrunning total $${spent().toFixed(4)}`);
}

main().catch((e) => { console.error(`R3 ABORTED: ${e.message}`); process.exit(1); });

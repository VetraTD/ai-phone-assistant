// ---------------------------------------------------------------------------
// The adaptive scripted caller, shared by T3 (booking correctness) and T4
// (agentic multi-step).
//
// WHY THIS REPLACES A FIXED SEQUENCE OF FIXTURES.
//
// Three consecutive probe rounds have been lost to the same defect, and each
// time it was read as a vendor failure before anyone read the transcripts:
//
//   round 1  the caller answered "what's your name?" with a symptom, never
//            recovered, and eight turns produced no booking
//   round 2  the prompt's question order changed, so every answer landed on the
//            previous question; the caller's "Yes, that's right" answered
//            "could you spell that", lastAgreement was never written, and the
//            recovery declined `never_agreed`
//   round 3  (2026-09-15) `called_book: 0 of 15` for GPT-Live and `0 of 5` for
//            Gemini. The transcripts end:
//              "...at ten is available. Are you a new patient or an existing
//               patient?"
//            asked in 3 of 3 GPT-Live takes, and repeated SEVEN times in one
//            Gemini 2.5 session. The seven-line script has no answer for it, so
//            the call ends before book_appointment is reachable by anyone.
//
// A fixed sequence assumes the model asks exactly the questions the script
// expects, in exactly that order. It does not, it never has, and a prompt
// change silently re-breaks it. So the caller now LISTENS: after each model
// turn it looks at what was actually asked and answers that, falling back to
// the queue when nothing matches.
//
// Just as important, it can now say "I do not know how to answer this". A take
// that runs out of script while the model is still asking questions is marked
// UNSCOREABLE rather than counted as a vendor failure. A desynced run must
// never again read as a failed fix.
// ---------------------------------------------------------------------------
import {
  openSession as openGemini, sendAudio as sendGemini, armTurn, waitForQuiet, setupOk,
} from "./geminiSession.js";
import {
  openSession as openLive, waitForSpeechQuiet, outputText as liveOutputText,
} from "./gptlive.js";
import { loadUlaw, ulawToPcm16k, frames, FRAME_BYTES, paceFrames, silenceFrames } from "./audio.js";
import { FRONTEND_INSTRUCTIONS, RESPONSES_DELEGATION } from "./livePrompt.js";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Questions the prompt makes the model ask that the scripts have no answer for.
 *
 * Each entry is a fixture that ABSORBS the question. `max` caps how often it
 * can be spent, so a model stuck in a loop cannot consume the whole run
 * answering the same question -- and the cap being hit is itself recorded,
 * because that IS the loop defect.
 *
 * Patterns were written against the real transcripts in results-booking.json,
 * not invented: three different phrasings of the new/existing question and
 * three of the appointment-kind question appear there.
 */
export const ABSORBERS = [
  // --- the booking script's own lines, now matched to the QUESTION rather than
  // played in a fixed order. This is the part the first two repairs missed.
  //
  // Evidence it was still needed after the absorbers landed: GPT-Live asked
  // "What day works best for your visit?" and the fixed queue answered it with
  // a phone number, because demo_number happened to be next. The run then
  // scored as a clean take with no booking. Matching on content makes the
  // caller answer what was actually asked, and makes an unmatched question
  // visible instead of silently mis-answered.
  // ORDER MATTERS -- first match wins. The narrow patterns must sit above the
  // broad ones they would otherwise be swallowed by: the alternative-slot offer
  // above the generic read-back, and "spell your FIRST name" above "spell".
  {
    // THE FIX THAT MAKES S2_refusal SCOREABLE. On a refused write the model
    // does the right thing and offers the other slot -- "that time slot was
    // just taken. Would you like to try booking for two thirty in the afternoon
    // instead?" -- and the old caller had no way to say yes. S2 scored 0 of 5
    // on BOTH vendors and none of it was a vendor result; the scenario could
    // never reach the behaviour it exists to measure.
    fixture: "demo_alt_slot",
    re: /\b(would you like to (try|book|go with|take)|shall (i|we) (try|book|put you)|try booking for|instead\?|two[- ]thirty|2:?30|other (slot|time)|another time|different time)\b/i,
    max: 2,
  },
  {
    fixture: "demo_spell_first",
    re: /\bspell(ing)?\b[^.?!]*\bfirst name\b/i,
    max: 2,
  },
  {
    fixture: "demo_when",
    re: /\b(what day|which day|what time|what date|when would you|when were you (thinking|hoping)|day works|day or time|time were you|looking to (come|schedule|book)|hoping to come)\b/i,
    max: 3,
  },
  {
    fixture: "demo_spell",
    re: /\b(spell|spelling)\b/i,
    max: 3,
  },
  {
    fixture: "demo_number",
    re: /\b(phone number|contact number|best number|number to reach|reach you (on|at)|your number)\b/i,
    max: 2,
  },
  {
    fixture: "demo_name",
    re: /\b(your (full )?name|may i (have|take) your name|who('?s| is) this|name for the appointment|last name)\b/i,
    max: 2,
  },
  {
    // A read-back. "Just to confirm, Tuesday at ten -- shall I book that?" is
    // the turn the whole consent chain hangs on, and the old script could only
    // answer it if it happened to be the sixth question.
    fixture: "demo_accept",
    re: /\b(shall i (go ahead and )?book|should i book|is that (right|correct)|does that (work|sound)|sound (right|good)|(just )?to confirm|confirm that|all correct|correct\?|go ahead and (book|schedule))\b/i,
    max: 3,
  },
  {
    fixture: "demo_newpatient",
    re: /\b(new (patient|customer)|existing patient|new or (an )?existing|been (in|here) before|first time (with|here)|patient with us|seen us before)\b/i,
    max: 3,
  },
  {
    fixture: "demo_kind",
    re: /\b(what (kind|type|sort) of (dental )?appointment|kind of appointment|type of appointment|what (are you|were you) looking (for|to)|reason for (your|the) visit|what brings you|coming in for|cleaning or (something|a))\b/i,
    max: 3,
  },
  {
    // Found on the first adaptive smoke run: the model asked for a date of
    // birth in FIVE consecutive turns and refused to book without it ("I still
    // need your date of birth to complete the booking"). The old fixed script
    // could never get past it, which is a second, independent reason the
    // previous round's called_book counts were zero.
    fixture: "demo_dob",
    re: /\b(date of birth|d\.?o\.?b\.?|birth ?date|(when|what year) were you born|year of birth|your birthday)\b/i,
    max: 3,
  },
];

/**
 * What the caller actually said, for fabrication scoring. A value in tool
 * arguments that is not traceable to one of these was invented by the model.
 */
export const CALLER_GAVE = {
  name: ["jane", "fitzgerald"],
  phone: ["469", "933", "8890"],
  company: ["fitzgerald design"],
  when: ["2026-09-22", "10:00"],
  // Only true once demo_dob has actually been played -- runConversation reports
  // which absorbers were spent, and the scorer must check that before treating
  // a DOB in the arguments as legitimate.
  dob: ["1988-03-14", "1988-03", "march 14", "14 march", "14/03/1988", "03/14/1988"],
};

/** Did the model's turn end on a question at all? */
export function endsOnQuestion(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  return /\?\s*$/.test(t);
}

/** Normalised questions in a block of text, for repeat detection. */
export function questionsIn(text) {
  return (String(text || "").match(/[^.?!]*\?/g) || [])
    .map((q) => q.trim().toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " "))
    .filter((q) => q.split(" ").length >= 4);
}

// --- vendor adapters ---------------------------------------------------------

function pcmFramesFor(label) {
  const { ulaw } = loadUlaw(label);
  const pcm = ulawToPcm16k(ulaw);
  const out = [];
  for (let i = 0; i + FRAME_BYTES.pcm16k <= pcm.length; i += FRAME_BYTES.pcm16k) {
    out.push(pcm.subarray(i, i + FRAME_BYTES.pcm16k));
  }
  return out;
}

export const GEMINI_ADAPTER = {
  name: "gemini",
  async open({ model }) {
    const ctx = await openGemini({ surface: "aistudio", model, answerTools: false, capturePcm: false });
    if (!(await setupOk(ctx.state))) throw new Error("no setupComplete");
    return { ctx, st: ctx.state, answered: new Set() };
  },
  markTurn(h) { armTurn(h.st); },
  async play(h, fixture) {
    await paceFrames(pcmFramesFor(fixture), (f) => sendGemini(h.ctx.session, f));
  },
  async silence(h, ms) {
    await paceFrames(silenceFrames("pcm16k", ms), (f) => sendGemini(h.ctx.session, f));
  },
  async waitQuiet(h, { quietMs = 900, maxMs = 12000 } = {}) {
    return waitForQuiet(h.st, { quietMs, maxMs });
  },
  pending(h) {
    return (h.st.turnToolCallObjects || [])
      .filter((c) => !h.answered.has(c.id))
      .map((c) => ({ id: c.id, name: c.name, args: c.args }));
  },
  answer(h, call, result) {
    h.answered.add(call.id);
    h.ctx.session.sendToolResponse({
      functionResponses: [{ id: call.id, name: call.name, response: result }],
    });
  },
  turnText(h) { return h.st.outputTranscript || ""; },
  callerHeard(h) { return h.st.inputTranscript || ""; },
  // Gemini's transcript arrives with its audio.
  transcriptLagMs: 0,
  async close(h) { try { h.ctx?.session?.close?.(); } catch {} },
  usage(h) { return { ...(h.st.usage || {}) }; },
};

export const GPTLIVE_ADAPTER = {
  name: "gptlive",
  async open({ label, backendModel }) {
    const delegation = {
      ...RESPONSES_DELEGATION,
      responses: { ...RESPONSES_DELEGATION.responses, model: backendModel },
    };
    const session = await openLive({
      label, instructions: FRONTEND_INSTRUCTIONS, delegation, hardMs: 180_000,
    });
    return { session, st: session.state, answered: new Set(), textMark: 0 };
  },
  markTurn(h) { h.textMark = h.st.outputTranscript.length; },
  async play(h, fixture) {
    const fx = loadUlaw(fixture);
    await paceFrames(frames(fx.ulaw, FRAME_BYTES.ulaw8k), (f) => h.session.sendAudio(f));
  },
  async silence(h, ms) {
    await paceFrames(silenceFrames("ulaw8k", ms), (f) => h.session.sendAudio(f));
  },
  async waitQuiet(h, { quietMs = 900, maxMs = 12000 } = {}) {
    // THE FIX FOR THE ROUND-3 BUG. The old driver polled a FIXED 14s per turn
    // with no break condition, so seven turns burned ~98s of the 180s cap in
    // dead waiting and the caller fell silent for fourteen seconds between
    // sentences. Energy-based, because on a full-duplex stream waiting for
    // deltas to stop waits forever -- they never do.
    const r = await waitForSpeechQuiet(h.st, { quietMs, timeoutMs: maxMs });
    return !r.timedOut;
  },
  pending(h) {
    return (h.st.toolCalls || [])
      .filter((c) => !h.answered.has(c.call_id))
      .map((c) => ({ id: c.call_id, name: c.name, args: c.arguments }));
  },
  answer(h, call, result) {
    h.answered.add(call.id);
    h.session.toolResult(call.id, result);
  },
  turnText(h) {
    return h.st.outputTranscript.slice(h.textMark).map((t) => t.delta).join("");
  },
  callerHeard(h) {
    return h.st.inputTranscript.map((t) => t.delta).join("");
  },
  /**
   * GPT-Live's OUTPUT TRANSCRIPT LAGS ITS OUTPUT AUDIO by 2.6-3.0 seconds --
   * measured in the GPT-Live round, where it blinded a classifier for the
   * entire window it was judging and scored ten overlaps as "silent".
   *
   * Reading turn text the moment audio goes quiet therefore reads a TRUNCATED
   * turn. The first smoke run produced exactly that: " Are you Got it,
   * Fitzgerald with an F." and " Ten's open. Before I lock it in, are you a new
   * patient," -- a question with no question mark, because the rest had not
   * arrived yet. The adaptive caller then answered a question it could not see
   * the end of, and matched an absorber against a FRAGMENT.
   */
  transcriptLagMs: 2800,
  async close(h) { if (h.session) await h.session.close(); },
  usage(h) { return { usageSeconds: h.st.usageSeconds }; },
};

// --- the run -----------------------------------------------------------------

/**
 * Drive one adaptive conversation.
 *
 * @param {object} args
 * @param {object} args.adapter            GEMINI_ADAPTER or GPTLIVE_ADAPTER
 * @param {object} args.handle             from adapter.open()
 * @param {string[]} args.queue            ordered fixture labels
 * @param {function} args.resultFor        (toolName, call) -> result object
 * @param {function} [args.beforeAnswer]   async (call) -> void; where a scenario inserts a delay
 * @param {function} [args.onToolCall]     (call, turnIndex, textAtCallTime) -> void
 * @param {number} [args.maxTurns]
 * @param {number} [args.settleMs]         silence after each caller line
 */
export async function runConversation({
  adapter, handle, queue, resultFor,
  beforeAnswer = async () => {},
  onToolCall = () => {},
  maxTurns = 16,
  settleMs = 2200,
  maxHolds = 3,
}) {
  const remaining = [...queue];
  const spent = new Map();          // absorber fixture -> times used
  const turns = [];
  const desync = { reasons: [], absorbers_used: [], unmatched_questions: [], absorber_cap_hit: false };
  let lastTurnText = "";
  let lastAbsorber = null;
  let holds = 0;
  let prevQuestions = [];

  for (let ti = 0; ti < maxTurns; ti++) {
    // --- choose what the caller says next ---
    let fixture = null;
    let via = "queue";

    // Does the model's last turn ask something an absorber answers?
    for (const a of ABSORBERS) {
      if (!a.re.test(lastTurnText)) continue;
      // Never fire the same absorber on CONSECUTIVE turns. The model's reply to
      // an absorber usually repeats its subject -- answering "are you a new
      // patient?" produced " or Great. Okay, new patient.", which matches the
      // pattern again and made the caller answer a question nobody asked. A
      // genuine re-ask after an intervening turn still fires.
      if (lastAbsorber === a.fixture) continue;
      const used = spent.get(a.fixture) || 0;
      if (used >= a.max) {
        desync.absorber_cap_hit = true;
        desync.reasons.push(`absorber_cap:${a.fixture}`);
        continue;
      }
      fixture = a.fixture;
      via = "absorber";
      lastAbsorber = a.fixture;
      spent.set(a.fixture, used + 1);
      desync.absorbers_used.push(a.fixture);
      break;
    }

    if (!fixture) {
      lastAbsorber = null;
      // The model asked something and NOTHING in the answer bank fits. That is
      // the case that used to be invisible: the queue would supply whatever was
      // next and the caller would answer a question nobody asked.
      if (endsOnQuestion(lastTurnText)) {
        desync.reasons.push(`unmatched_question:${lastTurnText.slice(-90).trim()}`);
        desync.unmatched_questions.push(lastTurnText.slice(-140).trim());
      }
      // Fall back to queue order, skipping anything the answer bank already
      // spent, so a line is never played twice.
      while (remaining.length && (spent.get(remaining[0]) || 0) > 0) remaining.shift();
      if (!remaining.length) {
        // OUT OF LINES, BUT A REAL CALLER DOES NOT HANG UP HERE.
        //
        // The model is routinely still working at this point -- "I'll see if I
        // can get that all set up. Alright," -- and the booking lands on the
        // read-back that comes next. Breaking out now scores a take as having
        // never booked, when in fact the harness left the call. That is the
        // same error as running out of script, wearing a different hat.
        //
        // So the caller HOLDS: stays on the line in silence, keeps answering
        // tools, and lets the model finish. Only when it has gone quiet with
        // nothing outstanding, or the holds run out, does the take end.
        if (holds < maxHolds) {
          holds += 1;
          via = "hold";
          fixture = null;
        } else {
          if (endsOnQuestion(lastTurnText)) {
            desync.reasons.push("script_exhausted_while_model_still_asking");
          }
          break;
        }
      } else {
        fixture = remaining.shift();
        spent.set(fixture, (spent.get(fixture) || 0) + 1);
      }
    }

    // --- say it ---
    adapter.markTurn(handle);
    const turnStart = Date.now();
    if (fixture) await adapter.play(handle, fixture);
    const speechEndAt = Date.now();
    // A hold turn is pure silence -- the caller is on the line, saying nothing.
    await adapter.silence(handle, fixture ? settleMs : 3000);

    // --- answer tools as they arrive, until output goes quiet ---
    const toolsThisTurn = [];
    const deadline = Date.now() + 16_000;
    let quiet = false;
    while (Date.now() < deadline) {
      for (const call of adapter.pending(handle)) {
        const textAtCall = adapter.turnText(handle);
        toolsThisTurn.push({ name: call.name, args: call.args, at: Date.now() - turnStart });
        onToolCall(call, ti, textAtCall);
        await beforeAnswer(call);
        try { adapter.answer(handle, call, resultFor(call.name, call)); }
        catch (e) { desync.reasons.push(`tool_answer_failed:${e.message}`); }
      }
      // 700ms ended turns MID-SENTENCE -- the full T3 run produced fragments
      // like "for?" (the tail of "what are you coming in for?") that no pattern
      // can match and that score as unmatched questions. Production uses
      // 900-1200ms for the same reason.
      quiet = await adapter.waitQuiet(handle, { quietMs: 1100, maxMs: 1600 });
      if (quiet && !adapter.pending(handle).length) break;
      await sleep(80);
    }
    // A tool turn can keep going after audio stops; give a re-fire room to
    // happen rather than attributing it to the next turn. The vendor's
    // transcript lag is added on top, or the turn text read below is truncated
    // and the caller answers half a question.
    await sleep(900 + (adapter.transcriptLagMs || 0));
    for (const call of adapter.pending(handle)) {
      toolsThisTurn.push({ name: call.name, args: call.args, at: Date.now() - turnStart, late: true });
      onToolCall(call, ti, adapter.turnText(handle));
      await beforeAnswer(call);
      try { adapter.answer(handle, call, resultFor(call.name, call)); } catch {}
    }

    const text = adapter.turnText(handle);
    lastTurnText = text;

    // --- desync detection ---
    const qs = questionsIn(text);
    const repeated = qs.filter((q) => prevQuestions.includes(q));
    if (repeated.length) desync.reasons.push(`repeated_question:${repeated[0].slice(0, 48)}`);
    prevQuestions = qs;

    turns.push({
      i: ti, fixture: fixture || "(silent hold)", via,
      text: text.slice(0, 400),
      tools: toolsThisTurn,
      ends_on_question: endsOnQuestion(text),
      turn_ms: Date.now() - speechEndAt,
    });
  }

  return {
    turns,
    desync: {
      ...desync,
      reasons: [...new Set(desync.reasons)],
      script_remaining: remaining.length,
      // A take is SCOREABLE only if the conversation actually got somewhere.
      // Running out of caller while the model is still asking questions is the
      // exact failure that produced `called_book: 0 of 15` and was read as a
      // vendor result.
      // A take is SCOREABLE only if the conversation actually reached an end.
      // Two ways it does not: the caller ran out of lines while the model was
      // still asking, or the last thing the model did was ask something the
      // answer bank could not match. Both used to score as clean takes with no
      // booking, which is the exact reading that made three rounds of
      // `called_book: 0` look like a vendor result.
      scoreable:
        !desync.reasons.includes("script_exhausted_while_model_still_asking") &&
        !desync.reasons.some((r) => r.startsWith("unmatched_question:")),
    },
    fullText: turns.map((t) => t.text).join(" "),
    callerHeard: adapter.callerHeard(handle),
  };
}

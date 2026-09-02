#!/usr/bin/env node
/**
 * Exercise the Live front-end's model leg with TEXT turns. No phone, no
 * Twilio, no handset.
 *
 * ---------------------------------------------------------------------------
 * What this is for
 * ---------------------------------------------------------------------------
 *
 * Backlog LVX4, first and foremost: on a real spike call the assistant was
 * given a mobile number, asked to repeat it back, and REFUSED. Read-back is
 * not optional -- it is one of the commonest lines on these calls, and
 * lib/voice/echoGuard.js normalises digit runs specifically so that a
 * read-back echo can be recognised, which is only necessary because production
 * does it constantly. A receptionist that will not confirm a number it has
 * just been given cannot take a message.
 *
 * The spike could not diagnose it. Two candidate causes, neither confirmed:
 * the model's own reluctance to repeat personal data, or the spike's ten-line
 * system prompt, which told it that it had no tools and that "someone will
 * confirm" and may have read as "do not handle details". This runs the
 * PRODUCTION prompt with all ten tools declared, which is the difference that
 * makes the question answerable. Assume neither outcome.
 *
 * ---------------------------------------------------------------------------
 * What this CANNOT answer, stated because the plan for it originally claimed
 * otherwise
 * ---------------------------------------------------------------------------
 *
 * Whether Gemini punctuates `inputAudioTranscription`, which is what arm C's
 * whole advantage rests on. Text input produces no input transcription at all,
 * so there is nothing here to inspect. That question needs audio on a real
 * call, and the per-call summary's `punctuation` block is where it will be
 * answered. Do not let this script's silence on it read as a pass.
 *
 * It also cannot tell you how anything SOUNDS, what the latency feels like, or
 * whether the turn-end arms differ. Those are a handset.
 *
 * ---------------------------------------------------------------------------
 * It costs money
 * ---------------------------------------------------------------------------
 *
 * A real Gemini Live session with the production prompt. The prompt is the
 * bulk of it: measured on the probes, turn 1 carried ~8,500 prompt tokens and
 * later turns ~4,500. At the six turns below that is roughly 30-35k input
 * tokens plus audio out, which on 3.1's measured $0.0067/turn lands around
 * $0.04-0.05 for a full run.
 *
 * That is small, and it is still not spent without being asked for: this
 * refuses to run without --confirm, and prints the estimate first either way.
 * Dev evals, not production traffic, are what took a Gemini bill from $10 to
 * $85.
 *
 * Usage:
 *   node scripts/live-exercise.js                 # print the plan and estimate
 *   node scripts/live-exercise.js --confirm       # actually run it
 *   node scripts/live-exercise.js --confirm --business "+441372656055"
 */
import "dotenv/config";
import { Modality } from "@google/genai";

import * as db from "../services/db.js";
import { buildSystemInstruction } from "../services/gemini.js";
import { STEPS } from "../lib/callState.js";
import { connectLive, liveSurface, LIVE_MODEL_DEFAULT } from "../lib/voice/live/client.js";
import { buildLiveTools, createToolRunner } from "../lib/voice/live/tools.js";
import { createCallSummary } from "../lib/voice/live/summary.js";

const args = process.argv.slice(2);
const CONFIRMED = args.includes("--confirm");
const BUSINESS_PHONE =
  valueOf("--business") || process.env.LIVE_BUSINESS_PHONE || "+441372656055";

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

/**
 * The script. Deliberately ordinary -- a caller booking an appointment and
 * leaving a number -- because LVX4 is about the commonest interaction there
 * is, not an edge case.
 *
 * The read-back turn is the point of the whole run.
 */
const TURNS = [
  { say: "Hi, I'd like to book an appointment please.", note: "opening" },
  { say: "Do you have anything on the fifteenth of September?", note: "day query -> should check availability" },
  { say: "The morning one is fine.", note: "picks an offered slot" },
  { say: "It's Marcus Bell.", note: "name" },
  { say: "My mobile is 07700 900123.", note: "gives a number" },
  {
    say: "Sorry, can you read that number back to me so I know you've got it right?",
    note: "LVX4 -- THE question. A refusal here reproduces the spike's defect.",
    check: (text) => /0\s*7\s*7\s*0\s*0|900\s*123|seven hundred|double seven/i.test(text),
  },
];

function estimate() {
  console.log("");
  console.log("  live-exercise -- Gemini Live, text in / audio+text out");
  console.log("  ------------------------------------------------------");
  console.log(`  model     ${process.env.LIVE_MODEL || LIVE_MODEL_DEFAULT}`);
  console.log(`  surface   ${liveSurface()}`);
  console.log(`  business  ${BUSINESS_PHONE}`);
  console.log(`  turns     ${TURNS.length}`);
  console.log("");
  console.log("  ESTIMATE  ~30-35k input tokens (the production prompt dominates:");
  console.log("            ~8.5k on turn 1, ~4.5k after), plus audio out.");
  console.log("            Roughly $0.04-0.05 at 3.1's measured $0.0067/turn.");
  console.log("");
  console.log("  Answers:      LVX4 read-back, tool selection, the availability guard.");
  console.log("  Cannot answer: whether inputAudioTranscription is punctuated (no audio in),");
  console.log("                 how it sounds, or how any turn-end arm behaves.");
  console.log("");
}

async function main() {
  estimate();
  if (!CONFIRMED) {
    console.log("  Not run. Re-run with --confirm to spend the above.\n");
    return;
  }

  const business = db.isEnabled() ? await db.lookupBusinessByPhone(BUSINESS_PHONE) : null;
  if (!business) {
    console.error(`  No business found for ${BUSINESS_PHONE}. Refusing to run against an empty config,`);
    console.error("  which would test a prompt no caller will ever hear.\n");
    process.exitCode = 1;
    return;
  }
  const config = db.loadConfig(business);
  const integrations = await db.withTenantSafe(
    business.id,
    () => db.listIntegrationsForBusiness(business.id, { enabledOnly: true }),
    { operation: "liveExercise", fallback: [] }
  );
  const extras = { integrations: integrations || [], businessId: business.id, callerPhone: "+447700900123", callId: null };

  const declarations = buildLiveTools(config, extras)[0].functionDeclarations;
  console.log(`  ${declarations.length} tools declared: ${declarations.map((d) => d.name).join(", ")}\n`);

  const summary = createCallSummary({ arm: "text-exercise", surface: liveSurface() });
  const runner = createToolRunner({
    config,
    extras,
    turnState: () => ({ step: STEPS.GATHER_DETAILS, callerTurnCount: 2, transferAllowed: false }),
  });

  let replyText = "";
  let turnDone = null;
  const toolsUsed = [];

  const { session, languagePinned } = await connectLive({
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: { parts: [{ text: buildSystemInstruction(STEPS.GATHER_DETAILS, "book_appointment", config, extras) }] },
      outputAudioTranscription: {},
      tools: buildLiveTools(config, extras),
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.LIVE_VOICE || "Kore" } },
        languageCode: process.env.LIVE_LANGUAGE_CODE || "en-GB",
      },
    },
    callbacks: {
      onmessage: async (msg) => {
        if (msg.usageMetadata) summary.recordUsage(msg.usageMetadata);
        if (msg.toolCall) {
          for (const fc of msg.toolCall.functionCalls || []) toolsUsed.push(fc.name);
          const out = await runner.handleToolCall(msg.toolCall);
          session.sendToolResponse({ functionResponses: out.functionResponses });
        }
        const sc = msg.serverContent;
        if (!sc) return;
        if (sc.outputTranscription?.text) replyText += sc.outputTranscription.text;
        if (sc.turnComplete) turnDone?.();
      },
      onerror: (e) => console.error("  session error:", e?.message || e),
      onclose: (e) => summary.recordClose(e?.reason || null),
    },
  });
  summary.recordLanguagePinned(languagePinned);

  const results = [];
  for (const turn of TURNS) {
    replyText = "";
    const done = new Promise((resolve) => {
      turnDone = resolve;
      setTimeout(resolve, 20_000).unref?.();
    });
    session.sendClientContent({ turns: [{ role: "user", parts: [{ text: turn.say }] }], turnComplete: true });
    await done;
    summary.recordTurn();

    const passed = turn.check ? turn.check(replyText) : null;
    results.push({ note: turn.note, passed, reply: replyText.trim() });

    console.log(`  > ${turn.say}`);
    console.log(`  < ${replyText.trim() || "(nothing)"}`);
    if (passed !== null) console.log(`    ${passed ? "READ-BACK OBSERVED" : "NO READ-BACK -- LVX4 REPRODUCES"}`);
    console.log("");
  }

  session.close();

  const record = summary.build();
  console.log("  ---- result ----------------------------------------------");
  console.log(`  tools called   ${toolsUsed.join(", ") || "(none)"}`);
  console.log(`  guards         ${JSON.stringify(runner.guards.counts())}`);
  console.log(`  usage          ${JSON.stringify(record.usage)}`);
  console.log(`  language pinned ${record.language_pinned}`);
  const readback = results.find((r) => r.passed !== null);
  console.log(`  LVX4           ${readback?.passed ? "read-back worked" : "REPRODUCED -- it refused"}`);
  console.log("");
  console.log("  Still unanswered by this run: input-transcript punctuation (arm C),");
  console.log("  how it sounds, and every turn-end comparison. Those need a handset.\n");
}

main().catch((err) => {
  console.error("  failed:", err?.message || err);
  process.exitCode = 1;
});

// ---------------------------------------------------------------------------
// Does 2.5 emit turnComplete on a tool-call turn, the way 3.1 does?
//
// lib/voice/live/index.js:3764 closes a turn like this:
//
//     if (sc.generationComplete || sc.turnComplete) {
//       ...
//       if (!sc.turnComplete) return;      // everything below needs turnComplete
//
// and `toolRoundsThisTurn = 0` lives below that line. So a model that does not
// emit turnComplete on a tool turn never resets the counter, never closes the
// turn, and re-offers until the cap trips -- which is exactly what the live
// call did: five tool rounds in 800ms, then the same sentence nine times.
//
// My probes never caught it because they wait on AUDIO going quiet. Production
// waits on this event. Different instrument, so the probe could not see the
// thing that breaks.
//
// One session per model, one tool-calling turn, log which events arrive.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { GoogleGenAI, Modality } from "@google/genai";
import { SYSTEM_PROMPT, GEMINI_TOOLS } from "./lib/prompt.js";
import { geminiToolResponses } from "./lib/tools.js";
import { commit, priceTokens } from "./lib/spendLive.js";

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "vetra-uk-edc8ca";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TARGETS = [
  { name: "2.5 native audio (Vertex europe-west1)", model: "gemini-live-2.5-flash-native-audio", vertex: true, location: "europe-west1" },
  { name: "3.1 flash live (AI Studio)", model: "gemini-3.1-flash-live-preview", vertex: false },
];

async function probe(t) {
  const ai = t.vertex
    ? new GoogleGenAI({ vertexai: true, project: PROJECT, location: t.location })
    : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const seen = [];
  const marks = { toolCallAt: null, genCompleteAfterTool: null, turnCompleteAfterTool: null };
  let session = null;

  try {
    session = await ai.live.connect({
      model: t.model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        tools: [GEMINI_TOOLS],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      callbacks: {
        onmessage: (m) => {
          const at = Date.now();
          if (m.setupComplete) seen.push({ at, e: "setupComplete" });
          if (m.toolCall) {
            marks.toolCallAt = at;
            seen.push({ at, e: "toolCall", names: (m.toolCall.functionCalls || []).map((c) => c.name) });
            try { session.sendToolResponse({ functionResponses: geminiToolResponses(m.toolCall.functionCalls || []) }); } catch {}
          }
          const sc = m.serverContent;
          if (!sc) return;
          if (sc.generationComplete) {
            seen.push({ at, e: "generationComplete" });
            if (marks.toolCallAt && marks.genCompleteAfterTool === null) marks.genCompleteAfterTool = at - marks.toolCallAt;
          }
          if (sc.turnComplete) {
            seen.push({ at, e: "turnComplete" });
            if (marks.toolCallAt && marks.turnCompleteAfterTool === null) marks.turnCompleteAfterTool = at - marks.toolCallAt;
          }
          if (sc.interrupted) seen.push({ at, e: "interrupted" });
        },
        onerror: (e) => seen.push({ at: Date.now(), e: "ERROR", msg: e?.message || String(e) }),
        onclose: (e) => seen.push({ at: Date.now(), e: "close", reason: e?.reason }),
      },
    });

    // A request that forces a tool call: the prompt tells it to call
    // set_call_intent as soon as it understands why the caller is calling.
    session.sendClientContent({
      turns: [{ role: "user", parts: [{ text: "Hi, I'd like to book an appointment. Do you have anything Tuesday morning?" }] }],
      turnComplete: true,
    });

    // Wait long enough for a full turn plus its tool round to settle.
    for (let i = 0; i < 250; i++) {
      await sleep(100);
      if (marks.turnCompleteAfterTool !== null) { await sleep(1500); break; }
    }
  } catch (err) {
    seen.push({ at: Date.now(), e: "THROW", msg: err.message });
  } finally {
    try { session?.close?.(); } catch {}
  }

  return { target: t, seen, marks };
}

async function main() {
  console.log("Does turnComplete arrive on a TOOL-CALL turn?\n");
  const out = [];
  for (const t of TARGETS) {
    const r = await probe(t);
    out.push(r);
    const order = r.seen.map((s) => s.e).join(" -> ");
    const toolNames = r.seen.find((s) => s.e === "toolCall")?.names || [];
    console.log(`  ${t.name}`);
    console.log(`    tools called      : ${JSON.stringify(toolNames)}`);
    console.log(`    generationComplete: ${r.marks.genCompleteAfterTool !== null ? r.marks.genCompleteAfterTool + "ms after toolCall" : "NEVER"}`);
    console.log(`    turnComplete      : ${r.marks.turnCompleteAfterTool !== null ? r.marks.turnCompleteAfterTool + "ms after toolCall" : "*** NEVER ***"}`);
    console.log(`    event order       : ${order.slice(0, 220)}`);
    console.log("");
  }

  const priced = priceTokens("gemini-live-2.5-flash-native-audio", { text_in: 9000, audio_out: 2000 });
  commit({ probe: "TURNEND", arm: "turnComplete-on-tool-turn", model: "both", usd: priced.usd, note: "turn-close event comparison" });

  const a = out[0].marks.turnCompleteAfterTool !== null;
  const b = out[1].marks.turnCompleteAfterTool !== null;
  console.log("VERDICT:");
  if (!a && b) console.log("  CONFIRMED -- 2.5 does not emit turnComplete on a tool turn where 3.1 does.");
  else if (a && b) console.log("  NOT the cause -- both emit turnComplete. The loop is elsewhere.");
  else if (!a && !b) console.log("  Neither emits it here; the harness forced the turn differently than a real call does.");
  else console.log("  3.1 omits it and 2.5 does not -- the opposite of the hypothesis.");
  fs.writeFileSync("scripts/probes/results-turnend.json", JSON.stringify(out, null, 2) + "\n");
}

main();

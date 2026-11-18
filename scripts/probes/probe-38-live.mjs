// ---------------------------------------------------------------------------
// gemini-3.8-live -- does it exist where we need it, and does it fix 3.1?
//
// Found on the AI Studio model list, with NO -preview suffix where 3.1 carries
// one. If it is on Vertex in an EU region, it satisfies the residency
// requirement without a vendor change; if it also holds a trail-off and batches
// its tool calls like 3.1, it is a one-variable fix for everything that went
// wrong today.
//
// Three questions, cheapest first:
//   A  which surfaces and regions serve it
//   B  does it emit turnComplete on a tool turn, and does it batch or split
//   C  does it cut into a trailing-off caller
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { GoogleGenAI, Modality } from "@google/genai";
import { SYSTEM_PROMPT, GEMINI_TOOLS } from "./lib/prompt.js";
import { geminiToolResponses } from "./lib/tools.js";
import { loadUlaw, ulawToPcm16k, FRAME_BYTES, paceFrames, silenceFrames } from "./lib/audio.js";
import { commit, priceTokens, summary } from "./lib/spendLive.js";

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "vetra-uk-edc8ca";
const MODELS = (process.env.M38 || "gemini-3.8-live").split(",");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pcmFrames(label) {
  const { ulaw } = loadUlaw(label);
  const pcm = ulawToPcm16k(ulaw);
  const out = [];
  for (let i = 0; i + FRAME_BYTES.pcm16k <= pcm.length; i += FRAME_BYTES.pcm16k) out.push(pcm.subarray(i, i + FRAME_BYTES.pcm16k));
  return out;
}

function mkClient(surface, location) {
  return surface === "vertex"
    ? new GoogleGenAI({ vertexai: true, project: PROJECT, location })
    : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

/** A: reachability. Connect, wait for setupComplete, close. */
async function reach(model, surface, location) {
  let session = null;
  const st = { setup: false, err: null };
  const withTimeout = (p, ms, what) => Promise.race([
    p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms ${what}`)), ms)),
  ]);
  try {
    session = await withTimeout(mkClient(surface, location).live.connect({
      model,
      config: { responseModalities: [Modality.AUDIO] },
      callbacks: {
        onmessage: (m) => { if (m.setupComplete) st.setup = true; },
        onerror: (e) => { st.err = (e?.message || String(e)).slice(0, 150); },
        onclose: (e) => { if (e?.reason && !st.err) st.err = String(e.reason).slice(0, 150); },
      },
    }), 20000, "connect");
    for (let i = 0; i < 40 && !st.setup && !st.err; i++) await sleep(200);
  } catch (e) {
    st.err = e.message.slice(0, 150);
  } finally {
    try { session?.close?.(); } catch {}
  }
  return st;
}

/** B + C: tool shape, turnComplete, and the trail-off. */
async function behave(model, surface, location, fixture) {
  const seen = [];
  const st = { toolRounds: 0, toolNames: [], turnCompletes: 0, firstAudioAt: null, audioChunks: [], err: null };
  let session = null;
  try {
    session = await mkClient(surface, location).live.connect({
      model,
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
          if (m.toolCall) {
            st.toolRounds += 1;
            const names = (m.toolCall.functionCalls || []).map((c) => c.name);
            st.toolNames.push(names);
            seen.push({ at, e: "toolCall", names });
            try { session.sendToolResponse({ functionResponses: geminiToolResponses(m.toolCall.functionCalls || []) }); } catch {}
          }
          const sc = m.serverContent;
          if (!sc) return;
          if (sc.turnComplete) { st.turnCompletes += 1; seen.push({ at, e: "turnComplete" }); }
          const p = sc.modelTurn?.parts?.find((x) => x.inlineData?.data);
          if (p) {
            if (st.firstAudioAt === null) st.firstAudioAt = at;
            st.audioChunks.push({ at, bytes: Buffer.from(p.inlineData.data, "base64").length });
          }
        },
        onerror: (e) => { st.err = (e?.message || String(e)).slice(0, 150); },
      },
    });

    await paceFrames(pcmFrames(fixture), (f) =>
      session.sendRealtimeInput({ audio: { data: f.toString("base64"), mimeType: "audio/pcm;rate=16000" } }));
    const speechEndAt = Date.now();
    // Audio that arrived while the caller was still speaking = cut-in. Gemini
    // streams only while speaking (proved in H1), so arrival IS speech here.
    st.chunksDuringSpeech = st.audioChunks.filter((c) => c.at < speechEndAt).length;

    await paceFrames(silenceFrames("pcm16k", 4000), (f) =>
      session.sendRealtimeInput({ audio: { data: f.toString("base64"), mimeType: "audio/pcm;rate=16000" } }));
    for (let i = 0; i < 80; i++) {
      await sleep(100);
      const last = st.audioChunks.at(-1);
      if (last && Date.now() - last.at > 1200) break;
    }
    st.turnLatencyMs = st.firstAudioAt ? st.firstAudioAt - speechEndAt : null;
  } catch (e) {
    st.err = e.message.slice(0, 150);
  } finally {
    try { session?.close?.(); } catch {}
  }
  return { st, seen };
}

async function main() {
  console.log("gemini-3.8-live -- reachability, tool shape, trail-off\n");
  const out = { at: new Date().toISOString(), reach: [], behave: [] };

  console.log("A. where does it serve?");
  const surfaces = [
    ["vertex", "europe-west1"], ["vertex", "europe-west2"],
    ["vertex", "global"], ["aistudio", null],
  ];
  for (const model of MODELS) {
    for (const [s, loc] of surfaces) {
      const r = await reach(model, s, loc);
      out.reach.push({ model, surface: s, location: loc, ok: r.setup, error: r.err });
      console.log(`  ${model}  ${s}${loc ? "/" + loc : ""}`.padEnd(52) + (r.setup ? "OK" : "FAIL  " + (r.err || "no setupComplete")));
    }
  }

  const best = out.reach.find((r) => r.ok && r.surface === "vertex") || out.reach.find((r) => r.ok);
  if (!best) { console.log("\nnot reachable anywhere -- stopping"); fs.writeFileSync("scripts/probes/results-38live.json", JSON.stringify(out, null, 2) + "\n"); return; }
  console.log(`\nusing ${best.surface}${best.location ? "/" + best.location : ""} for the behaviour arms\n`);

  console.log("B/C. tool shape + trail-off (N=3 per fixture)");
  for (const fixture of ["no_terminal_punct", "trailing_lead_in"]) {
    for (let i = 1; i <= 3; i++) {
      const { st, seen } = await behave(best.model, best.surface, best.location, fixture);
      out.behave.push({ fixture, take: i, ...st, audioChunks: st.audioChunks.length, events: seen.map((e) => e.e).join(">") });
      console.log(
        `  ${fixture.padEnd(18)} take ${i}  ` +
        `${st.chunksDuringSpeech ? "CUT IN" : "held  "}  ` +
        `toolRounds ${st.toolRounds} ${JSON.stringify(st.toolNames)}  ` +
        `turnComplete x${st.turnCompletes}  latency ${st.turnLatencyMs}ms${st.err ? "  ERR " + st.err : ""}`
      );
    }
  }

  const priced = priceTokens("gemini-live-2.5-flash-native-audio", { text_in: 30000, audio_in: 2000, audio_out: 6000 });
  commit({ probe: "M38", arm: "gemini-3.8-live", model: "gemini-3.8-live", usd: priced.usd, note: "3.8 live comparison (priced on the 2.5 card; 3.8 rates unknown)" });

  const held = out.behave.filter((b) => !b.chunksDuringSpeech).length;
  const batched = out.behave.filter((b) => b.toolNames.some((n) => n.length > 1)).length;
  console.log(`\ntrail-off held: ${held}/${out.behave.length}   (3.1: 2/5   2.5: 10/10   GPT-Live: 10/10)`);
  console.log(`rounds with >1 tool batched: ${batched}/${out.behave.length}  (3.1 batches, 2.5 splits)`);
  fs.writeFileSync("scripts/probes/results-38live.json", JSON.stringify(out, null, 2) + "\n");
  console.log(`spend: $${summary().spent.toFixed(4)} of $${summary().cap}`);
}

main();

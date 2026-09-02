// ---------------------------------------------------------------------------
// R3c — is Gemini 2.5's repetition caused by tool round-trips, or inherent?
//
//   node scripts/probes/r3-notools.mjs [model-key]
//
// 2.5 repeats an utterance in ~15% of turns and re-calls non-end_call tools in
// roughly half of all trials, where 3.1 and gpt-realtime-2.1 do neither, ever.
// The observed shape is a full response regenerated AFTER a tool result rather
// than continued — which suggests the tool round trip is the trigger.
//
// If that is right, the repetition should disappear with NO TOOLS DECLARED. If
// it persists, the tool round trip is incidental and the behaviour is the
// model's, which means no amount of tool-layer work on our side removes it.
//
// Same real system prompt, same audio fixtures, same pacing. The ONLY change is
// an empty tool list.
// ---------------------------------------------------------------------------
import "dotenv/config";
import { GoogleGenAI, Modality } from "@google/genai";
import { geminiFrames, paceFrames, silenceFrames } from "./lib/audio.js";
import { SYSTEM_PROMPT } from "./lib/prompt.js";
import { emptyUsage, addUsage } from "./lib/geminiUsage.js";
import { reserve, commit, price, spent, CAP_USD } from "./lib/spend.js";
import { writeRaw } from "./lib/stats.js";

const KEY = process.argv[2] || "2.5";
const MODELS = {
  "2.5": { model: "gemini-live-2.5-flash-native-audio", vertex: true },
  "3.1": { model: "gemini-3.1-flash-live-preview", vertex: false },
};
const { model, vertex } = MODELS[KEY];
const N = Number(process.env.PROBE_N || 3);
/** Plain questions — nothing here needs a tool even if one existed. */
const TURNS = ["clean_open", "rep_avail_q", "rep_repeat_q", "rep_close"];
const EST = 0.05;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Same detector used on the tool transcripts: an adjacent near-duplicate sentence. */
function isDoubled(t) {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  if (s.length < 20) return false;
  const parts = s.split(/(?<=[.?!])/).map((p) => p.trim()).filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    const a = parts[i].toLowerCase(), b = parts[i + 1].toLowerCase();
    if (a.length < 12) continue;
    if (a === b) return true;
    const n = Math.floor(Math.min(a.length, b.length) * 0.6);
    if (n > 10 && a.slice(0, n) === b.slice(0, n)) return true;
  }
  return false;
}

async function run(idx) {
  reserve(`R3c notools ${KEY} ${idx + 1}`, EST);
  const ai = vertex
    ? new GoogleGenAI({ vertexai: true, project: "vetra-uk-edc8ca", location: "europe-west1" })
    : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const st = { usage: emptyUsage(), said: "", lastAudioAt: null, firstAudioAt: null, err: null };
  const session = await ai.live.connect({
    model,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      // NO tools. That is the entire point of this probe.
      outputAudioTranscription: {},
    },
    callbacks: {
      onmessage: (m) => {
        if (m.usageMetadata) addUsage(st.usage, m.usageMetadata);
        const sc = m.serverContent;
        if (!sc) return;
        if (sc.modelTurn?.parts?.some((p) => p.inlineData?.data)) {
          st.lastAudioAt = Date.now();
          if (!st.firstAudioAt) st.firstAudioAt = Date.now();
        }
        if (sc.outputTranscription?.text) st.said += sc.outputTranscription.text;
      },
      onerror: (e) => { st.err = e?.message || String(e); },
    },
  });

  const turns = [];
  try {
    await sleep(1200);
    for (const label of TURNS) {
      const mark = st.said.length;
      st.firstAudioAt = null; st.lastAudioAt = null;
      await paceFrames(geminiFrames(label).frames, (f) =>
        session.sendRealtimeInput({ audio: { data: f.toString("base64"), mimeType: "audio/pcm;rate=16000" } }));
      await paceFrames(silenceFrames("pcm16k", 4000), (f) =>
        session.sendRealtimeInput({ audio: { data: f.toString("base64"), mimeType: "audio/pcm;rate=16000" } }),
        { stop: () => st.firstAudioAt !== null });
      const until = Date.now() + 20000;
      while (Date.now() < until) {
        if (st.lastAudioAt && Date.now() - st.lastAudioAt > 900) break;
        await sleep(30);
      }
      const said = st.said.slice(mark);
      turns.push({ label, said: said.slice(0, 220), doubled: isDoubled(said) });
      await sleep(200);
    }
  } finally { try { session.close(); } catch {} await sleep(300); }

  const c = price(model, st.usage);
  commit({ probe: "R3c", arm: `notools:${KEY}`, run: idx + 1, model, usage: st.usage, usd: c.usd });
  return { run: idx + 1, turns, usd: c.usd, error: st.err };
}

async function main() {
  console.log(`R3c NO TOOLS — ${model} (${vertex ? "vertex" : "aistudio"}), N=${N}`);
  console.log(`spent $${spent().toFixed(4)} / $${CAP_USD.toFixed(2)}\n`);
  const rows = [];
  for (let i = 0; i < N; i++) {
    try {
      const r = await run(i);
      rows.push(r);
      const d = r.turns.filter((t) => t.doubled).length;
      console.log(`  run ${r.run}: doubled ${d}/${r.turns.length} turns`);
      for (const t of r.turns) if (t.doubled) console.log(`     ${t.label}: ${JSON.stringify(t.said.slice(0, 150))}`);
      writeRaw(`r3-notools-${KEY}`, { model, rows });
    } catch (e) {
      if (e.name === "BudgetExceeded") throw e;
      console.log(`  run ${i + 1}: FAILED — ${e.message?.slice(0, 120)}`);
      rows.push({ run: i + 1, error: e.message });
      writeRaw(`r3-notools-${KEY}`, { model, rows });
    }
  }
  const all = rows.flatMap((r) => r.turns || []);
  const d = all.filter((t) => t.doubled).length;
  console.log(`\n  ${model}: doubled ${d}/${all.length} turns = ${all.length ? Math.round((100 * d) / all.length) : 0}%  (with tools: 2.5 was 15%)`);
  console.log(`  spent $${spent().toFixed(4)}`);
}

main().catch((e) => { console.error(`R3c ABORTED: ${e.message}`); process.exit(1); });

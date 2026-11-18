// Which prebuilt voices actually resolve on gemini-3.8-live?
// The owner picked Kore by phone on 2026-09-05 after rejecting Aoede on a real
// call. If Kore does not resolve on 3.8 the first test call either fails or
// silently speaks in something else, and either way the owner judges the wrong
// thing. Half a cent to find out.
import "dotenv/config";
import fs from "node:fs";
import { GoogleGenAI, Modality } from "@google/genai";
import { commit, priceGeminiByMinutes, summary } from "./lib/spendLive.js";

const MODEL = process.env.M38 || "gemini-3.8-live";
const VOICES = (process.env.VOICES || "Kore,Aoede,Puck,Charon,Leda,Fenrir,Zephyr,Orus").split(",");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryVoice(voiceName) {
  const st = { setup: false, bytes: 0, err: null };
  let s = null;
  const t0 = Date.now();
  try {
    s = await Promise.race([
      new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }).live.connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        },
        callbacks: {
          onmessage: (m) => {
            if (m.setupComplete) st.setup = true;
            const p = m.serverContent?.modelTurn?.parts?.find((x) => x.inlineData?.data);
            if (p) st.bytes += Buffer.from(p.inlineData.data, "base64").length;
          },
          onerror: (e) => { st.err = (e?.message || String(e)).slice(0, 110); },
          onclose: (e) => { if (e?.reason && !st.err) st.err = String(e.reason).slice(0, 110); },
        },
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 20s")), 20000)),
    ]);
    for (let i = 0; i < 40 && !st.setup && !st.err; i++) await sleep(150);
    if (st.setup) {
      s.sendClientContent({ turns: [{ role: "user", parts: [{ text: "Say: good morning, Brightwork Family Dental." }] }], turnComplete: true });
      for (let i = 0; i < 60 && st.bytes === 0 && !st.err; i++) await sleep(200);
      await sleep(1200);
    }
  } catch (e) { st.err = e.message.slice(0, 110); }
  finally { try { s?.close?.(); } catch {} }

  const secs = (Date.now() - t0) / 1000;
  const priced = priceGeminiByMinutes({ inSeconds: 0, outSeconds: st.bytes / (24000 * 2) });
  commit({ probe: "VOICE38", arm: MODEL, label: `voice-${voiceName}`, model: MODEL, usd: priced.usd, estimated: true });
  return { voiceName, ok: st.setup && st.bytes > 0, bytes: st.bytes, seconds: Number((st.bytes / 48000).toFixed(2)), err: st.err, usd: Number(priced.usd.toFixed(5)) };
}

const out = { at: new Date().toISOString(), model: MODEL, rows: [] };
for (const v of VOICES) {
  const r = await tryVoice(v);
  out.rows.push(r);
  console.log(`  ${v.padEnd(10)} ${r.ok ? "OK  " : "FAIL"}  ${String(r.seconds).padStart(5)}s audio  ${r.err || ""}`);
}
fs.writeFileSync("scripts/probes/results-voice38.json", JSON.stringify(out, null, 2) + "\n");
console.log(`\nresolved: ${out.rows.filter((r) => r.ok).map((r) => r.voiceName).join(", ") || "none"}`);
console.log(`spend: $${summary().spent.toFixed(4)} of $${summary().cap}`);

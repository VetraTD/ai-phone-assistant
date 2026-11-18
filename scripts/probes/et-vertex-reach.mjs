// Is gemini-3.8-live-extended-thinking on VERTEX? The DeepMind model card lists
// its distribution as "Gemini App, API, AI Studio, Vertex AI, and Google
// Workspace". The 2026-09-15 probe only ever tested PLAIN gemini-3.8-live on
// Vertex and found it absent. If the thinking variant IS there, Gemini 3.8
// gains a residency path and the whole residency argument moves.
import "dotenv/config";
import { GoogleGenAI, Modality } from "@google/genai";
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "vetra-uk-edc8ca";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODELS = ["gemini-3.8-live-extended-thinking", "gemini-3.8-live"];
const LOCS = ["europe-west1", "europe-west2", "us-central1", "global"];

for (const model of MODELS) {
  for (const location of LOCS) {
    const st = { setup: false, err: null };
    let s = null;
    const cfg = { responseModalities: [Modality.AUDIO] };
    if (model.includes("extended-thinking")) cfg.thinkingConfig = { thinkingLevel: "high" };
    try {
      s = await Promise.race([
        new GoogleGenAI({ vertexai: true, project: PROJECT, location }).live.connect({
          model, config: cfg,
          callbacks: {
            onmessage: (m) => { if (m.setupComplete) st.setup = true; },
            onerror: (e) => { st.err = (e?.message || String(e)).slice(0, 120); },
            onclose: (e) => { if (e?.reason && !st.err) st.err = String(e.reason).slice(0, 120); },
          },
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 20s")), 20000)),
      ]);
      for (let i = 0; i < 40 && !st.setup && !st.err; i++) await sleep(200);
    } catch (e) { st.err = e.message.slice(0, 120); }
    finally { try { s?.close?.(); } catch {} }
    console.log(`${model.padEnd(36)} vertex/${location.padEnd(14)} ${st.setup ? "*** OK ***" : "FAIL  " + (st.err || "no setupComplete")}`);
  }
}

import "dotenv/config";
import { GoogleGenAI, Modality } from "@google/genai";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODELS = ["gemini-3.8-live-extended-thinking", "gemini-3.8-live"];
for (const model of MODELS) {
  for (const cfg of [{}, { thinkingConfig: { thinkingLevel: "high" } }, { thinkingConfig: { thinkingLevel: "low" } }]) {
    const st = { setup: false, err: null };
    let s = null;
    try {
      s = await Promise.race([
        new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }).live.connect({
          model,
          config: { responseModalities: [Modality.AUDIO], ...cfg },
          callbacks: {
            onmessage: (m) => { if (m.setupComplete) st.setup = true; },
            onerror: (e) => { st.err = (e?.message || String(e)).slice(0, 110); },
            onclose: (e) => { if (e?.reason && !st.err) st.err = String(e.reason).slice(0, 110); },
          },
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 20s")), 20000)),
      ]);
      for (let i = 0; i < 40 && !st.setup && !st.err; i++) await sleep(200);
    } catch (e) { st.err = e.message.slice(0, 110); }
    finally { try { s?.close?.(); } catch {} }
    console.log(`${model.padEnd(36)} ${JSON.stringify(cfg).padEnd(46)} ${st.setup ? "OK" : "FAIL  " + (st.err || "no setupComplete")}`);
  }
}

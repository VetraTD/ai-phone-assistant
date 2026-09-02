// ---------------------------------------------------------------------------
// Round 2, phase A — which Live models actually serve, and from where.
//
//   node scripts/probes/r2-discover.mjs
//
// Costs nothing measurable: each cell opens a socket, waits for setupComplete,
// and closes without sending audio or generating a token.
//
// Exists because round 1 proved the wrong thing. It measured `europe-west1`,
// which is BELGIUM, while the UK stack (`vetra-uk`) runs in `europe-west2`,
// which is LONDON. For a UK clinic told their data stays in the UK that is not
// a detail. And the fast/cheap headline numbers came from `gemini-3.1-flash-
// live-preview` on AI STUDIO — the consumer API-key surface, which is neither a
// residency nor a BAA path. This enumerates what is actually reachable on the
// surface that counts.
//
// us-central1 is included as a control: it separates "this model does not
// exist" from "this region does not serve it".
// ---------------------------------------------------------------------------
import "dotenv/config";
import { GoogleGenAI, Modality } from "@google/genai";

const REGIONS = ["europe-west2", "europe-west1", "us-central1"];
const PROJECT = "vetra-uk-edc8ca";

/** Every Live-capable name worth trying. Misses are expected and are data. */
const CANDIDATES = [
  "gemini-live-2.5-flash-native-audio",
  "gemini-live-2.5-flash-preview-native-audio",
  "gemini-live-2.5-flash",
  "gemini-2.0-flash-live-001",
  "gemini-3.1-flash-live-preview",
  "gemini-live-3.1-flash-native-audio",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(ai, model) {
  let settled = false;
  return await new Promise(async (resolve) => {
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done({ ok: false, err: "timeout 12s" }), 12000);
    let session = null;
    try {
      session = await ai.live.connect({
        model,
        config: { responseModalities: [Modality.AUDIO] },
        callbacks: {
          onmessage: (m) => { if (m.setupComplete) { clearTimeout(timer); done({ ok: true }); } },
          onerror: (e) => { clearTimeout(timer); done({ ok: false, err: (e?.message || String(e)).slice(0, 150) }); },
          onclose: (e) => { clearTimeout(timer); done({ ok: false, err: `closed: ${(e?.reason || "").slice(0, 150)}` }); },
        },
      });
    } catch (e) {
      clearTimeout(timer);
      done({ ok: false, err: (e?.message || String(e)).slice(0, 150) });
    }
    const v = await new Promise((r) => setTimeout(() => r(null), 12500));
    try { session?.close(); } catch {}
  });
}

async function main() {
  const grid = {};

  console.log("VERTEX  project", PROJECT);
  for (const location of REGIONS) {
    const ai = new GoogleGenAI({ vertexai: true, project: PROJECT, location });
    console.log(`\n  ${location}`);
    for (const model of CANDIDATES) {
      const r = await probe(ai, model);
      grid[`vertex:${location}:${model}`] = r;
      console.log(`    ${r.ok ? "OK  " : "--  "} ${model.padEnd(46)} ${r.ok ? "" : r.err}`);
      await sleep(150);
    }
  }

  console.log("\nAI STUDIO (api key — consumer surface, no residency/BAA path)");
  const studio = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  for (const model of CANDIDATES) {
    const r = await probe(studio, model);
    grid[`aistudio::${model}`] = r;
    console.log(`    ${r.ok ? "OK  " : "--  "} ${model.padEnd(46)} ${r.ok ? "" : r.err}`);
    await sleep(150);
  }

  const { writeRaw } = await import("./lib/stats.js");
  writeRaw("r2-discover", { at: new Date().toISOString(), project: PROJECT, grid });

  const live = Object.entries(grid).filter(([, v]) => v.ok).map(([k]) => k);
  console.log(`\n  reachable: ${live.length} of ${Object.keys(grid).length}`);
  for (const k of live) console.log(`    ${k}`);
}

main().catch((e) => { console.error("r2-discover failed:", e.message); process.exit(1); });

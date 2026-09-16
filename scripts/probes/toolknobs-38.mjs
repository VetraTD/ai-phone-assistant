// ---------------------------------------------------------------------------
// Which TOOL-CONTROL knobs does gemini-3.8-live actually accept?
//
// The question is whether GPT-Live has a leg up on *guarding* tool behaviour.
// It exposes tool_choice (auto/required/none/named) and parallel_tool_calls on
// the delegated Responses backend, and this repo has already MEASURED that knob
// fixing a real defect: gpt-realtime-2.1 skipped check_appointment_availability
// in 9 of 20 trials, and forcing tool_choice closed it 3 of 3.
//
// Gemini documents toolConfig.functionCallingConfig for the Live API, but
// documentation is not acceptance and acceptance is not behaviour. Both get
// tested here:
//
//   A  ACCEPTANCE -- does the session start with the knob set?
//   B  BEHAVIOUR  -- does mode:ANY actually force a call on a turn that
//                    otherwise would not make one?
//
// Text turns rather than audio: this is a config test, not a voice test, and a
// text turn costs a fraction of a paced audio fixture.
// ---------------------------------------------------------------------------
import "dotenv/config";
import fs from "node:fs";
import { GoogleGenAI, Modality } from "@google/genai";
import { GEMINI_TOOLS, SYSTEM_PROMPT, TOOL_NAMES } from "./lib/prompt.js";
import { commit, priceGeminiByMinutes, summary } from "./lib/spendLive.js";

const MODEL = process.env.M38 || "gemini-3.8-live";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every knob worth asking about, and what it would buy us if accepted. */
const CASES = [
  { id: "baseline", buys: "control group", cfg: {} },
  { id: "mode_AUTO", buys: "explicit default", cfg: { toolConfig: { functionCallingConfig: { mode: "AUTO" } } } },
  { id: "mode_ANY", buys: "tool_choice:required -- FORCE a call", cfg: { toolConfig: { functionCallingConfig: { mode: "ANY" } } } },
  { id: "mode_NONE", buys: "tool_choice:none -- forbid calls", cfg: { toolConfig: { functionCallingConfig: { mode: "NONE" } } } },
  {
    id: "allowedFunctionNames",
    buys: "tool_choice:{name} -- force ONE named tool",
    cfg: { toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["check_appointment_availability"] } } },
  },
  {
    id: "behavior_NON_BLOCKING",
    buys: "async tools, explicit",
    tools: true,
    cfg: {},
    mutate: (tools) => [{ functionDeclarations: tools[0].functionDeclarations.map((d) => ({ ...d, behavior: "NON_BLOCKING" })) }],
  },
  {
    id: "behavior_BLOCKING",
    buys: "force SYNCHRONOUS tools -- the model waits",
    tools: true,
    cfg: {},
    mutate: (tools) => [{ functionDeclarations: tools[0].functionDeclarations.map((d) => ({ ...d, behavior: "BLOCKING" })) }],
  },
];

/** A turn that on its own does NOT need a tool. mode:ANY should change that. */
const NEUTRAL_TURN = process.env.KNOB_TURN || "Hello, good morning.";

async function run(testCase) {
  const st = { setup: false, err: null, tools: [], bytes: 0 };
  let s = null;
  const t0 = Date.now();
  const tools = testCase.mutate ? testCase.mutate([GEMINI_TOOLS]) : [GEMINI_TOOLS];
  try {
    s = await Promise.race([
      new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }).live.connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          tools,
          outputAudioTranscription: {},
          ...testCase.cfg,
        },
        callbacks: {
          onmessage: (m) => {
            if (m.setupComplete) st.setup = true;
            if (m.toolCall) st.tools.push(...(m.toolCall.functionCalls || []).map((c) => c.name));
            const p = m.serverContent?.modelTurn?.parts?.find((x) => x.inlineData?.data);
            if (p) st.bytes += Buffer.from(p.inlineData.data, "base64").length;
          },
          onerror: (e) => { st.err = (e?.message || String(e)).slice(0, 150); },
          onclose: (e) => { if (e?.reason && !st.err) st.err = String(e.reason).slice(0, 150); },
        },
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 20s")), 20000)),
    ]);
    for (let i = 0; i < 50 && !st.setup && !st.err; i++) await sleep(150);

    if (st.setup) {
      s.sendClientContent({ turns: [{ role: "user", parts: [{ text: NEUTRAL_TURN }] }], turnComplete: true });
      for (let i = 0; i < 60 && !st.tools.length && st.bytes === 0 && !st.err; i++) await sleep(200);
      await sleep(1500);
    }
  } catch (e) { st.err = e.message.slice(0, 150); }
  finally { try { s?.close?.(); } catch {} }

  const priced = priceGeminiByMinutes({ inSeconds: 0, outSeconds: st.bytes / (24000 * 2) });
  commit({ probe: "KNOBS", arm: MODEL, label: `knob-${testCase.id}`, model: MODEL, usd: priced.usd, estimated: true });

  return {
    id: testCase.id,
    buys: testCase.buys,
    accepted: st.setup,
    error: st.err,
    forced_a_tool: st.tools.length > 0,
    tools: [...new Set(st.tools)],
    spoke: st.bytes > 0,
    seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
  };
}

const N = Number(process.env.KNOB_N || 1);
const ONLY = process.env.KNOB_ONLY ? process.env.KNOB_ONLY.split(",") : null;
const out = { at: new Date().toISOString(), model: MODEL, n: N, neutral_turn: NEUTRAL_TURN, tool_count: TOOL_NAMES.length, rows: [] };
console.log(`tool-control knobs on ${MODEL}   (${TOOL_NAMES.length} production tools, neutral turn: ${JSON.stringify(NEUTRAL_TURN)})\n`);
for (const c of CASES) {
  if (ONLY && !ONLY.includes(c.id)) continue;
  for (let i = 1; i <= N; i++) {
    const r = await run(c);
    r.take = i;
    out.rows.push(r);
    console.log(
      `  ${c.id.padEnd(22)} t${i}  ${r.accepted ? "ok " : "REJECTED"}  ` +
      `${r.forced_a_tool ? "TOOL:" + r.tools.join(",") : r.spoke ? "spoke, no tool" : "silent"}`.padEnd(42) +
      `${r.error ? "  " + r.error : ""}`
    );
  }
}
// THE POINT OF THE RERUN. At N=1 baseline spoke with no tool and mode_AUTO
// called one, which is variance, not a knob working. A knob is only doing
// something if it moves the RATE.
console.log("\n  knob                   forced a tool");
for (const c of CASES) {
  if (ONLY && !ONLY.includes(c.id)) continue;
  const rs = out.rows.filter((r) => r.id === c.id && r.accepted);
  if (!rs.length) continue;
  const forced = rs.filter((r) => r.forced_a_tool).length;
  console.log(`  ${c.id.padEnd(22)} ${forced}/${rs.length}   ${c.buys}`);
}
fs.writeFileSync("scripts/probes/results-toolknobs38.json", JSON.stringify(out, null, 2) + "\n");
console.log(`\naccepted: ${out.rows.filter((r) => r.accepted).map((r) => r.id).join(", ")}`);
console.log(`rejected: ${out.rows.filter((r) => !r.accepted).map((r) => r.id).join(", ") || "none"}`);
console.log(`spend: $${summary().spent.toFixed(4)} of $${summary().cap}`);

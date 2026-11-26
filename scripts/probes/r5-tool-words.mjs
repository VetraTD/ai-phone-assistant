// ---------------------------------------------------------------------------
// Hammersleys round 5, Task 0b (owner ruling R45, 2026-11-26): WHEN do the words
// arrive, relative to the tool call that rode with them?
//
//   node scripts/probes/r5-tool-words.mjs [--n 12] [--cap 0.15]
//
// lib/voice/live/index.js (F-D, ~7641) says Live delivers a tool call BEFORE the
// transcript of the words the model spoke with it. Round-5 Tasks 1/3/5 decide
// "did the AI already ask its question this turn?" from that transcript, so the
// gap decides whether they can work and how long a wait for the words must be.
//
// Per trial, every time is ms relative to the toolCall message:
//   q_ms       first moment the turn's text holds a "?" (negative = before the call)
//   dot_ms     (statement arm) first moment the text holds the statement's "."
//   ahead_ms   audio made before the call minus wall time since the first chunk:
//              how much of our own audio is still queued to play at the call
//   ttfa_ms    tool response sent -> first audio after it
//   repeat     the post-tool words ask the terminal question again
// Arms: QA (question, then save; today's "ask them now" reply), QB (question, then
// save; the round-5 ALREADY_ASKED reply), S (statement, then save, then a question).
//
// Text in, audio out (the r3-tools deviation, same reason): output timing is what
// is measured. Model and surface as production (LIVE_MODEL / LIVE_SURFACE from
// .env or the environment). Synthetic caller text only; nothing is logged but
// lengths and times. Hard stop at --cap dollars (gemini-3.8-live card).
// ---------------------------------------------------------------------------
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectLive } from "../../lib/voice/live/client.js";

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : d; };
const N = Number(argOf("--n", 12));
const CAP = Number(argOf("--cap", 0.15));
const MODEL = process.env.PROBE_MODEL || "gemini-3.8-live";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HERE = path.dirname(fileURLToPath(import.meta.url));

// gemini-3.8-live card (scripts/probes/lib/spendLive.js RATES), USD per million.
const RATE = { audio_in: 3.0, audio_out: 12.0, text_in: 0.5, text_out: 2.0 };

const ASK_NOW =
  "[not caller speech] First confirm the answer you just saved, the way this business's notes say. Then: This business's questions with no saved answer yet: 2. Terminal, 3. When. If they apply to this caller (new enquiries by default), ask them now in that order, one at a time; if the caller already gave one, save it under the label shown instead of asking again. Then save again with the same message and all the answers in details.";
const ALREADY_ASKED =
  "[not caller speech] Saved. You have already asked your next question in this turn: say nothing more now and wait for the caller's answer.";

const PROMPT_Q =
  "You are a taxi booking receptionist on a phone call. Short, warm sentences, British English.\n" +
  "When the caller gives their pickup address, SPEAK FIRST: say 'Got it,' and the pickup, then ask 'Which terminal at Gatwick do you need?'. " +
  "Only after you have finished saying that question, and in the same turn, call save_trip with the pickup. Never call save_trip before you speak.";
const PROMPT_S =
  "You are a taxi booking receptionist on a phone call. Short, warm sentences, British English.\n" +
  "When the caller gives their pickup address, SPEAK FIRST: say 'Got it,' and the pickup. Only after you have finished saying that, " +
  "in the same turn, call save_trip with the pickup. Ask nothing before calling save_trip; after it, do what its reply says. Never call save_trip before you speak.";
// QR: a production-sized prompt (a rendered tenant prompt, ~6k tokens) with the test rule on top,
// to check that long context does not change the order. PROBE_LONG_PROMPT = path to that text.
const LONG = process.env.PROBE_LONG_PROMPT ? fs.readFileSync(process.env.PROBE_LONG_PROMPT, "utf8") : null;
const promptFor = (arm) =>
  arm === "S" ? PROMPT_S : arm === "QR" && LONG ? `${LONG}\n\n=== TEST RULE (overrides everything above) ===\n${PROMPT_Q}` : PROMPT_Q;
const CALLER = "Hi, I need a taxi to Gatwick on Saturday. Pick me up from 12 High Street, Lingfield.";

const TOOLS = [{
  functionDeclarations: [{
    name: "save_trip",
    description: "Save the trip details given so far.",
    parameters: { type: "OBJECT", properties: { pickup: { type: "STRING" } }, required: ["pickup"] },
  }],
}];

function usd(u) {
  const by = (list, mod) => (list || []).filter((x) => x.modality === mod).reduce((a, x) => a + (x.tokenCount || 0), 0);
  const inAudio = by(u.promptTokensDetails, "AUDIO");
  const inText = (u.promptTokenCount || 0) - inAudio;
  const outAudio = by(u.responseTokensDetails, "AUDIO");
  const outText = (u.responseTokenCount || 0) - outAudio;
  return (inAudio * RATE.audio_in + inText * RATE.text_in + outAudio * RATE.audio_out + outText * RATE.text_out) / 1e6;
}

async function trial(arm) {
  const t = { arm, toolAt: null, sentAt: null, firstAudio: null, chunks: [], text: [], turnCompleteAt: null, usage: [], err: null, tools: 0 };
  let session = null;
  // Live may send a turnComplete for the words before the tool and then generate again after the tool
  // response, so "done" = quiet for 2.5 s after the tool response (cap 12 s), not the first turnComplete.
  let lastEventAt = 0;
  try {
    const r = await connectLive({
      model: MODEL,
      config: {
        responseModalities: ["AUDIO"],
        systemInstruction: { parts: [{ text: promptFor(arm) }] },
        outputAudioTranscription: {},
        tools: TOOLS,
        speechConfig: { languageCode: "en-GB" },
      },
      callbacks: {
        onmessage: (m) => {
          const at = performance.now();
          lastEventAt = at;
          if (m.usageMetadata) t.usage.push(m.usageMetadata);
          if (m.toolCall) {
            t.tools += 1;
            const fcs = m.toolCall.functionCalls || [];
            if (t.toolAt === null) t.toolAt = at;
            const next = t.tools > 1 ? null : arm === "QB" ? ALREADY_ASKED : ASK_NOW;
            try {
              session.sendToolResponse({
                functionResponses: fcs.map((fc) => ({
                  id: fc.id, name: fc.name,
                  response: { success: true, ...(next ? { next } : {}), message: "I'll make sure they get your message." },
                })),
              });
            } catch (e) { t.err = String(e?.message || e).slice(0, 120); }
            if (t.sentAt === null) t.sentAt = performance.now();
          }
          const sc = m.serverContent;
          if (!sc) return;
          for (const p of sc.modelTurn?.parts || []) {
            if (p.inlineData?.data) {
              const ms = Buffer.from(p.inlineData.data, "base64").length / 48; // 24 kHz, 16-bit mono
              if (t.firstAudio === null) t.firstAudio = at;
              t.chunks.push({ at, ms });
            }
          }
          if (sc.outputTranscription?.text) t.text.push({ at, s: sc.outputTranscription.text });
          if (sc.turnComplete) t.turnCompletes = (t.turnCompletes || 0) + 1;
          if (sc.turnComplete && t.toolAt !== null && t.turnCompleteAt === null) t.turnCompleteAt = at;
        },
        onerror: (e) => { t.err = String(e?.message || e).slice(0, 120); },
      },
    });
    session = r.session;
    session.sendClientContent({ turns: [{ role: "user", parts: [{ text: CALLER }] }], turnComplete: true });
    const until = performance.now() + 25000;
    while (performance.now() < until) {
      await sleep(50);
      if (t.sentAt !== null && performance.now() - Math.max(lastEventAt, t.sentAt) > 2500) break;
      if (t.sentAt !== null && performance.now() - t.sentAt > 12000) break;
    }
  } catch (e) {
    t.err = String(e?.message || e).slice(0, 120);
  } finally {
    try { session?.close?.(); } catch {}
  }
  return t;
}

function analyse(t) {
  const out = { arm: t.arm, err: t.err };
  if (t.toolAt === null) return { ...out, kind: "no_tool", usd: 0.002 };
  const pre = t.chunks.filter((c) => c.at < t.toolAt);
  const allMs = t.chunks.reduce((a, c) => a + c.ms, 0);
  // No usage messages on this surface: price the audio out (~25 tokens/s) plus ~1k text tokens in.
  out.usd = t.usage.length ? t.usage.reduce((sum, u) => sum + usd(u), 0) : ((allMs / 1000) * 25 * RATE.audio_out + (t.arm === "QR" ? 14000 : 1000) * RATE.text_in) / 1e6;
  if (!pre.length) return { ...out, kind: "tool_first", audio_ms: Math.round(allMs), chars: t.text.map((f) => f.s).join("").trim().length };
  out.kind = "spoke_then_called";
  out.pre_audio_ms = Math.round(pre.reduce((a, c) => a + c.ms, 0));
  out.ahead_ms = Math.round(out.pre_audio_ms - (t.toolAt - t.firstAudio));
  let cum = "";
  out.q_ms = null; out.dot_ms = null;
  let textAtTool = "";
  for (const f of t.text) {
    cum += f.s;
    if (f.at <= t.toolAt) textAtTool = cum;
    if (out.q_ms === null && cum.includes("?")) out.q_ms = Math.round(f.at - t.toolAt);
    if (out.dot_ms === null && /got it[^.?!]*[.!]/i.test(cum)) out.dot_ms = Math.round(f.at - t.toolAt);
  }
  out.q_at_tool = /\?['")\]\s]*$/.test(textAtTool.trim());
  out.chars_at_tool = textAtTool.trim().length;
  out.chars_total = cum.trim().length;
  const post = t.chunks.filter((c) => c.at > t.sentAt);
  out.ttfa_ms = post.length ? Math.round(post[0].at - t.sentAt) : null;
  out.post_audio_ms = Math.round(post.reduce((a, c) => a + c.ms, 0));
  out.turn_completes = t.turnCompletes || 0;
  out.tc_after_tool_ms = t.turnCompleteAt === null ? null : Math.round(t.turnCompleteAt - t.toolAt);
  // Repeat: "terminal" asked twice in the turn's words.
  out.terminal_asks = (cum.match(/terminal[^?]*\?/gi) || []).length;
  out.repeat = out.terminal_asks >= 2;
  return out;
}

// 12 = QA 4, QB 5, S 3, interleaved so drift over time hits every arm; then QR x4 when a long prompt is given.
const ORDER = ["QA", "QB", "S", "QB", "QA", "S", "QA", "QB", "S", "QB", "QA", "QB", ...(LONG ? ["QR", "QR", "QR", "QR"] : [])];
const arms = Array.from({ length: N }, (_, i) => ORDER[i % ORDER.length]);
let spent = 0;
const rows = [];
console.log(`model ${MODEL}, ${N} trials, cap $${CAP}`);
for (const arm of arms) {
  if (spent >= CAP) { console.log(`STOP: cap reached ($${spent.toFixed(4)})`); break; }
  const t = await trial(arm);
  const a = analyse(t);
  spent += a.usd ?? 0.01;
  rows.push(a);
  console.log(JSON.stringify(a));
}
const fname = path.join(HERE, "raw", `r5-tool-words-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.mkdirSync(path.dirname(fname), { recursive: true });
fs.writeFileSync(fname, JSON.stringify({ model: MODEL, rows, spent }, null, 2));
console.log(`spent ~$${spent.toFixed(4)}; raw ${path.relative(process.cwd(), fname)}`);

// ---------------------------------------------------------------------------
// Does the voice we chose on 3.1 exist on 2.5 native audio?
//
// LIVE_VOICE is unset on voice-uk-prod, so the session falls through to the
// tenant column / per-language default -- Kore, which the owner picked by phone
// on 2026-09-05 after rejecting Aoede on a real call. If Kore does not resolve
// on 2.5, the first test call either fails or silently speaks in something else,
// and either way the owner's time is wasted judging the wrong thing.
//
// Half a cent to find out.
// ---------------------------------------------------------------------------
import { GoogleGenAI, Modality } from "@google/genai";
import { commit, priceTokens } from "./lib/spendLive.js";

const MODEL = "gemini-live-2.5-flash-native-audio";
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "vetra-uk-edc8ca";
const LOCATION = "europe-west1";
const VOICES = (process.env.VOICES || "Kore,Aoede,Puck,Charon,Leda").split(",");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryVoice(voice) {
  const ai = new GoogleGenAI({ vertexai: true, project: PROJECT, location: LOCATION });
  const state = { audioBytes: 0, err: null, setup: false, usage: {} };
  let session = null;
  try {
    session = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        systemInstruction: { parts: [{ text: "You are a receptionist. Greet the caller in one short sentence." }] },
        outputAudioTranscription: {},
      },
      callbacks: {
        onmessage: (m) => {
          if (m.setupComplete) state.setup = true;
          if (m.usageMetadata) state.usage = m.usageMetadata;
          const p = m.serverContent?.modelTurn?.parts?.find((x) => x.inlineData?.data);
          if (p) state.audioBytes += Buffer.from(p.inlineData.data, "base64").length;
        },
        onerror: (e) => { state.err = e?.message || String(e); },
        onclose: (e) => { if (e?.reason && !state.err) state.closeReason = e.reason; },
      },
    });
    // A text turn is enough to make it speak; no audio fixture needed.
    session.sendClientContent({ turns: [{ role: "user", parts: [{ text: "Hello?" }] }], turnComplete: true });
    for (let i = 0; i < 100 && state.audioBytes === 0 && !state.err; i++) await sleep(100);
  } catch (err) {
    state.err = err.message;
  } finally {
    try { session?.close?.(); } catch {}
  }
  return state;
}

async function main() {
  console.log(`Voice check on ${MODEL} @ ${PROJECT}/${LOCATION}\n`);
  const results = [];
  for (const v of VOICES) {
    const s = await tryVoice(v);
    const ok = s.audioBytes > 0 && !s.err;
    results.push({ voice: v, ok, bytes: s.audioBytes, error: s.err || s.closeReason || null });
    console.log(
      `  ${v.padEnd(10)} ${ok ? "OK  " : "FAIL"}  ${s.audioBytes} bytes` +
      `${s.err ? "  -- " + String(s.err).slice(0, 110) : ""}`
    );
  }
  const priced = priceTokens(MODEL, { text_in: 200 * VOICES.length, audio_out: 300 * VOICES.length });
  commit({ probe: "VOICE", arm: "kore-on-2.5", model: MODEL, usd: priced.usd, note: "voice availability check" });
  const kore = results.find((r) => r.voice === "Kore");
  console.log(`\nKore on 2.5: ${kore?.ok ? "AVAILABLE -- the voice you chose still works" : "NOT AVAILABLE -- pick another before the call"}`);
  console.log(`working voices: ${results.filter((r) => r.ok).map((r) => r.voice).join(", ") || "none"}`);
}

main();

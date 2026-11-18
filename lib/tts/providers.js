import { performance } from "node:perf_hooks";
import { createTtsConnection } from "../../services/elevenlabs.js";
import { synthesizeMulaw as synthesizeGoogleCloud } from "../../services/googleTts.js";
import { downsampleToMulaw } from "../audio/resample.js";

// ---------------------------------------------------------------------------
// TTS candidates for the blind A/B, behind one interface.
//
//   synthesize({text, previousText, voice}) -> {mulaw: Buffer, ttfaMs: number}
//
// Two things every adapter must get right, because they decide whether the
// comparison is fair:
//
//   1. Output format. Candidates that can emit 8kHz mu-law natively do so.
//      The rest go through lib/audio/resample.js, which band-limits to 3.4kHz
//      before resampling — the same ceiling the phone network imposes on the
//      native ones. Decimating without that filter would alias sibilance into
//      the voice band and lose the test for the non-native vendors on a
//      technicality.
//
//   2. Time to first audio. Measured from just before the request to the first
//      audio byte received, so it is comparable across a streaming API and a
//      batch one — a batch endpoint genuinely does make the caller wait for
//      the whole utterance, and the number should say so.
//
// The API shapes below follow each vendor's documented interface. Run
// `node scripts/voice-ab.js --smoke --providers all` to confirm each one
// actually authenticates and returns audio before trusting a full run.
// ---------------------------------------------------------------------------

/** Sample rate each non-native provider returns, for the resampler. */
const NATIVE_MULAW = Symbol("native-mulaw");

/**
 * ElevenLabs Flash v2.5 — the incumbent, and the only candidate already on the
 * live call path. Uses the same streaming WS connection a real turn uses
 * (including previous_text prosody continuity) so the baseline is the product,
 * not a REST approximation of it.
 */
async function synthesizeElevenLabs({ text, previousText, voice, modelId }) {
  const startedAt = performance.now();
  let ttfaMs = null;
  const chunks = [];

  await new Promise((resolve, reject) => {
    const conn = createTtsConnection({
      voiceId: voice.elevenVoiceId ?? voice.id,
      modelId: modelId || process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
      voiceSettings: voice.voiceSettings,
      previousText,
      onAudio: (buf) => {
        if (ttfaMs === null) ttfaMs = performance.now() - startedAt;
        chunks.push(buf);
      },
      onFinal: resolve,
      onError: reject,
    });
    conn.sendText(text);
    conn.flush();
  });

  return { mulaw: Buffer.concat(chunks), ttfaMs: Math.round(ttfaMs ?? 0) };
}

/**
 * Cartesia Sonic 3.5 — the latency claim (~40ms TTFA). Emits pcm_mulaw at
 * 8kHz natively, so no resampling is involved and its TTFA number is directly
 * comparable to ElevenLabs'.
 *
 * Streamed over SSE rather than the batch endpoint specifically so the first
 * audio byte can be timed.
 */
async function synthesizeCartesia({ text, voice }) {
  const apiKey = process.env.CARTESIA_API_KEY;
  if (!apiKey) throw new Error("CARTESIA_API_KEY is not set");

  const startedAt = performance.now();
  const res = await fetch("https://api.cartesia.ai/tts/sse", {
    method: "POST",
    headers: {
      "Cartesia-Version": "2024-06-10",
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model_id: voice.modelId || "sonic-3.5",
      transcript: text,
      voice: { mode: "id", id: voice.id },
      // Native telephony format — no conversion step, no conversion artifacts.
      output_format: { container: "raw", encoding: "pcm_mulaw", sample_rate: 8000 },
      language: "en",
    }),
  });
  if (!res.ok) throw new Error(`Cartesia ${res.status}: ${(await res.text()).slice(0, 200)}`);

  let ttfaMs = null;
  const chunks = [];
  const decoder = new TextDecoder();
  let buffered = "";

  for await (const part of res.body) {
    buffered += decoder.decode(part, { stream: true });
    // SSE frames are separated by a blank line; each carries one JSON payload.
    const frames = buffered.split("\n\n");
    buffered = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      let payload;
      try {
        payload = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (payload.type === "chunk" && payload.data) {
        if (ttfaMs === null) ttfaMs = performance.now() - startedAt;
        chunks.push(Buffer.from(payload.data, "base64"));
      }
    }
  }

  return { mulaw: Buffer.concat(chunks), ttfaMs: Math.round(ttfaMs ?? 0) };
}

/**
 * Inworld TTS 1.5 — batch REST returning LINEAR16, so it needs both the
 * resampler and an honest TTFA: with no streaming, the first audio byte
 * genuinely does arrive only once the whole utterance is synthesized, and
 * the measurement should reflect that rather than flatter it.
 */
async function synthesizeInworld({ text, voice }) {
  const apiKey = process.env.INWORLD_API_KEY;
  if (!apiKey) throw new Error("INWORLD_API_KEY is not set");

  const startedAt = performance.now();
  const res = await fetch("https://api.inworld.ai/tts/v1/voice", {
    method: "POST",
    headers: { Authorization: `Basic ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      voiceId: voice.id,
      // inworld-tts-1.5 does not exist and never did — the smoke test caught it
      // on the adapter's first live call ("model_id: inworld-tts-1.5 is not
      // supported"). Live IDs, probed against the API: inworld-tts-1,
      // inworld-tts-1-max, inworld-tts-1.5-max, inworld-tts-2. Defaulting to
      // the newest so the vendor is judged on its current best rather than
      // losing on a stale model, the same fairness argument the resampler note
      // makes for the batch APIs.
      modelId: voice.modelId || "inworld-tts-2",
      audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 48000 },
    }),
  });
  if (!res.ok) throw new Error(`Inworld ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const body = await res.json();
  const ttfaMs = Math.round(performance.now() - startedAt);
  const audio = body.audioContent ?? body.result?.audioContent;
  if (!audio) throw new Error("Inworld returned no audioContent");

  const wav = Buffer.from(audio, "base64");
  return { mulaw: downsampleToMulaw(stripWavHeader(wav), 48000), ttfaMs };
}

/**
 * Gemini 3.1 Flash TTS — returns 24kHz PCM16, so it also goes through the
 * resampler. Reuses GEMINI_API_KEY, which makes it the cheapest candidate to
 * add and the obvious baseline for "is paying for a voice vendor worth it".
 */
async function synthesizeGemini({ text, voice }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey });

  const startedAt = performance.now();
  const res = await ai.models.generateContent({
    // Transposed, and the smoke test caught it: the live ID is
    // gemini-3.1-flash-tts-preview, not ...-preview-tts. Confirmed against
    // ListModels, which also offers gemini-2.5-flash-preview-tts and
    // gemini-2.5-pro-preview-tts.
    model: voice.modelId || "gemini-3.1-flash-tts-preview",
    contents: [{ parts: [{ text }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice.id || "Kore" } },
      },
    },
  });
  const ttfaMs = Math.round(performance.now() - startedAt);

  const inline = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
  if (!inline?.data) throw new Error("Gemini TTS returned no audio");

  return { mulaw: downsampleToMulaw(Buffer.from(inline.data, "base64"), 24000), ttfaMs };
}

/**
 * Drop a RIFF header if present. Vendors are inconsistent about whether
 * "LINEAR16" means a bare PCM stream or a WAV file, and feeding 44 bytes of
 * header into the resampler as if it were audio produces a click at the start
 * of every clip — which a listener would score as an artifact.
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function stripWavHeader(buf) {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF") return buf;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "data") return buf.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  return buf;
}

/**
 * The candidates. `voice` defaults are starting points — override per run.
 * `costPer1kChars` is list price at time of writing and is reported alongside
 * the listening scores so the verdict can weigh quality against spend.
 */
/**
 * Google Cloud Text-to-Speech — and it belongs here more than any other entry.
 *
 * ADDED 2026-08-22, and its absence was a real gap: this is the voice a COVERED
 * deployment actually speaks with. `hipaa` mode refuses to construct ElevenLabs
 * at all, so every US production call is this. The blind pack was comparing the
 * incumbent against candidates and had never included the thing that is already
 * running in production.
 *
 * (`gemini` below is Gemini/AI-Studio TTS — a different service, on the
 * uncovered API, and not what the covered lane speaks with.)
 *
 * Deliberately the SHIPPING module rather than a fresh client, so the
 * comparison measures the product: same voice default, same audio config, same
 * in-memory cache. Feed it distinct text if you are timing it — a repeated
 * phrase measures the cache.
 *
 * NOT STREAMING, which is the whole point of measuring it. `synthesizeMulaw`
 * returns only when the entire utterance is done, so `ttfaMs` is the full
 * synthesis time and that is the honest number: a batch endpoint really does
 * make the caller wait for all of it. Measured at ~14 ms per character.
 */
async function synthesizeGoogle({ text, voice, bypassCache = true }) {
  const startedAt = performance.now();
  // `voice` arrives as an object from the harnesses; Google wants the name.
  const name = (typeof voice === "string" ? voice : voice?.id) || "en-US-Chirp3-HD-Aoede";
  // Cache bypassed BY DEFAULT here, unlike the call path. This adapter exists
  // to measure, and a cache hit returns the same bytes in 0 ms — which makes a
  // repeat run report a variance of zero no matter what the synthesizer does.
  const mulaw = await synthesizeGoogleCloud(text, name, null, { bypassCache });
  return { mulaw, ttfaMs: Math.round(performance.now() - startedAt) };
}

export const PROVIDERS = {
  google: {
    label: "Google Cloud TTS Chirp3-HD",
    native8kMulaw: NATIVE_MULAW,
    // Chirp3-HD list price, $30 per 1M characters.
    costPer1kChars: 0.03,
    synthesize: synthesizeGoogle,
  },
  elevenlabs: {
    label: "ElevenLabs Flash v2.5",
    native8kMulaw: NATIVE_MULAW,
    costPer1kChars: 0.05,
    synthesize: synthesizeElevenLabs,
  },
  // The SAME vendor on its quality-tier model, as a separate arm.
  //
  // Added 2026-08-22 because a readback comparison put Flash behind Google on
  // digits and proper nouns, and "ElevenLabs is less accurate" would have been
  // the wrong conclusion to draw from it: `eleven_flash_v2_5` is the
  // LOW-LATENCY model and it is what production runs. Whether the vendor or our
  // model choice is responsible is a question with two different fixes, so it
  // gets measured rather than assumed.
  elevenlabs_turbo: {
    label: "ElevenLabs Turbo v2.5",
    native8kMulaw: NATIVE_MULAW,
    costPer1kChars: 0.1,
    synthesize: (opts) => synthesizeElevenLabs({ ...opts, modelId: "eleven_turbo_v2_5" }),
  },
  cartesia: {
    label: "Cartesia Sonic 3.5",
    native8kMulaw: NATIVE_MULAW,
    costPer1kChars: 0.035,
    synthesize: synthesizeCartesia,
  },
  inworld: {
    label: "Inworld TTS 2",
    native8kMulaw: null, // resampled from 48kHz
    // On-demand list price. Inworld tiers steeply on monthly spend
    // ($0.015 at $300/mo, $0.0125 at $1,500/mo, $0.01 at enterprise), so at our
    // volume the on-demand figure is the honest one to compare against.
    costPer1kChars: 0.025,
    synthesize: synthesizeInworld,
  },
  gemini: {
    label: "Gemini 3.1 Flash TTS",
    native8kMulaw: null, // resampled from 24kHz
    costPer1kChars: 0.01,
    synthesize: synthesizeGemini,
  },
};

/** @returns {string[]} provider keys */
export function providerNames() {
  return Object.keys(PROVIDERS);
}

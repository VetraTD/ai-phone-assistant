import fs from "fs";
import path from "path";
import crypto from "crypto";

const OUT_DIR = path.join(process.cwd(), "public", "tts");
fs.mkdirSync(OUT_DIR, { recursive: true });

export async function ttsToFile(text) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";

  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set");
  if (!voiceId) throw new Error("ELEVENLABS_VOICE_ID is not set");

  // Cache by text hash so repeated replies are instant
  const hash = crypto.createHash("sha256").update(text).digest("hex");
  const filename = `${hash}.mp3`;
  const filepath = path.join(OUT_DIR, filename);

  if (fs.existsSync(filepath)) return filename;

  const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.8,
      },
    }),
  });

  // ✅ IMPORTANT: error check is "!resp.ok"
  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed (${resp.status}): ${err}`);
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(filepath, buffer);

  return filename;
}
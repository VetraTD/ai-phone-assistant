import { describe, it, expect, vi } from "vitest";

// The recorded greeting renders from SSML it built itself (a <phoneme> for the
// business name), so it must reach Google TTS untouched -- synthesizeMulaw
// re-wraps plain text through buildSayContent, which would escape the tags.
const synthesizeSpeech = vi.fn(async () => {
  const header = Buffer.concat([Buffer.from("RIFF0000WAVEfmt "), Buffer.alloc(20), Buffer.from("data"), Buffer.alloc(4)]);
  return [{ audioContent: Buffer.concat([header, Buffer.alloc(800, 0x7f)]) }];
});
vi.mock("@google-cloud/text-to-speech", () => ({
  TextToSpeechClient: vi.fn(() => ({ synthesizeSpeech })),
}));

process.env.GOOGLE_TTS_API_KEY = "test-key";
const { synthesizeSsmlMulaw } = await import("../services/googleTts.js");

describe("synthesizeSsmlMulaw", () => {
  it("sends the SSML as given, in the named voice, as 8 kHz mu-law, and strips the WAV header", async () => {
    const ssml = '<speak>Thanks for calling <phoneme alphabet="ipa" ph="ˈdɪdʒaɪl">Digile</phoneme> Media.</speak>';
    const audio = await synthesizeSsmlMulaw(ssml, "en-GB-Chirp3-HD-Kore");
    expect(synthesizeSpeech).toHaveBeenCalledWith({
      input: { ssml },
      voice: { languageCode: "en-GB", name: "en-GB-Chirp3-HD-Kore" },
      audioConfig: { audioEncoding: "MULAW", sampleRateHertz: 8000 },
    });
    expect(audio.length).toBe(800);
  });
});

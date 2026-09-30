// tests/sttOneShot.test.js
/**
 * Stage 4 S4-2: lib/voice/sttDeepgram.js transcribeMulawOnce -- the prerecorded
 * one-shot that reads held caller audio when Gemini Live did not. The SDK is a
 * stub whose RETURN shape is the real one (a MediaTranscribeResponse body:
 * results.channels[0].alternatives[0].transcript), not a shape invented from a
 * log line. The paid sim is what proves the real API accepts the WAV.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const gate = vi.hoisted(() => ({ refuse: false }));
vi.mock("@deepgram/sdk", () => ({ DeepgramClient: vi.fn() }));
vi.mock("../lib/logger.js", () => ({ log: { debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/compliance.js", async (importActual) => {
  // The producer's own error class, so the refusal has the real shape.
  const actual = await importActual();
  return {
    ...actual,
    assertVendorAllowed: vi.fn((vendor) => {
      if (gate.refuse) throw new actual.ComplianceViolationError(vendor);
    }),
  };
});

import { transcribeMulawOnce, wrapMulawAsWav } from "../lib/voice/sttDeepgram.js";
import { log } from "../lib/logger.js";

const FRAMES = [Buffer.alloc(160, 0x11), Buffer.alloc(160, 0x22), Buffer.alloc(160, 0x33)];
const ENV = { DEEPGRAM_API_KEY: "test-key" };
const body = (transcript) => ({ results: { channels: [{ alternatives: [{ transcript, confidence: 0.9 }] }] } });

function factoryFor(transcribeFile) {
  const seen = { opts: null };
  const factory = vi.fn((opts) => {
    seen.opts = opts;
    return { listen: { v1: { media: { transcribeFile } } } };
  });
  return { factory, seen };
}

beforeEach(() => {
  gate.refuse = false;
  vi.clearAllMocks();
});

describe("wrapMulawAsWav", () => {
  it("is a well-formed RIFF/WAVE, format 7 (mu-law), 8 kHz mono 8-bit, with the audio bytes intact and the sizes consistent", () => {
    const audio = Buffer.concat(FRAMES);
    const wav = wrapMulawAsWav(audio);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.readUInt16LE(20)).toBe(7);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(8000);
    expect(wav.readUInt16LE(34)).toBe(8);
    expect(wav.toString("ascii", 50, 54)).toBe("data");
    expect(wav.readUInt32LE(54)).toBe(audio.length);
    expect(wav.subarray(58, 58 + audio.length).equals(audio)).toBe(true);
  });

  it("word-aligns an odd-length payload (the declared data size stays the true size)", () => {
    const wav = wrapMulawAsWav(Buffer.alloc(161, 0x44));
    expect(wav.readUInt32LE(54)).toBe(161);
    expect(wav.length % 2).toBe(0);
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
  });
});

describe("transcribeMulawOnce", () => {
  it("returns the trimmed transcript; sends the WAV once, nova-3, MIP opted out, no retries, with an abort signal", async () => {
    const transcribeFile = vi.fn(async () => body("  Please stop calling me.  "));
    const { factory, seen } = factoryFor(transcribeFile);
    const out = await transcribeMulawOnce({ frames: FRAMES, callSid: "CA1", env: ENV, clientFactory: factory });
    expect(out.text).toBe("Please stop calling me.");
    expect(typeof out.ms).toBe("number");
    expect(transcribeFile).toHaveBeenCalledTimes(1);
    const [upload, request, options] = transcribeFile.mock.calls[0];
    expect(Buffer.isBuffer(upload) && upload.toString("ascii", 0, 4)).toBe("RIFF");
    expect(request).toMatchObject({ model: "nova-3", language: "en", mip_opt_out: true });
    const gbFn = vi.fn(async () => body("x"));
    await transcribeMulawOnce({ frames: FRAMES, env: ENV, language: "en-GB", clientFactory: factoryFor(gbFn).factory });
    expect(gbFn.mock.calls[0][1].language).toBe("en-GB");
    expect(options).toMatchObject({ maxRetries: 0 });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    expect(seen.opts.apiKey).toBe("test-key");
    // The debug line states the request shape and carries no audio and no text.
    const dbg = log.debug.mock.calls.find(([e]) => e === "stt_one_shot_request");
    expect(dbg[1]).toMatchObject({ callSid: "CA1", container: "wav/mulaw/8000", mip_opt_out: true });
    expect(JSON.stringify(log.debug.mock.calls)).not.toMatch(/stop calling/i);
  });

  it("points the client at the EU base URL when DEEPGRAM_REGION=eu (the same switch the streaming path uses), the US one otherwise", async () => {
    const eu = factoryFor(vi.fn(async () => body("x")));
    await transcribeMulawOnce({ frames: FRAMES, env: { ...ENV, DEEPGRAM_REGION: "eu" }, clientFactory: eu.factory });
    expect(eu.seen.opts.environment.base).toBe("https://api.eu.deepgram.com");
    const us = factoryFor(vi.fn(async () => body("x")));
    await transcribeMulawOnce({ frames: FRAMES, env: ENV, clientFactory: us.factory });
    expect(us.seen.opts.environment.base).toBe("https://api.deepgram.com");
  });

  it("an EMPTY transcript is a normal return with text '' (silence), not a throw", async () => {
    const { factory } = factoryFor(vi.fn(async () => body("")));
    await expect(transcribeMulawOnce({ frames: FRAMES, env: ENV, clientFactory: factory })).resolves.toMatchObject({ text: "" });
  });

  it("THROWS on: hipaa refusal (before the key is read or a client built), no key, no audio, an HTTP error, a body with no transcript field", async () => {
    gate.refuse = true;
    const refused = factoryFor(vi.fn());
    await expect(transcribeMulawOnce({ frames: FRAMES, env: ENV, clientFactory: refused.factory })).rejects.toMatchObject({ name: "ComplianceViolationError" });
    expect(refused.factory).not.toHaveBeenCalled();
    gate.refuse = false;

    await expect(transcribeMulawOnce({ frames: FRAMES, env: {}, clientFactory: factoryFor(vi.fn()).factory })).rejects.toThrow(/DEEPGRAM_API_KEY/);
    await expect(transcribeMulawOnce({ frames: [], env: ENV, clientFactory: factoryFor(vi.fn()).factory })).rejects.toThrow(/no audio/);
    await expect(
      transcribeMulawOnce({ frames: FRAMES, env: ENV, clientFactory: factoryFor(vi.fn(async () => { throw new Error("503"); })).factory })
    ).rejects.toThrow("503");
    await expect(
      transcribeMulawOnce({ frames: FRAMES, env: ENV, clientFactory: factoryFor(vi.fn(async () => ({ results: {} }))).factory })
    ).rejects.toThrow(/no transcript field/);
  });

  it("is bounded: a request that never answers rejects at timeoutMs and aborts the request", async () => {
    let signal;
    const never = vi.fn((_u, _r, opts) => {
      signal = opts.abortSignal;
      return new Promise(() => {});
    });
    const started = Date.now();
    await expect(transcribeMulawOnce({ frames: FRAMES, env: ENV, timeoutMs: 60, clientFactory: factoryFor(never).factory })).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(signal.aborted).toBe(true);
  });
});

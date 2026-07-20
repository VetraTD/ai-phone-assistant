import { describe, it, expect, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Which of the two live call pipelines handles a new Media Streams
// connection. v2 (lib/voice/session.js) is the default as of this release;
// lib/mediaStream.js is retained purely as a rollback escape hatch behind
// PIPELINE_V2=false.
//
// This matters because v2 carries a pile of behaviour the legacy pipeline
// lacks: the LLM turn timeout (without it a hung Gemini stream holds the call
// to the 30-minute cap), the deterministic take-message fallback,
// ElevenLabs/per-business voice selection (the dashboard's voice picker
// writes columns legacy never reads), multilingual STT, the toSpeakable
// normalizer, the utterance cache, and VAD barge-in.
// ---------------------------------------------------------------------------

// Imported once, at collection time: server.js is a heavy module (express app
// + all services), and a per-test dynamic import blew the 5s test timeout
// when the suite runs in parallel. selectPipelineHandler reads process.env on
// every call, so a single import is enough to exercise all four cases.
const { selectPipelineHandler } = await import("../server.js");
const { handleVoiceSessionConnection } = await import("../lib/voice/session.js");
const { handleMediaStreamConnection } = await import("../lib/mediaStream.js");

const ORIGINAL = process.env.PIPELINE_V2;

beforeEach(() => {
  delete process.env.PIPELINE_V2;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PIPELINE_V2;
  else process.env.PIPELINE_V2 = ORIGINAL;
});

describe("pipeline selection", () => {
  it("defaults to the v2 session pipeline when PIPELINE_V2 is unset", () => {
    expect(selectPipelineHandler()).toBe(handleVoiceSessionConnection);
  });

  it(`uses v2 for PIPELINE_V2="true" as well`, () => {
    process.env.PIPELINE_V2 = "true";
    expect(selectPipelineHandler()).toBe(handleVoiceSessionConnection);
  });

  it('falls back to the legacy pipeline ONLY for the explicit opt-out PIPELINE_V2="false"', async () => {
    process.env.PIPELINE_V2 = "false";
    expect(selectPipelineHandler()).toBe(handleMediaStreamConnection);
  });

  it("an unrecognized value is not treated as an opt-out", async () => {
    process.env.PIPELINE_V2 = "off";
    expect(selectPipelineHandler()).toBe(handleVoiceSessionConnection);
  });
});

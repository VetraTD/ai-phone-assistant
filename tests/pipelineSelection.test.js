import { describe, it, expect, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// There is one call pipeline. A10 deleted lib/mediaStream.js and the
// PIPELINE_V2 opt-out that reached it.
//
// This file used to assert that the escape hatch worked. It now asserts the
// opposite — that no environment variable can select anything else — because
// the hatch was the risk. The two pipelines had stopped being comparable: v2
// carries the LLM turn timeout (without which a hung Gemini stream holds a
// call to the 30-minute cap), the deterministic take-message fallback,
// per-business voice selection, ElevenLabs streaming, multilingual STT, the
// toSpeakable normalizer, the utterance cache and VAD barge-in. Setting
// PIPELINE_V2=false during an incident would have been a second, worse
// incident, in code nobody had exercised since every measurement in the ledger
// runs through v2.
//
// The rollback path that actually exists is repointing the Twilio webhooks.
// ---------------------------------------------------------------------------

const { selectPipelineHandler } = await import("../server.js");
const { handleVoiceSessionConnection } = await import("../lib/voice/session.js");

const ORIGINAL = process.env.PIPELINE_V2;

beforeEach(() => {
  delete process.env.PIPELINE_V2;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PIPELINE_V2;
  else process.env.PIPELINE_V2 = ORIGINAL;
});

describe("pipeline selection", () => {
  it.each([
    ["unset", undefined],
    ["true", "true"],
    // The value that used to select the legacy pipeline. It is now inert, and
    // that is the assertion: a stale PIPELINE_V2=false left in a deployment's
    // environment must be a no-op, not a crash and not a different pipeline.
    ["false", "false"],
    ["an unrecognized value", "off"],
  ])("returns the v2 session pipeline with PIPELINE_V2 %s", (_label, value) => {
    if (value === undefined) delete process.env.PIPELINE_V2;
    else process.env.PIPELINE_V2 = value;

    expect(selectPipelineHandler()).toBe(handleVoiceSessionConnection);
  });

  it("the legacy pipeline module is gone from disk", async () => {
    const fs = await import("fs");
    expect(fs.existsSync(new URL("../lib/mediaStream.js", import.meta.url))).toBe(false);
  });
});

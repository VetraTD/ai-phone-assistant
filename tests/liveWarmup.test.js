import { describe, it, expect, vi, afterEach } from "vitest";
import { warmLiveFrontEnd } from "../lib/voice/live/index.js";

// ---------------------------------------------------------------------------
// LVX17. The first call after any restart was three seconds of silence.
//
// Reported by the owner as a long-standing pattern -- "after we make a change
// it does not speak for the first call and then starts speaking from the second
// call onwards" -- and measured on a real pair:
//
//   live_stream_start -> live_session_open   cold 2,302 ms   warm 53 ms
//
// Plus ~680 ms to first audio. The caller hung up at 3,320 ms having heard
// nothing, which is the correct thing for a person to do with a line that
// appears dead.
//
// The cascade cannot get into this state: it speaks a TTS greeting immediately
// while everything warms. This path has NO voice until the model connects, so
// every cold-start cost is dead air the caller sits through -- module load, the
// @google/genai client, the database pool, the websocket handshake.
//
// Cloud Run makes it worse, not better: scale-to-zero means the cold path runs
// again after every idle period, not just after a deploy.
//
// So the work moves to boot. The one hard requirement is that warming must
// never be able to prevent the server starting -- a process that refuses to
// boot because a Live credential is missing is a far worse outcome than a slow
// first Live call, especially on a service whose main job is the cascade.
// ---------------------------------------------------------------------------

afterEach(() => vi.unstubAllEnvs());

describe("warming the Live front-end at boot", () => {
  it("reports success when it can build a client", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    await expect(warmLiveFrontEnd()).resolves.toBe(true);
  });

  it("never throws when the credential is missing", async () => {
    // The cascade shares this process. Warming is best-effort by definition.
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("LIVE_SURFACE", "");
    await expect(warmLiveFrontEnd()).resolves.toBe(false);
  });

  it("never throws when the surface is misconfigured", async () => {
    vi.stubEnv("LIVE_SURFACE", "vertex");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
    await expect(warmLiveFrontEnd()).resolves.toBe(false);
  });

  it("is safe to call more than once", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    await warmLiveFrontEnd();
    await expect(warmLiveFrontEnd()).resolves.toBe(true);
  });
});

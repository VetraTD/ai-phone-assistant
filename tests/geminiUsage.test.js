import { describe, it, expect } from "vitest";
import { buildUsage } from "../services/gemini.js";

// ---------------------------------------------------------------------------
// Gemini's implicit prompt caching only hits on a stable prefix, which is the
// entire reason buildSystemInstruction splits into a static prefix + dynamic
// tail. Whether that actually works has never been observable: the SDK's
// cachedContentTokenCount was logged at DEBUG and then dropped before the
// usage object left the module, so nothing downstream could count it.
//
// A hit rate near zero means the whole prefix is re-processed every turn —
// which inflates LLM time-to-first-token on every candidate model equally, and
// so has to be ruled out BEFORE any vendor benchmark is worth running.
// ---------------------------------------------------------------------------

describe("buildUsage — telemetry shaping for one LLM turn", () => {
  it("returns null when the SDK reported no usage at all", () => {
    expect(buildUsage(null)).toBeNull();
    expect(buildUsage(undefined)).toBeNull();
  });

  it("carries the cached token count through to callers", () => {
    const usage = buildUsage({
      promptTokenCount: 4000,
      candidatesTokenCount: 60,
      cachedContentTokenCount: 3200,
    });

    expect(usage.cachedTokens).toBe(3200);
    expect(usage.promptTokens).toBe(4000);
    expect(usage.outputTokens).toBe(60);
  });

  it("reports a genuine zero-hit turn as 0, not as missing", () => {
    // The difference matters: 0 means "the cache did not hit", absent means
    // "this model/SDK never told us". Collapsing them would make a broken
    // cache prefix indistinguishable from an unreported one.
    const usage = buildUsage({
      promptTokenCount: 4000,
      candidatesTokenCount: 60,
      cachedContentTokenCount: 0,
    });

    expect(usage.cachedTokens).toBe(0);
  });

  it("omits cachedTokens entirely when the SDK did not report it", () => {
    const usage = buildUsage({ promptTokenCount: 4000, candidatesTokenCount: 60 });

    expect("cachedTokens" in usage).toBe(false);
  });

  it("still omits thoughtsTokens when absent and includes it when present", () => {
    expect("thoughtsTokens" in buildUsage({ promptTokenCount: 10 })).toBe(false);
    expect(buildUsage({ promptTokenCount: 10, thoughtsTokenCount: 7 }).thoughtsTokens).toBe(7);
  });

  it("nulls missing prompt/output counts rather than leaving them undefined", () => {
    const usage = buildUsage({ cachedContentTokenCount: 5 });

    expect(usage.promptTokens).toBeNull();
    expect(usage.outputTokens).toBeNull();
  });
});

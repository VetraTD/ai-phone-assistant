/**
 * The semantic end-of-turn arbiter, which is shipped OFF.
 *
 * These tests exist because "wired but disabled" is the state in which things
 * rot. VOICE_HOLD_TRAILING_MS spent two rounds written, tested and switched
 * off in production before anyone noticed it was doing nothing; the way that
 * happens is code whose behaviour nobody can see. So the wiring is asserted
 * here, in full, with a stubbed client and no network.
 *
 * The property that matters more than accuracy is FAIL OPEN. A late answer, a
 * thrown error, an unparseable reply, a missing client — every one of them
 * must return "no opinion" so the heuristic hold that is already running is
 * left exactly as it was. There is no path through this module where a caller
 * waits on it, and most of what follows is proving that.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  judgeTurnComplete,
  semanticEndpointEnabled,
  ARBITRATED_RULES,
} from "../lib/voice/endpointArbiter.js";

vi.mock("../lib/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

/** A client whose generateContent resolves with `text` after `delayMs`. */
function stubClient(text, delayMs = 0) {
  return () => ({
    models: {
      generateContent: vi.fn(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ text }), delayMs);
          }),
      ),
    },
  });
}

const ask = (fragment, getClient, deadlineMs = 500, recentTurns = []) =>
  judgeTurnComplete({ fragment, recentTurns, deadlineMs }, { getClient });

afterEach(() => {
  delete process.env.VOICE_SEMANTIC_ENDPOINT;
});

describe("semanticEndpointEnabled", () => {
  it("is off unless explicitly switched on", () => {
    delete process.env.VOICE_SEMANTIC_ENDPOINT;
    expect(semanticEndpointEnabled()).toBe(false);
    process.env.VOICE_SEMANTIC_ENDPOINT = "false";
    expect(semanticEndpointEnabled()).toBe(false);
    // Not truthy-tested: only the exact string turns it on, so a stray "0" or
    // "no" in an env file cannot start billing per turn.
    process.env.VOICE_SEMANTIC_ENDPOINT = "1";
    expect(semanticEndpointEnabled()).toBe(false);
    process.env.VOICE_SEMANTIC_ENDPOINT = "true";
    expect(semanticEndpointEnabled()).toBe(true);
  });
});

describe("ARBITRATED_RULES — which holds are worth asking about", () => {
  it("covers the ambiguous tiers and nothing else", () => {
    // The three tiers where the grammar genuinely does not settle it.
    expect(ARBITRATED_RULES.has("no_terminal_punctuation")).toBe(true);
    expect(ARBITRATED_RULES.has("trailing_incomplete")).toBe(true);
    expect(ARBITRATED_RULES.has("partial_digits")).toBe(true);
    // Near-certain already — nobody ends a sentence on "for" or "my name is",
    // so asking would be spending money to be told what we know.
    expect(ARBITRATED_RULES.has("trailing_conjunction")).toBe(false);
    expect(ARBITRATED_RULES.has("trailing_lead_in")).toBe(false);
    // Not a grammar question at all.
    expect(ARBITRATED_RULES.has("post_barge_settle")).toBe(false);
    // The fluent caller's every turn. If this were arbitrated the cost would
    // be per-turn rather than per-hesitation, which is the whole cost model.
    expect(ARBITRATED_RULES.has("terminal_punctuation")).toBe(false);
  });
});

describe("judgeTurnComplete — the verdict", () => {
  it("reads COMPLETE and INCOMPLETE", async () => {
    expect(await ask("yes that works", stubClient("COMPLETE"))).toEqual({ complete: true });
    expect(await ask("I'd like to book", stubClient("INCOMPLETE"))).toEqual({ complete: false });
  });

  it("tolerates the whitespace and casing a model actually returns", async () => {
    expect(await ask("x", stubClient("  complete\n"))).toEqual({ complete: true });
    expect(await ask("x", stubClient("Incomplete."))).toEqual({ complete: false });
  });

  it("passes recent conversation as context without letting it grow unbounded", async () => {
    const gen = vi.fn(async () => ({ text: "COMPLETE" }));
    const getClient = () => ({ models: { generateContent: gen } });
    await ask("Tuesday", getClient, 500, [
      { role: "user", parts: [{ text: "I'd like to book something." }] },
      { role: "model", parts: [{ text: "Of course — what day suits?" }] },
      // Long enough to be dropped: a hold cannot cover a prompt that grows
      // with the call.
      { role: "user", parts: [{ text: "x".repeat(400) }] },
    ]);
    const sent = gen.mock.calls[0][0].contents;
    expect(sent).toContain("what day suits");
    expect(sent).not.toContain("x".repeat(400));
  });
});

describe("judgeTurnComplete — failing open", () => {
  it("returns no opinion when the answer arrives after the deadline", async () => {
    // THE property. The hold is already running; a late answer must not be
    // allowed to reopen a decision the timer has made.
    const slow = stubClient("INCOMPLETE", 200);
    expect(await ask("I'd like to book", slow, 40)).toEqual({ complete: null });
  });

  it("returns no opinion when the model says something that is not an answer", async () => {
    expect(await ask("x", stubClient("Well, it depends"))).toEqual({ complete: null });
    expect(await ask("x", stubClient(""))).toEqual({ complete: null });
    expect(await ask("x", stubClient(undefined))).toEqual({ complete: null });
  });

  it("returns no opinion when the call throws", async () => {
    const boom = () => ({
      models: {
        generateContent: vi.fn(async () => {
          throw new Error("quota exhausted");
        }),
      },
    });
    expect(await ask("x", boom)).toEqual({ complete: null });
  });

  it("returns no opinion when there is no client to ask", async () => {
    expect(await judgeTurnComplete({ fragment: "x", deadlineMs: 100 })).toEqual({ complete: null });
    expect(await ask("x", null)).toEqual({ complete: null });
  });

  it("returns no opinion on an empty fragment or a nonsense deadline", async () => {
    const c = stubClient("COMPLETE");
    expect(await ask("", c)).toEqual({ complete: null });
    expect(await ask("   ", c)).toEqual({ complete: null });
    expect(await ask("x", c, 0)).toEqual({ complete: null });
    expect(await ask("x", c, -1)).toEqual({ complete: null });
    expect(await ask("x", c, NaN)).toEqual({ complete: null });
  });

  it("never asks the model anything when the fragment is empty", async () => {
    // Cheapest possible guard, asserted because it is per-turn money.
    const gen = vi.fn(async () => ({ text: "COMPLETE" }));
    await judgeTurnComplete(
      { fragment: "  ", deadlineMs: 500 },
      { getClient: () => ({ models: { generateContent: gen } }) },
    );
    expect(gen).not.toHaveBeenCalled();
  });
});

describe("judgeTurnComplete — the request itself", () => {
  it("asks the small model, with thinking off and a tiny output budget", async () => {
    const gen = vi.fn(async () => ({ text: "COMPLETE" }));
    await ask("Tuesday", () => ({ models: { generateContent: gen } }));
    const req = gen.mock.calls[0][0];
    expect(req.model).toBe("gemini-3.6-flash");
    // Thinking tokens would blow the deadline on every single turn.
    expect(req.config.thinkingConfig.thinkingBudget).toBe(0);
    expect(req.config.temperature).toBe(0);
    expect(req.config.maxOutputTokens).toBeLessThanOrEqual(8);
  });

  it("tells the model to ignore the recognizer's punctuation", async () => {
    // The reason this exists at all: smart_format punctuates mid-thought
    // fragments, which is what makes them read as finished sentences.
    const gen = vi.fn(async () => ({ text: "COMPLETE" }));
    await ask("I'd like to book", () => ({ models: { generateContent: gen } }));
    expect(gen.mock.calls[0][0].contents).toMatch(/punctuation/i);
  });
});

/**
 * The spelling cap, enforced in code rather than requested in prose.
 *
 * capabilities/appointments.js has told the model "Ask this at most once" and
 * "never ask them to spell it a second time" for some time. The eval suite
 * still caught it asking "could you spell your last name?" on NINE consecutive
 * turns, in 2 of 5 runs, with every hard assert green — the failure was
 * caller-facing and completely invisible to the gate.
 *
 * The lesson generalizes: a prompt rule about what the model did EARLIER is
 * something it has to remember. A line in the dynamic tail is something it
 * reads fresh every turn. Anything that must hold across a long call belongs
 * in the second category.
 *
 * 2026-08-31: the cap was only ever half the problem. Counting the ASSISTANT's
 * questions stopped the nine-turn interrogation, but it also meant the gate
 * opened on having asked rather than on having been answered — so the opposite
 * failure was still live, and quieter: a caller who ignored the question got
 * their mis-heard name written to the database and nothing in the call could
 * tell. What the call now tracks is in lib/spellingSignal.js and the
 * lifecycle assertions in tests/spellingSignal.test.js; what stayed here is
 * the ceiling, which is now a backstop rather than the policy.
 */

import { describe, it, expect } from "vitest";
import { getStrings } from "../lib/voice/strings.js";
import { applyReplyState, hasSpentSpellingAsk, spellAskCap } from "../lib/voice/replyState.js";
import { STEPS } from "../lib/callState.js";
import { buildDynamicTail } from "../services/gemini.js";
import { loadConfig } from "../services/db.js";

const config = () =>
  loadConfig({
    id: "b1",
    name: "Testwork Dental",
    timezone: "America/Chicago",
    allowed_tasks: ["book_appointment"],
    business_capabilities: [{ capability_id: "appointments", enabled: true, config: {} }],
  });

const tail = (extras) =>
  buildDynamicTail("gather_details", "book_appointment", config(), {
    knowledge: [],
    integrations: [],
    transferAllowed: true,
    ...extras,
  });

describe("spellRequestRe — recognising the assistant's own spelling request", () => {
  const re = () => getStrings({}).spellRequestRe;

  it("matches the exact phrasings the prompt tells it to use", () => {
    // These two are quoted verbatim in capabilities/appointments.js and
    // capabilities/messages.js, so they are the ones that must never be missed.
    expect(re().test("Just to make sure I have it right, could you spell your last name?")).toBe(true);
    expect(re().test("Could you spell that for me?")).toBe(true);
  });

  it("matches the natural variations the model actually produces", () => {
    expect(re().test("How do you spell that?")).toBe(true);
    expect(re().test("Can you spell it out for me?")).toBe(true);
    expect(re().test("And the spelling of your surname?")).toBe(true);
  });

  it("does not fire on ordinary receptionist speech", () => {
    // A false positive burns the call's one spelling request without a
    // question ever being asked, which is worse than not counting at all.
    expect(re().test("Thanks, Marcus — what time works for you?")).toBe(false);
    expect(re().test("Let me check that for you.")).toBe(false);
    expect(re().test("I have you down for Tuesday at ten.")).toBe(false);
  });
});

describe("dynamic tail — the SPELLING SETTLED block", () => {
  it("emits nothing at all while the spelling question is still open", () => {
    // Load-bearing: every existing tail snapshot is recorded without this
    // flag, so a non-empty default would move all of them.
    expect(tail({})).not.toMatch(/SPELLING SETTLED/);
    expect(tail({ spellingSettled: false })).not.toMatch(/SPELLING SETTLED/);
  });

  it("states the closure as a fact once the question is settled", () => {
    const out = tail({ spellingSettled: true });
    expect(out).toMatch(/SPELLING SETTLED/);
    expect(out).toMatch(/spelling question is closed/i);
    expect(out).toMatch(/do not ask again/i);
  });

  // The distinction the whole change turns on. The open block must ask for a
  // spelling AND say the write is blocked without one, because a model that
  // reads "ask them once, and carry on if they don't answer" will do exactly
  // that and hand the gate a name nobody confirmed.
  it("tells the model the write is blocked, not merely that asking is polite", () => {
    const out = tail({ spellingSettled: false });
    expect(out).toMatch(/SPELLING NOT YET CONFIRMED/);
    expect(out).toMatch(/cannot record a name until they have spelled it/i);
  });
});

describe("applyReplyState — the counter both drivers share", () => {
  const deps = () => ({
    STEPS,
    mergeCapabilityState: () => {},
    dispatchEffects: () => [],
    spellRequestRe: getStrings({}).spellRequestRe,
  });
  const freshState = () => ({ history: [], step: STEPS.GATHER_DETAILS, intent: null });
  const say = (state, text) =>
    applyReplyState(state, { userText: "hi", reply: { text } }, deps());

  it("counts a spelling request from the assistant's reply", () => {
    const state = freshState();
    expect(hasSpentSpellingAsk(state)).toBe(false);
    say(state, "Could you spell that for me?");
    expect(state.spellAsks).toBe(1);
    // One ask no longer spends the call's allowance. It used to, and that is
    // precisely how a caller who ignored the question ended up with a
    // mis-spelled record: the flag latched on OUR question rather than THEIR
    // answer. The ceiling is now a backstop at 3, not the policy.
    expect(hasSpentSpellingAsk(state)).toBe(false);
  });

  it("does not count ordinary replies", () => {
    const state = freshState();
    say(state, "Thanks, Marcus — what time works for you?");
    say(state, "I have you down for Tuesday at ten.");
    expect(state.spellAsks || 0).toBe(0);
    expect(hasSpentSpellingAsk(state)).toBe(false);
  });

  it("keeps counting past the cap, so the flag latches rather than oscillating", () => {
    const state = freshState();
    say(state, "Could you spell that for me?");
    say(state, "Sorry, could you spell your last name?");
    say(state, "One more time — how do you spell it?");
    expect(state.spellAsks).toBe(3);
    expect(hasSpentSpellingAsk(state)).toBe(true);
    say(state, "And could you spell that for me?");
    expect(state.spellAsks).toBe(4);
    expect(hasSpentSpellingAsk(state)).toBe(true);
  });

  it("counts nothing when no regex is supplied, leaving other callers unaffected", () => {
    const state = freshState();
    applyReplyState(
      state,
      { userText: "hi", reply: { text: "Could you spell that for me?" } },
      { STEPS, mergeCapabilityState: () => {}, dispatchEffects: () => [] },
    );
    expect(state.spellAsks).toBeUndefined();
  });

  it("exposes a hard ask ceiling of 3 by default", () => {
    expect(spellAskCap()).toBe(3);
  });
});

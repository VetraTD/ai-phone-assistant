/**
 * Which sentences are safe to swallow.
 *
 * The promise gate throws a sentence away and speaks the engine's line
 * instead, so a false positive here does not produce a clumsy line — it
 * produces a caller who never hears a question they were meant to answer.
 * Every case below that expects `false` is worth more than the ones that
 * expect `true`: failing to gate costs accuracy, over-gating costs the call.
 */

import { describe, it, expect, afterEach } from "vitest";
import { isPromiseOnly, promiseGateMs } from "../lib/voice/promiseGate.js";
import { getStrings } from "../lib/voice/strings.js";

const EN = getStrings("en").promiseRe;
const ES = getStrings("es").promiseRe;

describe("isPromiseOnly — a sentence that is nothing but a wait line", () => {
  it("recognises the lines the model actually volunteers", () => {
    expect(isPromiseOnly("One moment.", EN)).toBe(true);
    expect(isPromiseOnly("One moment while I check that for you.", EN)).toBe(true);
    expect(isPromiseOnly("Let me check the calendar.", EN)).toBe(true);
    expect(isPromiseOnly("Let me just pull up your appointment.", EN)).toBe(true);
    expect(isPromiseOnly("I'll check that now.", EN)).toBe(true);
    expect(isPromiseOnly("Bear with me.", EN)).toBe(true);
  });

  it("leaves a promise that also asks something alone", () => {
    // The question is the only thing moving the call forward. Swallowing it
    // strands the caller waiting for a prompt they never heard.
    expect(isPromiseOnly("One moment — what was the name again?", EN)).toBe(false);
    expect(isPromiseOnly("Let me check. What day suits you?", EN)).toBe(false);
  });

  it("leaves a promise carrying other content alone", () => {
    expect(
      isPromiseOnly(
        "One moment while I check that, and I should mention we close early on Fridays.",
        EN,
      ),
    ).toBe(false);
  });

  it("does not fire on ordinary speech", () => {
    expect(isPromiseOnly("You are booked for Tuesday at ten.", EN)).toBe(false);
    expect(isPromiseOnly("We are open until six.", EN)).toBe(false);
    expect(isPromiseOnly("Thanks, Marcus.", EN)).toBe(false);
  });

  it("handles empty, missing and non-string input without throwing", () => {
    expect(isPromiseOnly("", EN)).toBe(false);
    expect(isPromiseOnly(null, EN)).toBe(false);
    expect(isPromiseOnly("One moment.", null)).toBe(false);
    expect(isPromiseOnly("One moment.", undefined)).toBe(false);
  });

  it("uses the call's own locale pattern", () => {
    expect(isPromiseOnly("Un momento.", ES)).toBe(true);
    expect(isPromiseOnly("Déjeme revisar la agenda.", ES)).toBe(true);
    expect(isPromiseOnly("Está reservado para el martes.", ES)).toBe(false);
    // ...and does not read Spanish with the English pattern.
    expect(isPromiseOnly("Un momento.", EN)).toBe(false);
  });
});

describe("promiseGateMs", () => {
  const prev = process.env.VOICE_PROMISE_GATE_MS;
  afterEach(() => {
    if (prev === undefined) delete process.env.VOICE_PROMISE_GATE_MS;
    else process.env.VOICE_PROMISE_GATE_MS = prev;
  });

  it("defaults to 350ms", () => {
    delete process.env.VOICE_PROMISE_GATE_MS;
    expect(promiseGateMs()).toBe(350);
  });

  it("honours an override and can be switched off entirely", () => {
    process.env.VOICE_PROMISE_GATE_MS = "500";
    expect(promiseGateMs()).toBe(500);
    process.env.VOICE_PROMISE_GATE_MS = "0";
    expect(promiseGateMs()).toBe(0);
  });

  it("clamps nonsense back to the default rather than trusting it", () => {
    // An unbounded value here would hold a real sentence out of the caller's
    // ear for as long as the number says.
    process.env.VOICE_PROMISE_GATE_MS = "99999";
    expect(promiseGateMs()).toBe(350);
    process.env.VOICE_PROMISE_GATE_MS = "-1";
    expect(promiseGateMs()).toBe(350);
    process.env.VOICE_PROMISE_GATE_MS = "abc";
    expect(promiseGateMs()).toBe(350);
  });
});

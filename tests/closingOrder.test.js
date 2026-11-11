// ---------------------------------------------------------------------------
// LVX178 — "anything else?" must come BEFORE the goodbye, never after it.
//
// The shape, from production (call-corpus/, prototyped over all 434 assistant
// turns on 2026-10-13: 32 farewell turns, every one a real farewell; the two
// one-breath backwards turns below are the only ones, both real):
//   "…is now cancelled. Thank you for calling Digile Media, and have a
//    wonderful day.Is there anything else I can help you with today?"
// The model had planned its goodbye; the end_call gate refused; it said the
// goodbye AND the ask. `farewellBeforeAsk` counts it; it never blocks anything.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { getStrings } from "../lib/voice/strings.js";
import { farewellIndex, farewellBeforeAsk } from "../lib/voice/closingOrder.js";

const EN = getStrings("en");
const ES = getStrings("es");

describe("farewellBeforeAsk — real backwards turns", () => {
  it.each([
    // CA2ca0ed73 (the "?" is a mangled em dash, as logged)
    "I have that scheduled for you ? thank you for calling Digile Media, and wishing you a great day.Is there anything else I can help you with today?",
    // CAea2b08b9
    "Your appointment on Wednesday, September 23 at 9 00 AM is now cancelled. Thank you for calling Digile Media, and have a wonderful day.Is there anything else I can help you with today?",
  ])("counts %#", (text) => {
    expect(farewellBeforeAsk(text, EN)).toBe(true);
  });
});

describe("farewellBeforeAsk — what it must not count", () => {
  it("the right order: ask, then goodbye in one breath", () => {
    // Real, from the same corpus. A different defect (it did not wait for the
    // answer), but not the backwards order.
    const t =
      "Your appointment has been successfully updated to Monday, September 21st at 1 PM. Is there anything else I can help you with today?Thank you for calling Digile Media, and have a great day.";
    expect(farewellBeforeAsk(t, EN)).toBe(false);
  });

  it("the greeting, which opens with 'Thanks for calling'", () => {
    const t =
      "Thanks for calling Digile Media. You're through to our AI receptionist ? calls are recorded for quality. How can I help you today?";
    expect(farewellIndex(t, EN)).toBe(-1);
    expect(farewellBeforeAsk(t, EN)).toBe(false);
  });

  it("an ask with no goodbye, and a goodbye with no ask", () => {
    expect(farewellBeforeAsk("That is booked. Is there anything else I can help you with today?", EN)).toBe(false);
    expect(farewellBeforeAsk("Thanks for calling Digile Media, and have a great day.", EN)).toBe(false);
  });

  // Final review: phrases that are not goodbyes, counted against a target of 0.
  it.each([
    "I'll take care of that for you. Is there anything else I can help you with?",
    "Do you have a day in mind? Is there anything else you'd like to add?",
    "We have a morning slot open. Is there anything else you need?",
    "Good morning, thanks for calling Digile Media. Is there anything else I can help with?",
  ])("not a goodbye before the ask: %j", (t) => {
    expect(farewellBeforeAsk(t, EN)).toBe(false);
  });

  it("the default greeting does not open with a goodbye", () => {
    expect(farewellIndex("Good morning, thanks for calling Digile Media. How can I help you today?", EN)).toBe(-1);
  });

  it("empty or missing text", () => {
    expect(farewellBeforeAsk("", EN)).toBe(false);
    expect(farewellBeforeAsk(undefined, EN)).toBe(false);
  });
});

describe("farewellIndex — the farewell shapes on record", () => {
  it.each([
    "Thanks for calling Digile Media, have a wonderful day.",
    "Thank you for calling Digile Media. Have a great day.",
    "Thanks again for calling Digile Media, Marcus. Have a great day.",
    "Thank you for calling Digile Media, and we wish you a wonderful day.",
    "I've booked your appointment for Wednesday, September 23rd at 2 PM under Nithin Dodla. Thank you for calling Digile Media, and I wish you well.",
    "Okay, take care. Goodbye!",
    "I think I've lost you. Feel free to call us back at 817 580 3291. Bye for now.",
  ])("finds the goodbye in %#", (text) => {
    expect(farewellIndex(text, EN)).toBeGreaterThanOrEqual(0);
  });

  // S4-F4: the close no longer names the business.
  it.each([
    "Thanks for calling, have a wonderful day.",
    "Thank you for calling. Have a great day!",
    "Thank you for calling. Take care!",
  ])("finds the NAME-FREE goodbye in %#", (text) => {
    expect(farewellIndex(text, EN)).toBeGreaterThanOrEqual(0);
  });

  it("a mid-turn 'thanks for calling' counts — only the turn-opening one is the greeting", () => {
    const t = "That is all booked. Thanks for calling Digile Media. Is there anything else I can help you with?";
    expect(farewellBeforeAsk(t, EN)).toBe(true);
  });
});

describe("Spanish", () => {
  it("counts the backwards order", () => {
    expect(
      farewellBeforeAsk("Gracias por llamar, que tenga un buen día. ¿Hay algo más en que pueda ayudarle?", ES)
    ).toBe(true);
  });

  it("does not count the right order", () => {
    expect(farewellBeforeAsk("¿Hay algo más en que pueda ayudarle? Gracias por llamar, adiós.", ES)).toBe(false);
  });
});

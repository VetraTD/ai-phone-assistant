import { describe, it, expect } from "vitest";
import { buildSystemInstruction } from "../services/gemini.js";
import { STEPS } from "../lib/callState.js";

// ---------------------------------------------------------------------------
// LVX16. The assistant must know the number the caller is calling FROM.
//
// Found on the first real call of the Live front-end. The caller was asked for
// a phone number, said "use the one I'm calling from", and asked for it back --
// and the assistant read out a number that was not theirs. Not a refusal: an
// invention.
//
// The cause is that `extras.callerPhone` reaches services/tools.js as tool
// context and stops there. Measured against Digile Media's config, the prompt
// runs to 17,353 characters and the calling number is in none of them, so the
// model had nothing and filled the gap.
//
// This is NOT a speech-to-speech defect. buildSystemInstruction is shared, so
// the cascade has the identical gap -- it had simply never been asked to read
// the calling number back.
//
// Worse than a refusal, which is what LVX4 was: `book_appointment` ran on that
// same call, and a fabricated number in a booking is a caller who never gets
// their reminder and a business that cannot reach them.
//
// It goes in the DYNAMIC tail, not the cacheable static prefix -- the prefix is
// the explicit-cache unit and must not vary per call.
// ---------------------------------------------------------------------------

const CONFIG = {
  businessName: "Digile Media",
  timezone: "Europe/London",
  allowedTasks: ["general_question", "take_message"],
  capabilities: { messages: { enabled: true } },
  businessHours: {},
};

const build = (extras) => buildSystemInstruction(STEPS.IDENTIFY_INTENT, null, CONFIG, { integrations: [], knowledge: [], ...extras });

describe("the caller's own number", () => {
  it("is in the prompt, so the model can state it when asked", () => {
    expect(build({ callerPhone: "+18175551234" })).toContain("817 555 1234");
  });

  it("is spoken WITHOUT the country code", () => {
    // Handed E.164, the model read the country code aloud -- "one four six
    // nine..." and later "plus one four six nine...". A caller hearing an extra
    // leading digit on their own number concludes it is wrong, which defeats
    // the entire point of reading it back.
    const prompt = build({ callerPhone: "+18175551234" });
    expect(prompt).not.toContain("+18175551234");
    expect(prompt).toMatch(/do NOT add a country code/);
  });

  it("leaves a number it does not recognise alone rather than guessing", () => {
    // A wrongly-stripped digit is worse than a spoken "plus".
    expect(build({ callerPhone: "+33123456789" })).toContain("+33123456789");
  });

  it("is absent when the caller withheld their number, rather than invented", () => {
    // A withheld number must leave NO claim in the prompt. Anything else and
    // the model has a placeholder it can read out as though it were real.
    // Asserted on the SECTION, not on the phrase: the prompt already contains
    // "the person calling from this number" in an unrelated privacy rule --
    // which is itself part of why the model invented one. It was told a number
    // existed and never shown it.
    const prompt = build({ callerPhone: null });
    expect(prompt).not.toContain("THIS CALLER'S NUMBER");
    expect(prompt).not.toMatch(/They are calling from/);
  });

  it("tells the model not to guess a number it was never given", () => {
    // The instruction half. Knowing the number fixes "use the one I'm calling
    // from"; it does not by itself stop the model inventing a DIFFERENT number
    // when it is asked for one it does not have.
    expect(build({ callerPhone: "+18175551234" })).toMatch(/never (state|guess|invent)/i);
  });

  it("does not put it in the cacheable static prefix", async () => {
    // The prefix is the explicit-cache unit. A per-call value there would
    // change the cache key on every call and cost the caching entirely.
    const { buildStaticSystemPrefix } = await import("../services/gemini.js");
    expect(buildStaticSystemPrefix(CONFIG, { integrations: [], callerPhone: "+18175551234" })).not.toContain("18175551234");
  });
});

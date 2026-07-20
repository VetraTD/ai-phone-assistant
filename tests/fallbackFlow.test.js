import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFallbackFlow } from "../lib/voice/fallbackFlow.js";

function makeFlow(overrides = {}) {
  const said = [];
  const onSay = vi.fn((text) => said.push(text));
  const onComplete = vi.fn();
  const onFail = vi.fn();
  const flow = createFallbackFlow({
    businessName: "Acme Dental",
    callerPhone: "+15559998888",
    onSay,
    onComplete,
    onFail,
    ...overrides,
  });
  return { flow, said, onSay, onComplete, onFail };
}

describe("fallbackFlow — deterministic no-LLM take-message flow", () => {
  it("1. happy path end-to-end: name -> number -> confirm -> message -> confirm -> onComplete args exact", () => {
    const { flow, said, onComplete } = makeFlow();
    flow.start();

    expect(said[0]).toBe(
      "I'm having a little trouble on my end, but I can still take a message. Can I get your name, please?"
    );
    expect(flow.getState()).toBe("awaiting_name");

    flow.handleInput("John Smith");
    expect(said[1]).toBe(
      "Thanks, John Smith. What's the best number to reach you? Please say it digit by digit."
    );
    expect(flow.getState()).toBe("awaiting_number");

    flow.handleInput("5551234567");
    expect(said[2]).toBe("Got it — that's 555, 123, 4567. Is that right?");
    expect(flow.getState()).toBe("confirming_number");

    flow.handleInput("yes");
    expect(said[3]).toBe("Perfect. And what's the message you'd like to leave?");
    expect(flow.getState()).toBe("awaiting_message");

    flow.handleInput("Please call me back about my order");
    expect(said[4]).toBe(
      "Let me read that back: Please call me back about my order. Anything you'd like to add or change?"
    );
    expect(flow.getState()).toBe("confirming_message");

    flow.handleInput("no that's all");
    expect(said[5]).toBe(
      "Great. I've got your message, and someone from Acme Dental will get back to you as soon as possible. Thanks for calling, and sorry again for the trouble. Goodbye!"
    );
    expect(flow.getState()).toBe("done");
    expect(flow.isActive()).toBe(false);

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith({
      callerName: "John Smith",
      callbackNumber: "5551234567",
      message: "Please call me back about my order",
    });
  });

  it("2. number re-ask then caller-ID fallback after a second unusable number", () => {
    const { flow, said } = makeFlow();
    flow.start();
    flow.handleInput("Jane Doe");

    // Deliberately no digits at all (not a partial recitation — see test 11
    // for that case) so this exercises the "genuinely bad answer" path
    // rather than the isIncomplete hold-and-combine path.
    flow.handleInput("I don't really know it offhand");
    expect(said[said.length - 1]).toBe(
      "Sorry, I didn't catch the full number. Could you say it again, digit by digit?"
    );
    expect(flow.getState()).toBe("awaiting_number");

    flow.handleInput("I can't remember right now"); // still no digits -> fall back to caller ID
    expect(said).toContain("No problem — I'll use the number you're calling from.");
    expect(flow.getState()).toBe("confirming_number");
    // caller ID digits (+15559998888 -> 15559998888) were used and read back.
    expect(said[said.length - 1]).toBe("Got it — that's 1, 555, 999, 8888. Is that right?");
  });

  it("3. number read-back grouping: 10-digit number groups as 3-3-4", () => {
    const { flow, said } = makeFlow();
    flow.start();
    flow.handleInput("Sam");
    flow.handleInput("5551234567");
    expect(said[said.length - 1]).toBe("Got it — that's 555, 123, 4567. Is that right?");
  });

  it("4. spelled-out digits are extracted correctly", () => {
    const { flow, said } = makeFlow();
    flow.start();
    flow.handleInput("Alex");
    flow.handleInput("five five five one two three four five six seven");
    expect(said[said.length - 1]).toBe("Got it — that's 555, 123, 4567. Is that right?");
  });

  it('5. "my name is John" strips the prefix down to "John"', () => {
    const { flow, said } = makeFlow();
    flow.start();
    flow.handleInput("my name is John");
    expect(said[said.length - 1]).toBe(
      "Thanks, John. What's the best number to reach you? Please say it digit by digit."
    );
  });

  it('5b. "this is" and "it\'s" prefixes are also stripped', () => {
    const { flow: flow1, said: said1 } = makeFlow();
    flow1.start();
    flow1.handleInput("this is Maria");
    expect(said1[said1.length - 1]).toContain("Thanks, Maria.");

    const { flow: flow2, said: said2 } = makeFlow();
    flow2.start();
    flow2.handleInput("it's Kevin");
    expect(said2[said2.length - 1]).toContain("Thanks, Kevin.");
  });

  it("6. empty input re-prompts once, then salvages a completed call with captured info", () => {
    const { flow, said, onComplete, onFail } = makeFlow();
    flow.start();
    flow.handleInput("Riley");
    const promptBeforeEmpty = said[said.length - 1];

    flow.handleInput(""); // first empty -> re-prompt
    expect(said[said.length - 1]).toBe(promptBeforeEmpty);
    expect(flow.getState()).toBe("awaiting_number");

    flow.handleInput("   "); // second consecutive empty -> salvage-complete
    expect(onFail).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith({
      callerName: "Riley",
      callbackNumber: null,
      message: "(caller did not leave details)",
    });
    expect(flow.isActive()).toBe(false);
  });

  it("7. empty input with zero captured info calls onFail", () => {
    const { flow, onComplete, onFail } = makeFlow();
    flow.start();
    flow.handleInput(""); // first empty (still in awaiting_name, nothing captured yet)
    flow.handleInput(""); // second consecutive empty -> nothing captured -> onFail
    expect(onComplete).not.toHaveBeenCalled();
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(flow.isActive()).toBe(false);
  });

  it("8. confirming_number 'no' re-asks once, then falls back to caller ID on the second rejection", () => {
    const { flow, said } = makeFlow();
    flow.start();
    flow.handleInput("Pat");
    flow.handleInput("5551234567");
    expect(flow.getState()).toBe("confirming_number");

    flow.handleInput("no that's wrong");
    expect(said[said.length - 1]).toBe(
      "Sorry, I didn't catch the full number. Could you say it again, digit by digit?"
    );
    expect(flow.getState()).toBe("awaiting_number");

    flow.handleInput("5559998887");
    expect(flow.getState()).toBe("confirming_number");
    flow.handleInput("no still wrong");
    expect(said).toContain("No problem — I'll use the number you're calling from.");
    expect(flow.getState()).toBe("confirming_number");
  });

  it("9. confirming_message: new content is appended once, then the second round is accepted", () => {
    const { flow, said, onComplete } = makeFlow();
    flow.start();
    flow.handleInput("Sam");
    flow.handleInput("5551234567");
    flow.handleInput("yes");
    flow.handleInput("call about billing");
    expect(flow.getState()).toBe("confirming_message");

    flow.handleInput("also mention the invoice");
    expect(flow.getState()).toBe("confirming_message");
    expect(said[said.length - 1]).toBe(
      "Let me read that back: call about billing also mention the invoice. Anything you'd like to add or change?"
    );

    flow.handleInput("one more thing"); // second round -> accepted regardless of content
    expect(flow.getState()).toBe("done");
    expect(onComplete).toHaveBeenCalledWith({
      callerName: "Sam",
      callbackNumber: "5551234567",
      message: "call about billing also mention the invoice",
    });
  });

  it("10. never throws and is inert before start()", () => {
    const { flow, onSay, onComplete, onFail } = makeFlow();
    expect(() => flow.handleInput("hello")).not.toThrow();
    expect(onSay).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(onFail).not.toHaveBeenCalled();
    expect(flow.isActive()).toBe(false);
  });

  it("11. a number split across two finals by STT is held silently and combined into one", () => {
    const { flow, said } = makeFlow();
    flow.start();
    flow.handleInput("Casey");
    const sayCountBeforeHold = said.length;

    // Looks like a partial number (6 trailing digits, <7) — held silently:
    // no re-prompt, no failure counted, state unchanged.
    flow.handleInput("555123");
    expect(said.length).toBe(sayCountBeforeHold);
    expect(flow.getState()).toBe("awaiting_number");

    // Continuation arrives on the next final -> combined and accepted as one number.
    flow.handleInput("4567");
    expect(said[said.length - 1]).toBe("Got it — that's 555, 123, 4567. Is that right?");
    expect(flow.getState()).toBe("confirming_number");
  });

  it("12. empty/missing callerPhone: number is skipped entirely instead of storing a blank number", () => {
    const { flow, said, onComplete } = makeFlow({ callerPhone: "" });
    flow.start();
    flow.handleInput("Jordan");

    flow.handleInput("I don't know it"); // no digits -> first failure -> re-ask
    expect(flow.getState()).toBe("awaiting_number");

    flow.handleInput("I still don't know it"); // no digits -> second failure -> callerPhone unusable -> skip
    expect(said[said.length - 1]).toBe(
      "No problem — let's move on. What's the message you'd like to leave?"
    );
    expect(flow.getState()).toBe("awaiting_message");

    flow.handleInput("please call about my invoice");
    flow.handleInput("no that's all");

    expect(onComplete).toHaveBeenCalledWith({
      callerName: "Jordan",
      callbackNumber: null,
      message: "please call about my invoice",
    });
  });

  it("13. rejecting the caller-ID fallback number does not loop — moves on without a number", () => {
    const { flow, said, onComplete } = makeFlow(); // default callerPhone "+15559998888"
    flow.start();
    flow.handleInput("Riley");
    flow.handleInput("I don't know it"); // first failure
    flow.handleInput("I still don't know it"); // second failure -> caller-ID number used
    expect(flow.getState()).toBe("confirming_number");
    expect(said).toContain("No problem — I'll use the number you're calling from.");

    flow.handleInput("no that's wrong too"); // reject the caller-ID number itself -> must not loop
    expect(said[said.length - 1]).toBe(
      "No problem — let's move on. What's the message you'd like to leave?"
    );
    expect(flow.getState()).toBe("awaiting_message");

    flow.handleInput("just a quick question about billing");
    flow.handleInput("nope");

    expect(onComplete).toHaveBeenCalledWith({
      callerName: "Riley",
      callbackNumber: null,
      message: "just a quick question about billing",
    });
  });

  describe("split-number hold: bounded timeout + restart detection", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("14. a held fragment with no continuation is flushed as its own attempt after the hold window (re-asks, doesn't strand)", () => {
      const { flow, said } = makeFlow();
      flow.start();
      flow.handleInput("Casey");

      // Looks like a partial number — held silently, no immediate re-ask.
      flow.handleInput("555123");
      expect(flow.getState()).toBe("awaiting_number");
      const sayCountAfterHold = said.length;

      // No continuation ever arrives — advance past the hold window.
      vi.advanceTimersByTime(1_001);

      // The fragment ("555123", 6 digits) was processed standalone -> too
      // short to be valid -> counted as a failed attempt -> re-ask.
      expect(said.length).toBeGreaterThan(sayCountAfterHold);
      expect(said[said.length - 1]).toBe(
        "Sorry, I didn't catch the full number. Could you say it again, digit by digit?"
      );
      expect(flow.getState()).toBe("awaiting_number");
    });

    it("15. a continuation that arrives just before the hold window still combines normally (no double-processing)", () => {
      const { flow, said } = makeFlow();
      flow.start();
      flow.handleInput("Casey");
      flow.handleInput("555123");

      vi.advanceTimersByTime(900); // still within the hold window
      flow.handleInput("4567");

      expect(said[said.length - 1]).toBe("Got it — that's 555, 123, 4567. Is that right?");
      expect(flow.getState()).toBe("confirming_number");

      // The hold timer must have been cancelled — advancing well past the
      // original window must not re-fire a stale flush.
      const sayCountAfterCombine = said.length;
      vi.advanceTimersByTime(5_000);
      expect(said.length).toBe(sayCountAfterCombine);
    });

    it("16. a fresh, self-valid full number after a held fragment is treated as a new attempt, not concatenated", () => {
      const { flow, said } = makeFlow();
      flow.start();
      flow.handleInput("Casey");

      // Partial recitation held...
      flow.handleInput("555123");
      expect(flow.getState()).toBe("awaiting_number");

      // ...then the caller RESTARTS with the full number instead of
      // continuing the fragment. Naive concatenation would produce
      // "5551235551234567" (16 digits) and force a needless re-ask.
      flow.handleInput("5551234567");

      expect(said[said.length - 1]).toBe("Got it — that's 555, 123, 4567. Is that right?");
      expect(flow.getState()).toBe("confirming_number");
    });

    it("17. the hold timer is cancelled when the flow completes before it fires (silence ends the call early)", () => {
      const { flow, onComplete, said } = makeFlow();
      flow.start();
      flow.handleInput("Casey");
      flow.handleInput("555123"); // held, timer armed

      // Caller goes silent — two consecutive empty finals end the flow
      // (name was already captured, so this is a success, not a failure).
      flow.handleInput("");
      flow.handleInput("");

      expect(onComplete).toHaveBeenCalledTimes(1);
      const sayCountAfterComplete = said.length;

      // If the original hold timer were still live, advancing past its
      // window would call flushHeldNumberFragment -> processNumberAttempt
      // against an already-"done" (inactive) flow, re-triggering say()/
      // state changes it has no business making anymore.
      vi.advanceTimersByTime(5_000);
      expect(said.length).toBe(sayCountAfterComplete);
      expect(onComplete).toHaveBeenCalledTimes(1);
    });
  });
});

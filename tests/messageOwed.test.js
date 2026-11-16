import { describe, it, expect } from "vitest";
import { messageOwed, callerDeclined, afterCallMessageText } from "../lib/voice/messageOwed.js";

const MUST_NOT_MATCH = [
  "No.",
  "No thanks.",
  "No, that's all, thanks.",
  "Nope, that's it.",
  "No, I'm good. Bye.",
  "That's everything, thank you.",
  "No thank you, have a good day.",
  "Yes please, tell him to call me back.",
  "Can you ask him to call me back tomorrow?",
  "He can call me back on this number.",
  "No, the message is fine as it is.",
  "Okay, I'll wait for his call.",
  "No, I don't have an email.",
  "Ahm",
  "Right, thanks.",
];
const MUST_MATCH = [
  "Never mind. I'm done.",
  "never mind",
  "No, no, just cancel the message.",
  "Forget it.",
  "No, I'll call back later.",
  "I'll just try again tomorrow.",
  "Don't worry about the message, thanks.",
  "No, no message, thanks.",
  "No need to leave a message.",
  "I don't need to leave a message.",
  "I'm gonna call back another time.",
];

describe("callerDeclined", () => {
  it.each(MUST_NOT_MATCH)("does not read %j as a decline", (t) => {
    expect(callerDeclined(t)).toBe(false);
  });
  it.each(MUST_MATCH)("reads %j as a decline", (t) => {
    expect(callerDeclined(t)).toBe(true);
  });
  it("is false for non-strings", () => {
    expect(callerDeclined(undefined)).toBe(false);
    expect(callerDeclined(null)).toBe(false);
  });
});

const base = () => ({
  outbound: false,
  healthcare: false,
  hasBusiness: true,
  hasCallRow: true,
  messagesRecorded: 0,
  hasPendingWrite: false,
  toolsAttempted: [],
  transferStarted: false,
  utterances: ["Hi, I want to talk about a website for my shop."],
  callerType: "new_enquiry",
  reasonGiven: true,
  takeIntent: false,
  sellerRule: false,
});
const owed = (over) => messageOwed({ ...base(), ...over });

describe("messageOwed", () => {
  it("is owed for a lead who gave a reason and left", () => {
    expect(owed({})).toBe(true);
  });
  it("is owed for existing_customer, personal and an untyped caller with a reason", () => {
    for (const callerType of ["existing_customer", "personal", null]) expect(owed({ callerType })).toBe(true);
  });
  it("is owed with a take_message report and no reason", () => {
    expect(owed({ reasonGiven: false, takeIntent: true })).toBe(true);
  });
  it("is not owed with neither a reason nor a take_message report", () => {
    expect(owed({ reasonGiven: false })).toBe(false);
  });
  it("is not owed after a save, a stash, outbound, healthcare, or missing ids", () => {
    expect(owed({ messagesRecorded: 1 })).toBe(false);
    expect(owed({ hasPendingWrite: true })).toBe(false);
    expect(owed({ outbound: true })).toBe(false);
    expect(owed({ healthcare: true })).toBe(false);
    expect(owed({ hasBusiness: false })).toBe(false);
    expect(owed({ hasCallRow: false })).toBe(false);
  });
  it("is not owed when an appointment tool was attempted, but is when only message tools were", () => {
    expect(owed({ toolsAttempted: ["cancel_appointment"] })).toBe(false);
    expect(owed({ toolsAttempted: new Set(["record_customer_request", "cancel_appointment"]) })).toBe(false);
    expect(owed({ toolsAttempted: ["record_customer_request", "record_quote_request"] })).toBe(true);
  });
  it("is not owed after a transfer", () => {
    expect(owed({ transferStarted: true })).toBe(false);
  });
  it("is not owed when the caller never said a word", () => {
    expect(owed({ utterances: [] })).toBe(false);
    expect(owed({ utterances: ["", "  ", "A", "..."] })).toBe(false);
  });
  it("is not owed for a wrong number", () => {
    expect(owed({ callerType: "wrong_number", takeIntent: true })).toBe(false);
  });
  it("is not owed when the last worded utterance declines", () => {
    expect(owed({ utterances: ["I want a website", "Never mind. I'm done."] })).toBe(false);
    // A decline earlier on, answered later, does not count.
    expect(owed({ utterances: ["Never mind", "Actually yes, tell him I called."] })).toBe(true);
  });
  it("a closing 'No, that's all, thanks' is not a decline", () => {
    expect(owed({ utterances: ["I want a website", "No, that's all, thanks."] })).toBe(true);
  });
  it("sellers need the business's own seller rule AND a take_message report", () => {
    for (const callerType of ["supplier", "sales_pitch"]) {
      expect(owed({ callerType, takeIntent: true, sellerRule: false })).toBe(false);
      expect(owed({ callerType, takeIntent: false, sellerRule: true })).toBe(false);
      expect(owed({ callerType, takeIntent: true, sellerRule: true })).toBe(true);
    }
  });
  it("type other needs a take_message report; a reason alone is nothing", () => {
    expect(owed({ callerType: "other", reasonGiven: true, takeIntent: false })).toBe(false);
    expect(owed({ callerType: "other", takeIntent: true })).toBe(true);
  });
});

describe("afterCallMessageText", () => {
  it("quotes the turns joined with a slash and says they left", () => {
    expect(afterCallMessageText({ utterances: [" Hello there ", "I need a quote"], numberReal: true })).toBe(
      'In their words: "Hello there / I need a quote". They left before the message was finished.'
    );
  });
  it("drops turns with no word in them", () => {
    const t = afterCallMessageText({ utterances: ["A", "I need a quote", "..."], numberReal: true });
    expect(t).toContain('"I need a quote"');
    expect(t).not.toContain("/");
  });
  it("adds the withheld sentence when the number is not real", () => {
    expect(afterCallMessageText({ utterances: ["Hello there"], numberReal: false })).toMatch(
      /Their number was withheld or did not come through\.$/
    );
  });
  it("caps the words at 500 characters at a word boundary with an ellipsis", () => {
    const long = Array.from({ length: 200 }, () => "wordy").join(" ");
    const t = afterCallMessageText({ utterances: [long], numberReal: true });
    const words = t.match(/In their words: "(.*)"\. They left/)[1];
    expect(words.endsWith("…")).toBe(true);
    expect(words.length).toBeLessThanOrEqual(501);
    expect(words.slice(0, -1).split(" ").every((w) => w === "wordy")).toBe(true);
  });
  it("never says 'the assistant'", () => {
    expect(afterCallMessageText({ utterances: ["Hello there"], numberReal: false })).not.toMatch(/assistant/i);
  });
});

import { describe, it, expect } from "vitest";
import { messageOwed, callerDeclined, afterCallMessageText, assistantPromised } from "../lib/voice/messageOwed.js";

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
  assistantPromised: false,
  appointmentToolCalled: false,
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
      expect(owed({ callerType, takeIntent: true, sellerRule: true, assistantPromised: true })).toBe(true);
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
      'In their words: "Hello there / I need a quote". No full message was left on the call.'
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
    const words = t.match(/In their words: "(.*)"\. No full message/)[1];
    expect(words.endsWith("…")).toBe(true);
    expect(words.length).toBeLessThanOrEqual(501);
    expect(words.slice(0, -1).split(" ").every((w) => w === "wordy")).toBe(true);
  });
  it("never says 'the assistant'", () => {
    expect(afterCallMessageText({ utterances: ["Hello there"], numberReal: false })).not.toMatch(/assistant/i);
  });
});

describe("B20: a seller is owed only when the assistant promised to pass it on", () => {
  it("needs the promise as well as the rule and the take_message report", () => {
    const seller = { callerType: "sales_pitch", takeIntent: true, sellerRule: true };
    expect(owed({ ...seller, assistantPromised: false })).toBe(false);
    expect(owed({ ...seller, assistantPromised: true })).toBe(true);
  });
  it.each([
    "Thanks for the information, Mateo. I'll make sure to pass your message regarding SEO services on to Ilija. Is there anything else you'd like to add?",
    "I'll let Ilija know you called.",
    "I'll pass that on to the team.",
    "I've noted your details and he will get back to you.",
    "I'll make sure he gets your message.",
  ])("promise: %j", (t) => expect(assistantPromised(t)).toBe(true));
  it.each([
    "I'm sorry, I cannot take messages regarding sales offers, so I will need to end the call now.",
    "We are not interested in sales services and do not accept messages for them, so I will end the call now.",
    "I can't pass that on, sorry.",
    "I'm not able to pass messages on for sales calls.",
    "Please let me know if you would like me to take a message.",
    "Just let me know what you need and I'll help.",
    "Thank you for calling. Have a wonderful day.",
  ])("not a promise: %j", (t) => expect(assistantPromised(t)).toBe(false));
});

describe("B19: the appointment flow's own call is not a message", () => {
  it("a lookup or availability check with no take/callback report is not owed", () => {
    expect(owed({ appointmentToolCalled: true })).toBe(false);
  });
  it("is owed once take_message was reported too", () => {
    expect(owed({ appointmentToolCalled: true, takeIntent: true })).toBe(true);
  });
});

describe("M8: filler alone is not the caller speaking", () => {
  it("Um / Uh / Hmm / Ah alone do not count and do not appear", () => {
    expect(owed({ utterances: ["Um", "Hmm.", "Ah!", "uh..."] })).toBe(false);
    const t = afterCallMessageText({ utterances: ["Um", "I need a quote", "Hmm"], numberReal: true });
    expect(t).toContain('"I need a quote"');
    expect(t).not.toMatch(/Um|Hmm/);
  });
});

describe("B24: a decline that still asks to be reached is not a decline", () => {
  it.each([
    "No need to leave a message, just have him call me back.",
    "Can you get him to call me back? Otherwise I'll call again tomorrow.",
    "If I don't hear back I'll call back later, okay? Bye.",
    "Don't worry about the message, just tell him Sam called and to ring me.",
  ])("%j", (t) => expect(callerDeclined(t)).toBe(false));
});

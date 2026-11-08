// ---------------------------------------------------------------------------
// LVX189 / LVX169: one ask per need, counted in code.
//
// The owner heard the same contact-number question on seven consecutive turns
// of one call, each tacked onto an answer to a question the caller had asked
// instead, and the name-spelling question four times in seventy seconds on
// another. Seven prompt rules already said "one question at a time" and "never
// ask it again"; a cap written in a prompt is a request (memory: prompt caps
// need counters). This is the counter. The cutter in lib/voice/live/index.js
// reads it per output fragment.
//
// Every line below is the brief's own example or invented for this file. Real
// call lines (call-corpus/) were used to settle the regexes and the q:
// threshold and are never copied here (LVX24).
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import {
  asksIn,
  createAskLedger,
  callerDeclined,
  callerWantsRepeat,
  askKindLabel,
  ASK_SIMILARITY,
  MAX_ASKS_PER_NEED,
} from "../lib/voice/askLedger.js";

describe("createAskLedger -- the brief's cases, verbatim", () => {
  it("counts asks per need and cuts a repeat after a question, a decline or two asks", () => {
    const l = createAskLedger({ maxAsks: 2 });
    l.recordReply("What's the best contact number to reach you on?", { callerSpoke: true });
    expect(l.repeatIn("And what's the best number to reach you?", { callerAsked: true })).toBe("number");
    expect(l.repeatIn("And what's the best number to reach you?", { callerDeclined: true })).toBe("number");
    expect(l.repeatIn("And what's the best number to reach you?", {})).toBeNull(); // second ask allowed
    l.recordReply("What's the best number?", { callerSpoke: true });
    expect(l.repeatIn("Could I take a contact number?", {})).toBe("number"); // cap reached
    expect(l.repeatIn("What's the best number?", { callerWantsRepeat: true })).toBeNull();
    // a lead question from config, with nothing naming it in code:
    l.recordReply("What industry are you in?", { callerSpoke: true });
    expect(l.repeatIn("So what industry are you in?", { callerDeclined: true })).toMatch(/^q:/);
    // silence does not count as an ask answered:
    const s = createAskLedger({ maxAsks: 2 });
    s.recordReply("What's the best number?", { callerSpoke: false });
    expect(s.repeatIn("What's the best number?", {})).toBeNull();
  });
});

describe("createAskLedger -- the edges the brief's cases do not reach", () => {
  it("defaults to two asks per need", () => {
    expect(MAX_ASKS_PER_NEED).toBe(2);
    const l = createAskLedger();
    l.recordReply("Could I take your name?", { callerSpoke: true });
    expect(l.repeatIn("May I have your name, please?", {})).toBeNull();
    l.recordReply("May I have your name, please?", { callerSpoke: true });
    expect(l.repeatIn("And your name was?", {})).toBe("name");
  });

  it("silence never counts, however many times the same ask meets it", () => {
    const l = createAskLedger({ maxAsks: 2 });
    for (let i = 0; i < 4; i += 1) l.recordReply("What's the best number to reach you on?", { callerSpoke: false });
    expect(l.repeatIn("What's the best number to reach you on?", {})).toBeNull();
    expect(l.repeatIn("What's the best number to reach you on?", { callerAsked: true })).toBeNull();
  });

  it("a caller's question cuts only the ask they were answering, not a different one", () => {
    // Name asked, answered; number asked; the caller answers the NUMBER ask
    // with a question. A name ask now is the model checking a name it did not
    // catch, not a deflection of the caller's question, so it is allowed.
    const l = createAskLedger({ maxAsks: 2 });
    l.recordReply("Could I take your name?", { callerSpoke: true });
    l.recordReply("Thanks, and what's the best number to reach you on?", { callerSpoke: true });
    expect(l.repeatIn("Sure. Could I take your name again?", { callerAsked: true })).toBeNull();
    expect(l.repeatIn("Sure. And the best number to reach you on?", { callerAsked: true })).toBe("number");
  });

  it("a caller asking for a repeat is never cut, even at the cap", () => {
    const l = createAskLedger({ maxAsks: 2 });
    l.recordReply("Could you spell your surname for me?", { callerSpoke: true });
    l.recordReply("Could you spell your surname for me?", { callerSpoke: true });
    expect(l.repeatIn("Could you spell your surname for me?", {})).toBe("spelling");
    expect(
      l.repeatIn("Could you spell your surname for me?", { callerWantsRepeat: true, callerAsked: true })
    ).toBeNull();
  });

  it("the seven-asks shape: every re-ask after the caller's question is a repeat", () => {
    // Invented lines in the shape of LVX189: the same contact-number ask on
    // consecutive turns, each answering a caller question first.
    const l = createAskLedger({ maxAsks: 2 });
    l.recordReply("Happy to help. What's the best contact number for you?", { callerSpoke: true });
    let repeats = 0;
    for (let i = 0; i < 6; i += 1) {
      const reply = `Good question, the team can explain. What's the best contact number for you?`;
      if (l.repeatIn(reply, { callerAsked: true })) repeats += 1;
      l.recordReply(reply, { callerSpoke: true });
    }
    expect(repeats).toBe(6);
  });

  it("an ask that was cut is the one being answered, but not an ask heard again", () => {
    // Review fix round 1, I1: the cutter passes the need it cut. It joins
    // what the caller is answering (a further deflection is still cut) and
    // adds nothing to the need's count (a plain answer leaves the second ask).
    const l = createAskLedger({ maxAsks: 2 });
    l.recordReply("What's the best number to reach you on?", { callerSpoke: true });
    l.recordReply("Sure. What's the best number to reach you on?", { callerSpoke: true, cut: "number" });
    expect(l.repeatIn("And the best number to reach you on?", { callerAsked: true })).toBe("number");
    expect(l.repeatIn("And the best number to reach you on?", {})).toBeNull();
  });

  it("an empty or missing reply records nothing", () => {
    const l = createAskLedger({ maxAsks: 2 });
    l.recordReply("", { callerSpoke: true });
    l.recordReply(undefined, { callerSpoke: true });
    expect(l.repeatIn("What's the best number?", { callerAsked: true })).toBeNull();
    expect(l.repeatIn("", { callerAsked: true })).toBeNull();
  });
});

describe("createAskLedger -- a decline holds for the whole call, the caller can lift it", () => {
  const NUMBER = "What's the best number to reach you on?";
  const EMAIL = "Could I take an email address for you?";
  // The caller declines the ask just recorded, as the Live layer does at turn close.
  function declineAfter(l, reply, said = "I'd rather not say.") {
    l.recordReply(reply, { callerSpoke: true });
    l.recordCallerTurn(said);
  }

  it("a decline, an unrelated answered turn, then the same ask: cut", () => {
    const l = createAskLedger();
    declineAfter(l, NUMBER);
    l.recordReply("No problem. Our team is open on weekdays, anything else?", { callerSpoke: true });
    l.recordCallerTurn("Okay, thanks for that.");
    expect(l.repeatIn(`Right. ${NUMBER}`, { callerWords: "Okay, thanks for that." })).toBe("number");
    // Transcript not landed yet: Task 13's per-turn rules decide, nothing is cut.
    expect(l.repeatIn(`Right. ${NUMBER}`, {})).toBeNull();
  });

  it("a declined q: lead question stays blocked against a near-verbatim restatement", () => {
    const l = createAskLedger();
    declineAfter(l, "What colour is your van?");
    l.recordReply("Understood.", { callerSpoke: true });
    l.recordCallerTurn("Fine.");
    expect(l.repeatIn("So what colour is your van?", { callerWords: "Fine." })).toMatch(/^q:/);
  });

  it("a caller asking to hear it again is not cut after a decline", () => {
    const l = createAskLedger();
    declineAfter(l, NUMBER);
    l.recordReply("Okay.", { callerSpoke: true });
    expect(l.repeatIn(NUMBER, { callerWantsRepeat: true })).toBeNull();
  });

  it("a refusal does not lift itself; a later 'take my email' does", () => {
    const l = createAskLedger();
    declineAfter(l, EMAIL, "I'd rather not give my email.");
    expect(l.isDeclined("email")).toBe(true);
    l.recordReply("Fine.", { callerSpoke: true });
    expect(l.repeatIn(EMAIL, { callerWords: "Hm, okay." })).toBe("email");
    l.recordCallerTurn("Actually, you can take my email.");
    expect(l.isDeclined("email")).toBe(false);
    expect(l.repeatIn(EMAIL, {})).toBeNull();
  });

  it("the reply to the turn that raises it again is not cut (before the turn closes)", () => {
    const l = createAskLedger();
    declineAfter(l, EMAIL, "I'd rather not give my email.");
    l.recordReply("Fine.", { callerSpoke: true });
    expect(l.repeatIn(EMAIL, { callerWords: "Actually, you can take my email." })).toBeNull();
    // ...but a refusal naming the email in this very turn lifts nothing.
    expect(
      l.repeatIn(EMAIL, { callerWords: "I'd rather not give my email.", callerDeclined: true })
    ).toBe("email");
  });

  it("a later turn about an unrelated thing does not lift", () => {
    const l = createAskLedger();
    declineAfter(l, NUMBER);
    l.recordReply("Okay.", { callerSpoke: true });
    l.recordCallerTurn("What are your opening hours, and do you have a name for the plan?");
    expect(l.isDeclined("number")).toBe(true);
    l.recordCallerTurn("Which plans do you offer?");
    expect(l.repeatIn(NUMBER, { callerWords: "Which plans do you offer?" })).toBe("number");
  });

  it("asking for the business's own detail is not offering ours: nothing lifts", () => {
    const num = createAskLedger();
    declineAfter(num, NUMBER);
    num.recordCallerTurn("What's your phone number then? I'll ring you.");
    expect(num.isDeclined("number")).toBe(true);
    expect(num.repeatIn(NUMBER, { callerWords: "What's your phone number then? I'll ring you." })).toBe("number");

    const nm = createAskLedger();
    declineAfter(nm, "Could I take your name?");
    nm.recordCallerTurn("Well, what's your name?");
    expect(nm.isDeclined("name")).toBe(true);

    const em = createAskLedger();
    declineAfter(em, EMAIL);
    em.recordCallerTurn("Do you have an email I can send it to?");
    expect(em.isDeclined("email")).toBe(true);
  });

  it("a caller's own offer lifts and is not cut even at the cap, then the cap applies again", () => {
    const l = createAskLedger({ maxAsks: 2 });
    l.recordReply(NUMBER, { callerSpoke: true });
    l.recordReply(NUMBER, { callerSpoke: true });
    l.recordCallerTurn("I'd rather not say.");
    expect(l.repeatIn(NUMBER, { callerWords: "Okay." })).toBe("number");
    const offer = "Actually, call me on my mobile.";
    expect(l.repeatIn(NUMBER, { callerWords: offer })).toBeNull();
    l.recordCallerTurn(offer);
    expect(l.isDeclined("number")).toBe(false);
    expect(l.repeatIn(NUMBER, { callerWords: "Mm." })).toBe("number"); // cap again
  });

  it("a q: need lifts when the caller speaks as themselves with a shared content word", () => {
    const l = createAskLedger();
    declineAfter(l, "What colour is your van?");
    l.recordCallerTurn("What colour are vans usually?");
    expect(l.isDeclined("q:colour van")).toBe(true);
    l.recordCallerTurn("Well, my van is a red one actually.");
    expect(l.repeatIn("So what colour is your van?", { callerWords: "Well, my van is red." })).toBeNull();
    expect(l.isDeclined("q:colour van")).toBe(false);
  });

  it("a bare no is not a decline: nothing sticks", () => {
    const l = createAskLedger();
    l.recordReply(NUMBER, { callerSpoke: true });
    l.recordCallerTurn("No.");
    expect(l.isDeclined("number")).toBe(false);
    expect(l.repeatIn(NUMBER, {})).toBeNull();
  });

  it("assistant text never declines or lifts: only the caller's words do", () => {
    const l = createAskLedger();
    l.recordReply("I'd rather not ask, but what's your number?", { callerSpoke: true });
    expect(l.isDeclined("number")).toBe(false);
    // A decline, then assistant replies full of lifting words and offers.
    declineAfter(l, NUMBER);
    l.recordReply("Of course, take your time. I can call you on your phone number or mobile.", { callerSpoke: true });
    expect(l.isDeclined("number")).toBe(true);
    // The reply being spoken carries "my number" etc. but supplies no caller words.
    expect(l.repeatIn(`I'll take my number note. ${NUMBER}`, { callerWords: "Okay." })).toBe("number");
  });
});

describe("asksIn -- which needs a reply asks for", () => {
  it("names the four fixed kinds", () => {
    expect(asksIn("What's the best contact number to reach you on?")).toEqual(["number"]);
    expect(asksIn("Is the number you're calling from the best one?")).toEqual(["number"]);
    expect(asksIn("Could I take your full name?")).toEqual(["name"]);
    expect(asksIn("Who am I speaking with?")).toEqual(["name"]);
    expect(asksIn("Could you spell your surname for me?")).toEqual(["spelling"]);
    expect(asksIn("And what's your email address?")).toEqual(["email"]);
    expect(asksIn("Can I take your name and the best number to reach you on?")).toEqual(["name", "number"]);
  });

  it("a spelling ask is not also a name ask", () => {
    expect(asksIn("Could you spell your full name for me?")).toEqual(["spelling"]);
  });

  it("only question sentences ask", () => {
    expect(asksIn("I'll pass your number to the team.")).toEqual([]);
    expect(asksIn("We use the number you're calling from. What's the reason for the call?")).toEqual([
      "q:reason call",
    ]);
  });

  it("a read-back summary or 'is that right?' is not a number ask", () => {
    expect(asksIn("So that's Jon, D-O-E, on 2 1 4, 5 5 5, 0 1 2 3 about the invoice -- passing that on now.")).toEqual(
      []
    );
    expect(asksIn("So that's 07700 900123, is that the best number?")).toEqual([]);
    expect(asksIn("That's four one five, five five five, two six seven one, is that the right number?")).toEqual([]);
    expect(asksIn("That's J, O, N, is that right?")).toEqual([]);
    expect(asksIn("Is that right?")).toEqual([]);
    expect(asksIn("Is that the best number to reach you on?")).toEqual([]);
    expect(asksIn("And that's jon at example dot com?")).toEqual([]);
  });

  it("the greeting, the closing question and an on-file name check ask for nothing", () => {
    expect(
      asksIn("Thanks for calling Digile Media. You are through to our AI receptionist. How can I help you today?")
    ).toEqual([]);
    expect(asksIn("Is there anything else I can help you with today?")).toEqual([]);
    expect(asksIn("Am I speaking with Jonathan?")).toEqual([]);
  });

  it("offers, confirmations, choices and scheduling questions are not q: asks", () => {
    // Each is re-asked with new content by design: new times, a new action.
    expect(asksIn("Would you like me to take a message?")).toEqual([]);
    expect(asksIn("Shall I go ahead with that?")).toEqual([]);
    expect(asksIn("Which of those works best for you?")).toEqual([]);
    expect(asksIn("What day would suit you for the visit?")).toEqual([]);
    expect(asksIn("Would you prefer the morning or the afternoon?")).toEqual([]);
  });

  it("any other information question of three words or more is a q: ask, keyed by its content words", () => {
    expect(asksIn("What industry are you in?")).toEqual(["q:industry"]);
    expect(asksIn("So what industry are you in?")).toEqual(["q:industry"]);
    expect(asksIn("How did you hear about us?")).toEqual(["q:hear"]);
    expect(asksIn("Roughly what's your monthly marketing budget?")).toEqual(["q:roughly monthly marketing budget"]);
    expect(asksIn("Okay?")).toEqual([]);
    expect(asksIn("Sorry?")).toEqual([]);
  });

  it("is safe on anything", () => {
    expect(asksIn("")).toEqual([]);
    expect(asksIn(null)).toEqual([]);
    expect(asksIn(42)).toEqual([]);
  });
});

describe("q: asks -- the same need, matched by content words", () => {
  it(`a near-verbatim lead question is the same need (Jaccard >= ${ASK_SIMILARITY})`, () => {
    expect(ASK_SIMILARITY).toBe(0.6);
    const l = createAskLedger({ maxAsks: 2 });
    l.recordReply("What does your firm specialise in?", { callerSpoke: true });
    expect(l.repeatIn("And what does your firm mainly specialise in?", { callerAsked: true })).toMatch(/^q:/);
  });

  it("two different lead questions that share a word are different needs", () => {
    // Half the content words shared is the highest any two DIFFERENT lead
    // questions reached on the corpus; the threshold sits above it.
    const l = createAskLedger({ maxAsks: 2 });
    l.recordReply("Which firm are you with?", { callerSpoke: true });
    l.recordReply("Which firm are you with?", { callerSpoke: true });
    expect(l.repeatIn("What does your firm sell?", {})).toBeNull();
    expect(l.repeatIn("Sorry, which firm are you with again?", {})).toMatch(/^q:/);
  });
});

describe("the caller's side", () => {
  it("callerDeclined: an explicit refusal, never a bare no", () => {
    expect(callerDeclined("I'd rather not say.")).toBe(true);
    expect(callerDeclined("I don't want to give that out.")).toBe(true);
    expect(callerDeclined("I already gave you my number.")).toBe(true);
    expect(callerDeclined("Didn't you just ask me that?")).toBe(true);
    expect(callerDeclined("You already have it.")).toBe(true);
    expect(callerDeclined("No.")).toBe(false);
    expect(callerDeclined("No, use my mobile instead.")).toBe(false);
    expect(callerDeclined("Do I already have an appointment?")).toBe(false);
    expect(callerDeclined("")).toBe(false);
    expect(callerDeclined(null)).toBe(false);
  });

  it("callerWantsRepeat: a request to hear it again, or a caller who did not follow", () => {
    expect(callerWantsRepeat("Sorry, could you say that again?")).toBe(true);
    expect(callerWantsRepeat("Can you repeat that?")).toBe(true);
    expect(callerWantsRepeat("Sorry?")).toBe(true);
    expect(callerWantsRepeat("What?")).toBe(true);
    expect(callerWantsRepeat("I didn't catch that.")).toBe(true);
    expect(callerWantsRepeat("Sorry, English please.")).toBe(true);
    expect(callerWantsRepeat("No entiendo.")).toBe(true);
    expect(callerWantsRepeat("What are you talking about?")).toBe(false);
    expect(callerWantsRepeat("Why do you need my number?")).toBe(false);
    expect(callerWantsRepeat("")).toBe(false);
    expect(callerWantsRepeat(undefined)).toBe(false);
  });
});

describe("askKindLabel -- what a log may carry", () => {
  it("is a closed list: a q: key becomes 'question', never its words", () => {
    expect(askKindLabel("number")).toBe("number");
    expect(askKindLabel("name")).toBe("name");
    expect(askKindLabel("spelling")).toBe("spelling");
    expect(askKindLabel("email")).toBe("email");
    expect(askKindLabel("q:monthly marketing budget")).toBe("question");
    expect(askKindLabel("anything else")).toBe("question");
  });
});

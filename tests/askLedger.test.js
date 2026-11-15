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
  REASON_ASK_RE,
  readsContactBack,
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
    expect(l.repeatIn("Could you spell your surname for me?", {})).toBe("spelling:name");
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

  it("non-offers never lift: slot acceptance, other nouns, negated contact requests", () => {
    const phrases = [
      ["number", "I'll take that one."],
      ["number", "Yes, I'll take it."],
      ["number", "Can you take my booking?"],
      ["number", "Here's my question for you."],
      ["number", "Please don't call me."],
      ["number", "No need to ring me back."],
      ["number", "Don't call me on that."],
      ["number", "I will not give you my number, ever."],
      ["email", "Don't email me."],
      ["email", "Never use my email at all."],
    ];
    for (const [kind, said] of phrases) {
      const l = createAskLedger();
      declineAfter(l, kind === "email" ? EMAIL : NUMBER);
      l.recordCallerTurn(said);
      expect(l.isDeclined(kind), said).toBe(true);
      expect(l.repeatIn(kind === "email" ? EMAIL : NUMBER, { callerWords: said }), said).toBe(kind);
    }
  });

  it("a distant negation does not cancel an offer; a withheld detail is not an offer", () => {
    const lifts = [
      "Actually I don't mind you can take my number.",
      "I don't mind, you can take my number.",
      "I don't mind but you can take my number",
    ];
    for (const said of lifts) {
      const l = createAskLedger();
      declineAfter(l, NUMBER);
      l.recordCallerTurn(said);
      expect(l.isDeclined("number"), said).toBe(false);
    }
    const stays = [
      ["number", NUMBER, "My number is private."],
      ["email", EMAIL, "My email is personal."],
      ["number", NUMBER, "Please don't call me."],
      ["number", NUMBER, "No need to ring me back."],
    ];
    for (const [kind, ask, said] of stays) {
      const l = createAskLedger();
      declineAfter(l, ask);
      l.recordCallerTurn(said);
      expect(l.isDeclined(kind), said).toBe(true);
    }
  });

  it("explicit offers lift", () => {
    const phrases = [
      ["number", NUMBER, "Actually, you can take my number."],
      ["number", NUMBER, "My mobile number is fine to use."],
      ["number", NUMBER, "Call me on this one."],
      ["number", NUMBER, "Here's my number."],
      ["email", EMAIL, "My email is fine, go ahead."],
      ["email", EMAIL, "Let me give you my email."],
      ["email", EMAIL, "You can use my email."],
    ];
    for (const [kind, ask, said] of phrases) {
      const l = createAskLedger();
      declineAfter(l, ask);
      l.recordCallerTurn(said);
      expect(l.isDeclined(kind), said).toBe(false);
    }
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

  // Final review M5: the decline is credited to what the caller said no to, not
  // only to the reply they were answering.
  it("a decline that names a fixed kind blocks that kind as well as the ask it answered", () => {
    const l = createAskLedger();
    const said = "I don't want to give my email, by the way. It's Rowe Garden Studio.";
    declineAfter(l, "What's the name of your company?", said);
    expect(l.isDeclined("email")).toBe(true);
    expect(l.isDeclined("q:name company")).toBe(true);
    l.recordReply("Thanks. And what does the studio do?", { callerSpoke: true });
    l.recordCallerTurn("Garden design.");
    expect(l.repeatIn("Lovely. And what's your email address?", { callerWords: "Garden design." })).toBe("email");
  });

  // Follow-up R65 (re-review N-1): an unpunctuated refusal clause can also OFFER
  // a second detail. The offered one is invited, not blocked (R56-R58).
  it("a refusal that also offers a detail in the same clause blocks only the refused one", () => {
    for (const said of [
      "I'd rather not give my email just call me on my mobile",
      "I don't want to give my email just use my phone number",
    ]) {
      const l = createAskLedger();
      declineAfter(l, "And what's your email address?", said);
      expect(l.isDeclined("email"), said).toBe(true);
      expect(l.isDeclined("number"), said).toBe(false);
      l.recordReply("Is the number you're calling from the best one to reach you on?", { callerSpoke: true });
      l.recordCallerTurn("yes that's fine");
      expect(l.repeatIn("Sorry, what's the best number to reach you on?", { callerWords: "yes that's fine" }), said).toBeNull();
    }
    // A refusal to SPELL is checked against an offer to spell, not an offer of
    // the detail: "take my name as it is" offers the name, not its spelling.
    const l = createAskLedger();
    declineAfter(l, "What's your email?", "I'd rather not spell my name just take my name as it is");
    expect(l.isDeclined("spelling:name")).toBe(true);
  });

  it("a kind named outside the declining clause is not blocked", () => {
    const l = createAskLedger();
    declineAfter(l, EMAIL, "I'd rather not give my email, but my number is fine.");
    expect(l.isDeclined("email")).toBe(true);
    expect(l.isDeclined("number")).toBe(false);
  });

  // Final review M6: a contraction is not a content word, so it cannot lift a
  // declined q: need on its own.
  it("contractions do not lift a declined lead question", () => {
    const l = createAskLedger();
    declineAfter(l, "What's the main challenge you're facing?");
    expect(l.isDeclined("q:main challenge facing")).toBe(true);
    const said = "I'm not sure what you're asking me.";
    l.recordCallerTurn(said);
    expect(l.isDeclined("q:main challenge facing")).toBe(true);
    expect(l.repeatIn("So what's the main challenge you're facing?", { callerWords: said })).toBe("q:main challenge facing");
  });
});

// Final review I-2: every spelling was one need, so declining the name spelling
// blocked the email spelling for the whole call, and the name spelled twice
// left the email no spelling at all under the two-ask cap.
describe("createAskLedger -- a spelling ask is one need per thing spelled (final review I-2)", () => {
  it("scenario A: the name spelling declined, the email spelling later is not cut", () => {
    const l = createAskLedger();
    l.recordReply("Could you spell your first name and surname?", { callerSpoke: true });
    l.recordCallerTurn("I'd rather not, it's spelled how it sounds.");
    expect(l.isDeclined("spelling:name")).toBe(true);
    l.recordReply("No problem. What's your email?", { callerSpoke: true });
    const said = "anita at rowe dot com";
    l.recordCallerTurn(said);
    expect(l.repeatIn("Thanks, could you spell the email for me?", { callerWords: said })).toBeNull();
    // A bare "spell that" after the email ask is the email's spelling too.
    expect(l.repeatIn("Thanks, could you spell that for me?", { callerWords: said })).toBeNull();
  });

  it("a name-spelling decline still blocks the next name-spelling ask", () => {
    const l = createAskLedger();
    l.recordReply("Could you spell your first name and surname?", { callerSpoke: true });
    l.recordCallerTurn("I'd rather not.");
    l.recordReply("No problem. What's your email?", { callerSpoke: true });
    l.recordCallerTurn("anita at rowe dot com");
    expect(l.repeatIn("And could you spell your surname?", { callerWords: "anita at rowe dot com" })).toBe("spelling:name");
  });

  it("scenario B: name spelled, email spelled, one email re-spell is not cut by the cap", () => {
    const l = createAskLedger({ maxAsks: 2 });
    l.recordReply("Could you spell your surname for me?", { callerSpoke: true });
    l.recordCallerTurn("R O W E");
    l.recordReply("Thanks. And could you spell your email for me?", { callerSpoke: true });
    const said = "a n i t a at rowe dot com";
    l.recordCallerTurn(said);
    expect(l.repeatIn("Sorry, could you spell the email once more?", { callerWords: said })).toBeNull();
    l.recordReply("Sorry, could you spell the email once more?", { callerSpoke: true });
    l.recordCallerTurn(said);
    // The email's third spelling ask is its cap; the name has had one.
    expect(l.repeatIn("Could you spell the email one more time?", { callerWords: said })).toBe("spelling:email");
    expect(l.repeatIn("Could you spell your surname again?", { callerWords: said })).toBeNull();
  });

  it("an offer to spell the email lifts the email spelling only", () => {
    const l = createAskLedger();
    l.recordReply("Could you spell your surname for me?", { callerSpoke: true });
    l.recordCallerTurn("I'd rather not.");
    l.recordReply("Could you spell your email for me?", { callerSpoke: true });
    l.recordCallerTurn("I'd rather not.");
    expect(l.isDeclined("spelling:name")).toBe(true);
    expect(l.isDeclined("spelling:email")).toBe(true);
    l.recordCallerTurn("Actually, I'll spell my email for you.");
    expect(l.isDeclined("spelling:email")).toBe(false);
    expect(l.isDeclined("spelling:name")).toBe(true);
  });

  it("a bare 'I'll spell it' lifts the spelling of what the caller was last asked", () => {
    const named = createAskLedger();
    named.recordReply("Could you spell your surname for me?", { callerSpoke: true });
    named.recordCallerTurn("I'd rather not.");
    named.recordReply("No problem at all.", { callerSpoke: true });
    named.recordCallerTurn("Oh go on then, I'll spell it.");
    expect(named.isDeclined("spelling:name")).toBe(false);

    const other = createAskLedger();
    other.recordReply("Could you spell your surname for me?", { callerSpoke: true });
    other.recordCallerTurn("I'd rather not.");
    other.recordReply("No problem. What's your email?", { callerSpoke: true });
    other.recordCallerTurn("It's anita at rowe dot com, I'll spell it if you like.");
    // "it" is the email they were just asked for, not the name they declined.
    expect(other.isDeclined("spelling:name")).toBe(true);
  });
});

describe("asksIn -- which needs a reply asks for", () => {
  it("names the four fixed kinds", () => {
    expect(asksIn("What's the best contact number to reach you on?")).toEqual(["number"]);
    expect(asksIn("Is the number you're calling from the best one?")).toEqual(["number"]);
    expect(asksIn("Could I take your full name?")).toEqual(["name"]);
    expect(asksIn("Who am I speaking with?")).toEqual(["name"]);
    expect(asksIn("Could you spell your surname for me?")).toEqual(["spelling:name"]);
    expect(asksIn("And what's your email address?")).toEqual(["email"]);
    expect(asksIn("Can I take your name and the best number to reach you on?")).toEqual(["name", "number"]);
  });

  it("a spelling ask is not also a name ask", () => {
    expect(asksIn("Could you spell your full name for me?")).toEqual(["spelling:name"]);
  });

  it("a spelling ask is keyed by what is spelled (final review I-2)", () => {
    expect(asksIn("Could you spell your first name and surname?")).toEqual(["spelling:name"]);
    expect(asksIn("Thanks, could you spell the email for me?")).toEqual(["spelling:email"]);
    expect(asksIn("Could you spell your email address, letter by letter?")).toEqual(["spelling:email"]);
    expect(asksIn("Could you spell that for me?")).toEqual(["spelling:other"]);
    expect(asksIn("And could you spell the company name?")).toEqual(["spelling:other"]);
  });

  it("only question sentences ask", () => {
    expect(asksIn("I'll pass your number to the team.")).toEqual([]);
    // The reason for the call is a fixed kind now (it used to fall to q:).
    expect(asksIn("We use the number you're calling from. What's the reason for the call?")).toEqual(["reason"]);
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
    expect(askKindLabel("spelling:name")).toBe("spelling");
    expect(askKindLabel("spelling:email")).toBe("spelling");
    expect(askKindLabel("spelling:other")).toBe("spelling");
    expect(askKindLabel("email")).toBe("email");
    expect(askKindLabel("q:monthly marketing budget")).toBe("question");
    expect(askKindLabel("anything else")).toBe("question");
  });
});

// ---------------------------------------------------------------------------
// Ilija inbound Task N fix round 2 (ruling R71): the post-call message net asks
// whether a turn READ CONTACT DETAILS BACK, not whether it mentions a digit. A
// declined offer ("We open at 9 tomorrow. Would you like to leave a message?")
// must not look like a read-back. The rule was prototyped on five production
// calls plus synthetic offers; the sentences here are invented or the brief's.
// ---------------------------------------------------------------------------
describe("readsContactBack", () => {
  const POS = [
    "So that's Ellie, Hughes, H-U-G-H-E-S, on 4 6 9, 9 3 3, 8 8 8 7 about marketing for your salon, and Ilija will get back to you as soon as he can.",
    "So that's Priya on oh seven seven zero zero nine one two three four five, is that right?",
    "The number you provided is 469, 933, 8878.",
    "Your email is tom at example dot com.",
    "Is it tom@example.com?",
    "Just to confirm, the number is 07700 900123.",
  ];
  const NEG = [
    "We open at 9 tomorrow. Would you like to leave a message?",
    "Our hours are Monday to Friday, 9am to 5pm UK time. Can I take a message?",
    "Thursday at 2 p.m.",
    "Wednesday at 11 a.m. works.",
    "That would be 750 dollars.",
    // Digits scattered across a turn are not a number read out (round 3).
    "We're open 8:30 to 5:30 weekdays and 9 to 12 on Saturdays, would you like to leave a message?",
    "Projects usually run from 1,500 to 2,500, would you like me to take a message?",
    "Your number ends in 7, is that right?",
    "If this is an emergency, please call 999.",
    "I can take a message for Ilija. What's your name?",
    "Sorry, I didn't catch that, could you say it again?",
    "",
    undefined,
  ];
  it.each(POS)("reads back: %s", (s) => expect(readsContactBack(s)).toBe(true));
  it.each(NEG)("does not: %s", (s) => expect(readsContactBack(s)).toBe(false));
});

// ---------------------------------------------------------------------------
// Caller-experience Task 5: the reason for the call is a fixed kind.
// ---------------------------------------------------------------------------
describe("the reason kind", () => {
  const POSITIVE = [
    "What is the call regarding?",
    "What's this regarding?",
    "What is your call regarding today?",
    "What is the reason for your call?",
    "What is the main reason for your call today?",
    "What are you calling about?",
    "What's it about?",
    "Could you please let me know what you called about today so I can help you?",
    "¿De qué se trata la llamada?",
    "¿Cuál es el motivo de su llamada?",
  ];
  const NEGATIVE = [
    "Is that about the boiler?",
    "What time suits you?",
    "What's the name of your business?",
    "So that's about the boiler, right?",
    "So that's about Saturday, right?",
    "Is the number you're calling from the best one to reach you on?",
    "What's the best number to reach you?",
    "What are you called?",
    "How can we help you with your ads today?",
    "Is there anything else I can help you with?",
    "¿Cuál es su nombre?",
    "¿A qué hora le viene bien?",
    "¿Quiere dejar un mensaje?",
  ];
  it.each(POSITIVE)("classifies as reason: %s", (s) => {
    expect(REASON_ASK_RE.test(s)).toBe(true);
    expect(asksIn(s)).toEqual(["reason"]);
  });
  it.each(NEGATIVE)("is not a reason: %s", (s) => {
    expect(asksIn(s)).not.toContain("reason");
  });
  it("is found even when the sentence also says today (the scheduling skip does not hide it)", () => {
    expect(asksIn("What is the reason for your call today?")).toEqual(["reason"]);
  });
  it("is a closed label in logs", () => {
    expect(askKindLabel("reason")).toBe("reason");
  });
  it("a caller who declines it blocks it for the call, and offering it lifts the block", () => {
    const l = createAskLedger();
    l.recordReply("What is the call regarding?", { callerSpoke: true });
    l.recordCallerTurn("I'd rather not say what it's about");
    expect(l.isDeclined("reason")).toBe(true);
    expect(l.repeatIn("What's it about?", { callerWords: "hmm" })).toBe("reason");
    l.recordCallerTurn("Actually it's about a leaking tap");
    expect(l.isDeclined("reason")).toBe(false);
  });
  it("is capped like any other need: a third answered ask is a repeat", () => {
    const l = createAskLedger();
    for (let i = 0; i < 2; i += 1) l.recordReply("What is the call regarding?", { callerSpoke: true });
    expect(l.repeatIn("What is the call regarding?", { callerWords: "um" })).toBe("reason");
  });
});

describe("outbound: the reason kind is off (P25), the ledger behaves as it did before the kind existed", () => {
  it("asksIn with reasonKind false keeps the old classes", () => {
    expect(asksIn("What is the reason for your call?", { reasonKind: false })).toEqual(["q:reason call"]);
    expect(asksIn("What is the call regarding?", { reasonKind: false })).toEqual(["q:call regarding"]);
    // The scheduling skip still hides a "today" ask there, as it always did.
    expect(asksIn("What is the reason for your call today?", { reasonKind: false })).toEqual([]);
  });
  it("a ledger built with reasonKind false repeats the q: key at the cap and never the fixed kind", () => {
    const l = createAskLedger({ reasonKind: () => false });
    for (let i = 0; i < 2; i += 1) l.recordReply("What is the reason for your call?", { callerSpoke: true });
    expect(l.repeatIn("What is the reason for your call?", { callerWords: "um" })).toBe("q:reason call");
    // A different phrasing is not the same need there.
    expect(l.repeatIn("What are you calling about?", { callerWords: "um" })).toBeNull();
    // The "today" phrasing was never an ask there, so it is never a repeat.
    const t = createAskLedger({ reasonKind: () => false });
    for (let i = 0; i < 3; i += 1) t.recordReply("What is the reason for your call today?", { callerSpoke: true });
    expect(t.repeatIn("What is the reason for your call today?", { callerWords: "um" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fix wave C1 / I3b: the reason kind is judged on the final clause only, and a
// confirmation tag is not an ask. Every sentence is invented.
// ---------------------------------------------------------------------------
describe("the reason kind is a real reason ask only (fix wave C1)", () => {
  // (a) a purpose clause in front of a different ask
  const PURPOSE_CLAUSE = [
    "Happy to help. So Ilija knows what you're calling about, can I grab your name?",
    "Great, so I can let him know what you're calling about, who am I speaking with?",
    "Sure. To make sure he has what you're calling about, could I take your name?",
    "Para que Ilija sepa de qué se trata, ¿me dice su nombre?",
  ];
  // (b) a clarifying follow-up about what the caller said
  const CLARIFYING = [
    "What is it about the boiler that's not working?",
    "What was it about our Meta ads offer that caught your eye?",
    "¿De qué se trata el problema con la caldera?",
  ];
  // (c) confirmations
  const CONFIRMATIONS = [
    "So that's what you're calling about, right?",
    "¿Y el motivo de la llamada es la factura, verdad?",
    "So what you're calling about is the boiler, is that right?",
  ];
  it.each([...PURPOSE_CLAUSE, ...CLARIFYING, ...CONFIRMATIONS])("is not a reason ask: %s", (s) => {
    expect(asksIn(s)).not.toContain("reason");
  });
  it("a purpose clause in front of a name ask still asks for the name", () => {
    expect(asksIn(PURPOSE_CLAUSE[0])).toEqual(["name"]);
    expect(asksIn(PURPOSE_CLAUSE[3])).toEqual(["name"]);
  });
  const STILL_ASKS = [
    "Thanks. What is it about?",
    "Okay, and what's this regarding today?",
    "Got it, what is the call regarding?",
    "¡Claro! ¿De qué se trata?",
    "Thanks, what is the main reason for your call today?",
  ];
  it.each(STILL_ASKS)("a real ask after a lead-in still is one: %s", (s) => {
    expect(asksIn(s)).toEqual(["reason"]);
  });
});

describe("a confirmation tag under confirm_style each is not an ask (fix wave I3b)", () => {
  it("any kind: the saved name, number, email or a q: need confirmed with a tag", () => {
    const tagged = [
      "So your surname is Daniel, right?",
      "So the best number is on the screen, correct?",
      "So your email is on file, is that right?",
      "Entonces su nombre es Daniel, ¿verdad?",
      "So your company is the one on Main Street, right?",
    ];
    for (const s of tagged) expect(asksIn(s, { confirmTags: true })).toEqual([]);
  });
  it("under end (the default) the same sentences classify as before", () => {
    expect(asksIn("So your surname is Daniel, right?")).toEqual(["name"]);
    expect(asksIn("So your surname is Daniel, right?", { confirmTags: false })).toEqual(["name"]);
  });
  it("a real ask is still an ask under each", () => {
    expect(asksIn("What's your name, please?", { confirmTags: true })).toEqual(["name"]);
  });
  it("the ledger reads it per ask: a tagged confirmation at the cap is not a repeat under each", () => {
    const each = createAskLedger({ confirmTags: () => true });
    const end = createAskLedger({ confirmTags: () => false });
    for (const l of [each, end]) {
      for (let i = 0; i < 2; i += 1) l.recordReply("What's your name?", { callerSpoke: true });
    }
    expect(each.repeatIn("So your surname is Daniel, right?", { callerWords: "um" })).toBeNull();
    expect(end.repeatIn("So your surname is Daniel, right?", { callerWords: "um" })).toBe("name");
  });
});

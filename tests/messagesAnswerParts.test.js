/**
 * Hammersleys round 6, item 2 (round-5 call 4): the pickup "Plaistow Street"
 * had no house number or postcode, but a saved label counted as answered, so
 * nobody asked for the rest. With messages.answerParts a label stays open
 * with what it still needs until the AI's own words ask for it ONCE; then it
 * is answered whatever comes next. A named place is never asked. Pack level:
 * the real messages.execute.
 */
import { beforeEach, describe, expect, it } from "vitest";
import messages from "../capabilities/messages.js";
import { ALREADY_ASKED_NOTE } from "../lib/voice/turnText.js";
import { clearStats, getLatencyStats } from "../lib/voice/metrics.js";
import { HAMMERSLEYS_NOTES } from "./fixtures/notesQuestionsFixtures.js";

const NUMBER = "+12145550123";
const RULE = "Pickup: house_number, postcode_uk if street";
const taxi = (extra = {}) => ({
  capabilities: { messages: { notes: HAMMERSLEYS_NOTES, confirmStyle: "each", questionsFor: "customers", answerParts: [RULE], ...extra } },
});
const d = (pairs) => pairs.map(([label, answer]) => ({ label, answer }));
const GREETING = "Thanks for calling Hammersleys Taxis. How can I help?";

/** A save; `prev` is the previous save's result, whose state patch carries over. */
function save(pairs, { prev = null, said = GREETING, inTurn = "", config = taxi(), args = {} } = {}) {
  const fc = {
    id: "f",
    name: "record_customer_request",
    args: { request_type: "message", caller_name: "James Doe", message: "Taxi booking request", details: d(pairs), ...args },
  };
  const state = prev ? { messages: { ...(prev.__state || {}), ...prev.stateEffects.capabilityState.messages } } : undefined;
  return messages.execute(fc, {
    config,
    callerPhone: NUMBER,
    ...(said === null ? {} : { assistantSaidThisCall: said }),
    inTurnReplyText: inTurn,
    ...(state ? { capabilityState: state } : {}),
  }).then((r) => {
    // Carry the merged state forward the way the runner does (shallow per capability).
    r.__state = state?.messages ? { ...state.messages, ...r.stateEffects.capabilityState.messages } : r.stateEffects.capabilityState.messages;
    return r;
  });
}
const next = (r) => r.functionResponse.response.next ?? "";
const counters = () => getLatencyStats()?.turnTaking ?? {};

beforeEach(() => clearStats());

describe("a street pickup without its parts is asked for them", () => {
  it("listed as still needing a house number and a postcode", async () => {
    const r = await save([["Pickup", "Plaistow Street"]]);
    expect(next(r)).toContain("no saved answer yet: 1. Pickup (still needs: house number, postcode), 2. Destination");
    expect(r.stateEffects.questionsOpen).toBe(true);
    expect(counters().tool_reply_answer_parts_listed).toBe(1);
  });

  it("a named place (pub) is never asked: Pickup counts as answered", async () => {
    const r = await save([["Pickup", "The Greyhound, Lingfield"]]);
    expect(next(r)).not.toContain("still needs");
    expect(next(r)).toContain("no saved answer yet: 2. Destination");
  });

  it("a later save that carries the parts clears them", async () => {
    const first = await save([["Pickup", "Plaistow Street"]]);
    const r = await save([["Pickup", "5 Plaistow Street, RH7 6AU"]], { prev: first });
    expect(next(r)).not.toContain("still needs");
    expect(next(r)).not.toMatch(/1\. Pickup/);
  });

  it("a later save with the number only keeps the postcode", async () => {
    const first = await save([["Pickup", "Plaistow Street"]]);
    const r = await save([["Pickup", "5 Plaistow Street"]], { prev: first });
    expect(next(r)).toContain("1. Pickup (still needs: postcode)");
  });
});

describe("asked once, then accepted (Review Focus 4)", () => {
  it("the AI's own words after the listing name the parts: not listed again, though still missing", async () => {
    const first = await save([["Pickup", "Plaistow Street"]], { said: GREETING });
    const r = await save([["Pickup", "Plaistow Street"], ["Destination", "Dormansland"]], {
      prev: first,
      said: `${GREETING} Got it, Plaistow Street. What's the house number and postcode there?`,
    });
    expect(next(r)).not.toContain("still needs");
    expect(next(r)).not.toMatch(/1\. Pickup/);
    expect(counters().answer_parts_asked).toBe(2);
  });

  it("words said BEFORE the listing do not count (the notes' own pickup question)", async () => {
    const said = `${GREETING} What's the pickup address, with the house number and postcode?`;
    const first = await save([["Pickup", "Plaistow Street"]], { said });
    const r = await save([["Pickup", "Plaistow Street"], ["Destination", "Dormansland"]], { prev: first, said: `${said} Got it.` });
    expect(next(r)).toContain("1. Pickup (still needs: house number, postcode)");
  });

  it("a part the AI named in this turn, before the save, is not listed; the other still is", async () => {
    const r = await save([["Pickup", "Plaistow Street"]], { inTurn: "Got it, Plaistow Street. And the house number?" });
    expect(next(r)).toContain("1. Pickup (still needs: postcode)");
  });

  it("never named: listed on at most 3 replies, then accepted", async () => {
    let r = await save([["Pickup", "Plaistow Street"]]);
    expect(next(r)).toContain("still needs");
    r = await save([["Pickup", "Plaistow Street"], ["Destination", "Dormansland"]], { prev: r });
    expect(next(r)).toContain("still needs");
    r = await save([["Pickup", "Plaistow Street"], ["When", "Sat 8 am"]], { prev: r });
    expect(next(r)).toContain("still needs");
    r = await save([["Pickup", "Plaistow Street"], ["Passengers", "1"]], { prev: r });
    expect(next(r)).not.toContain("still needs");
    expect(counters().answer_parts_capped).toBe(1);
  });

  it("asked and closed: a later save of the same incomplete answer does not reopen it", async () => {
    const first = await save([["Pickup", "Plaistow Street"]]);
    const asked = await save([["Destination", "Dormansland"]], { prev: first, inTurn: "What's the house number and the postcode?" });
    const r = await save([["Pickup", "Plaistow Street"], ["When", "Sat"]], { prev: asked });
    expect(next(r)).not.toContain("still needs");
  });

  it("the cascade (no assistantSaidThisCall): one listing reply is the ask", async () => {
    const first = await save([["Pickup", "Plaistow Street"]], { said: null });
    expect(next(first)).toContain("still needs");
    const r = await save([["Pickup", "Plaistow Street"], ["Destination", "Dormansland"]], { prev: first, said: null });
    expect(next(r)).not.toContain("still needs");
  });
});

describe("where the parts are not asked", () => {
  it("a skip-reason save (URGENT) is exempt: no parts, nothing stored", async () => {
    const r = await save([["Pickup", "Plaistow Street"]], {
      config: taxi({ questionsSkipReasonPrefixes: ["URGENT"] }),
      args: { message: "URGENT car now" },
    });
    expect(next(r)).not.toContain("still needs");
    expect(r.stateEffects.capabilityState.messages.partsPending ?? []).toEqual([]);
  });

  it("no answerParts setting: the reply is byte-identical to the same save with a complete answer", async () => {
    const plain = { capabilities: { messages: { notes: HAMMERSLEYS_NOTES, confirmStyle: "each", questionsFor: "customers" } } };
    const without = await save([["Pickup", "Plaistow Street"]], { config: plain });
    expect(next(without)).not.toContain("still needs");
    const withComplete = await save([["Pickup", "Plaistow Street"]], { config: taxi({ answerParts: ["Pickup: house_number if street"] }), args: {} });
    expect(next(withComplete)).not.toBe(next(without));
    const complete = await save([["Pickup", "5 Plaistow Street"]], { config: taxi({ answerParts: ["Pickup: house_number if street"] }) });
    const completeWithout = await save([["Pickup", "5 Plaistow Street"]], { config: plain });
    expect(next(complete)).toBe(next(completeWithout));
  });

  it("notes with no numbered list: one short line does the job", async () => {
    const config = { capabilities: { messages: { notes: "Ask where from and where to.", answerParts: ["Pickup: house_number if street"] } } };
    const r = await save([["Pickup", "Plaistow Street"]], { config });
    expect(next(r)).toContain("[not caller speech] Pickup still needs: house number. Ask for it in your next question, once; if the caller does not know, go on.");
  });

  it("the healthcare tier never runs it", async () => {
    const config = { complianceTier: "hipaa", capabilities: { messages: { notes: HAMMERSLEYS_NOTES, answerParts: [RULE] } } };
    const r = await save([["Pickup", "Plaistow Street"]], { config });
    expect(next(r)).not.toContain("still needs");
  });
});

describe("with the other round-5/6 replies", () => {
  it("the already-asked reply carries the parts in its 'when they answer' list", async () => {
    const r = await save([["Pickup", "Plaistow Street"]], { inTurn: "Got it, Plaistow Street. Where are you going to?" });
    expect(next(r).startsWith(ALREADY_ASKED_NOTE)).toBe(true);
    expect(next(r)).toContain("When they answer, save it.");
    expect(next(r)).toContain("1. Pickup (still needs: house number, postcode)");
  });

  it("a separate request starts its parts over (Task 1 reset): the second trip's street pickup is listed", async () => {
    const first = await save([["Pickup", "5 Plaistow Street, RH7 6AU"], ["When", "Sat 5 am"]]);
    const r = await save([["Pickup", "Station Road, Lingfield"], ["When", "Mon 6 pm"]], { prev: first, args: { separate_request: true } });
    expect(next(r)).toContain("1. Pickup (still needs: house number, postcode)");
  });

  it("a separate request drops the first trip's owed parts", async () => {
    const first = await save([["Pickup", "Plaistow Street"], ["When", "Sat 5 am"]]);
    expect(next(first)).toContain("still needs");
    const r = await save([["Pickup", "Gatwick North"], ["When", "Mon 6 pm"]], { prev: first, args: { separate_request: true } });
    expect(next(r)).not.toContain("still needs");
    expect(r.stateEffects.capabilityState.messages.partsPending).toEqual([]);
  });
});

describe("review + sim fixes", () => {
  it("sim r6-street-1: the part ask leads the reply, before the next question", async () => {
    const r = await save([["Pickup", "Plaistow Street"]]);
    expect(next(r)).toMatch(/Pickup still needs: house number, postcode\. Ask for them in your next question, once; if the caller does not know, go on\./);
    expect(next(r).indexOf("still needs: house number, postcode. Ask")).toBeLessThan(next(r).indexOf("questions with no saved answer yet"));
  });

  it("sim r6-street-1: already asked the next question -> the part ask comes first for after the answer", async () => {
    const r = await save([["Pickup", "Plaistow Street"]], { inTurn: "Got it, Plaistow Street. Where are you going to?" });
    expect(next(r).startsWith(ALREADY_ASKED_NOTE)).toBe(true);
    expect(next(r)).toContain("When they answer, ask next for what Pickup still needs: house number, postcode (once; if they do not know, go on).");
  });

  it("review 3: the AI asks the SAME question word for word after the listing -> counted as the ask", async () => {
    const ask = "Could I have the house number and postcode for the pickup, please?";
    const said = `${GREETING} ${ask}`;
    const first = await save([["Pickup", "Plaistow Street"]], { said });
    const r = await save([["Pickup", "Plaistow Street"], ["Destination", "Dormansland"]], { prev: first, said: `${said} ${ask}` });
    expect(next(r)).not.toContain("still needs");
  });

  it("review 8: a second matching label in the same save ('Pickup time') does not clear the owed parts", async () => {
    const r = await save([["Pickup", "Plaistow Street"], ["Pickup time", "8 am"]]);
    expect(next(r)).toContain("Pickup still needs: house number, postcode");
  });
});

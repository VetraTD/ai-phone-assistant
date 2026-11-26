// Hammersleys round 5, Task 5. A save's reply asks the model to say back the
// details it saved that the caller has not heard yet. Owner call 4: the opener
// gave pickup, destination and time in one breath; the first save carried them;
// nothing said them back, so the misheard "Fifth Street" (Plaistow Street) went
// uncorrected into the email. Pack level: the real messages.execute.
import { beforeEach, describe, expect, it } from "vitest";
import messages from "../capabilities/messages.js";
import { ALREADY_ASKED_NOTE } from "../lib/voice/turnText.js";
import { clearStats, getLatencyStats } from "../lib/voice/metrics.js";
import { HAMMERSLEYS_NOTES } from "./fixtures/notesQuestionsFixtures.js";

const SAY_BACK_LEAD = "[not caller speech] Before your next question, say back what you saved that the caller has not heard yet: ";
const NUMBER = "+12145550123";
const taxi = (extra = {}, top = {}) => ({
  ...top,
  capabilities: { messages: { notes: HAMMERSLEYS_NOTES, confirmStyle: "each", questionsFor: "customers", ...extra } },
});
const d = (pairs) => pairs.map(([label, answer]) => ({ label, answer }));
const OPENER = d([["Pickup", "5 Fifth Street"], ["Destination", "Dormansland"], ["When", "tomorrow 8:30"]]);
const GREETING = "Thanks for calling Hammersleys Taxis. How can I help?";
function save(details, ctx = {}, config = taxi()) {
  const fc = {
    id: "f",
    name: "record_customer_request",
    args: { request_type: "message", caller_name: "James Doe", callback_number: "2145550123", message: "Taxi booking request", details },
  };
  return messages.execute(fc, { config, callerPhone: NUMBER, assistantSaidThisCall: GREETING, inTurnReplyText: "", ...ctx });
}
const next = (r) => r.functionResponse.response.next ?? "";
const counters = () => getLatencyStats()?.turnTaking ?? {};

beforeEach(() => clearStats());

describe("say back what the caller has not heard", () => {
  it("opener save, nothing said back yet: next starts with the note listing all three, in order", async () => {
    const r = await save(OPENER);
    expect(next(r).startsWith(`${SAY_BACK_LEAD}Pickup 5 Fifth Street; Destination Dormansland; When tomorrow 8:30. `)).toBe(true);
    expect(next(r)).toContain("questions with no saved answer yet");
    expect(counters().tool_reply_say_back).toBe(1);
  });

  it("the AI said part of it ('house number for Fifth Street'): Pickup still listed (the 5 is unheard), Destination too", async () => {
    const r = await save(OPENER, { inTurnReplyText: "Could you give me the house number for Fifth Street." });
    expect(next(r)).toMatch(/^\[not caller speech\] Before your next question, say back .*Pickup 5 Fifth Street; Destination Dormansland/);
  });

  it("everything already said (digits spoken as words, a spelled postcode, a spoken date): no note", async () => {
    const r = await save(
      d([["Pickup", "7 Plaistow Street, Lingfield, RH7 6AU"], ["When", "Fri 27 Nov 8 a.m."]]),
      { assistantSaidThisCall: `${GREETING} Got it, seven Plaistow Street, Lingfield, R-H-7 6-A-U. And that's Friday, November twenty-seventh at eight a.m.` }
    );
    expect(next(r)).not.toContain("say back what you saved");
    expect(counters().tool_reply_say_back ?? 0).toBe(0);
  });

  it("a detail saved by an earlier save is not listed again", async () => {
    const first = await save(d([["Pickup", "12 High Street"]]));
    const r = await save(d([["Pickup", "12 High Street"], ["Destination", "Gatwick North"]]), {
      capabilityState: { messages: first.stateEffects.capabilityState.messages },
    });
    expect(next(r)).toContain(`${SAY_BACK_LEAD}Destination Gatwick North. `);
    expect(next(r)).not.toMatch(/say back[^.]*Pickup/);
  });

  it("the turn already ended with a question: no note (Task 1's note instead)", async () => {
    const r = await save(OPENER, { inTurnReplyText: "Lovely. Can I take your name?" });
    expect(next(r)).toBe(ALREADY_ASKED_NOTE);
  });

  it("confirm style 'end', the healthcare tier and the cascade: no note", async () => {
    expect(next(await save(OPENER, {}, taxi({ confirmStyle: "end" })))).not.toContain("say back what you saved");
    expect(next(await save(OPENER, {}, taxi({}, { complianceTier: "hipaa" })))).not.toContain("say back what you saved");
    expect(next(await save(OPENER, { assistantSaidThisCall: undefined }))).not.toContain("say back what you saved");
    expect(next(await save(OPENER, { outboundCall: true }))).not.toContain("say back what you saved");
  });

  it("not on a skip-reason save or the guard's forced save", async () => {
    const urgent = taxi({ questionsSkipReasonPrefixes: ["URGENT"] });
    const fc = {
      id: "f",
      name: "record_customer_request",
      args: { request_type: "message", caller_name: "J", callback_number: "2145550123", message: "URGENT car now", details: d([["Where", "The Greyhound"]]) },
    };
    const r = await messages.execute(fc, { config: urgent, callerPhone: NUMBER, assistantSaidThisCall: GREETING, inTurnReplyText: "" });
    expect(next(r)).not.toContain("say back what you saved");
    expect(next(await save(OPENER, { saveGuardPending: true }))).not.toContain("say back what you saved");
  });

  it("values over 60 characters are cut; more than 3 items -> the first 3", async () => {
    const long = "Flat 3, The Old Granary, 14 Long Lane, Dormansland, near the village green, RH7 6AU";
    const r = await save(d([["Pickup", long], ["Destination", "Oxted Station"], ["When", "Sat 5 a.m."], ["Passengers", "3"]]));
    const note = next(r).split(" [not caller speech] ")[0];
    expect(note.startsWith(SAY_BACK_LEAD)).toBe(true);
    expect(note).toContain(`Pickup ${long.slice(0, 60)}`);
    expect(note).not.toContain(long);
    expect(note).toContain("When Sat 5 a.m.");
    expect(note).not.toContain("Passengers");
  });
});

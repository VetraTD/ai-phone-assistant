/**
 * Hammersleys round 6, item 1 + item 5 (design 2026-11-27, R59): one record
 * per request.
 *
 * Round-5 call 4: "John Doe" (misheard) was saved with the trip, the caller
 * corrected it to "James Doe", and the correction filed a SECOND row (the
 * first already held answers). Read from the code: a second trip by the same
 * caller overwrote the first (same name, same reason, merged by label).
 *
 * The AI says which it is on the save (replaces_name, separate_request); code
 * checks the claim. R59: no "same details" fallback -- code never merges two
 * different names on its own; a forgotten field gives a visible duplicate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../capabilities/messages.js";
import { saveCustomerRequest, followsUpRequest, splitByRepeatedLabels } from "../lib/capabilities/customerRequests.js";
import { clearStats, getLatencyStats } from "../lib/voice/metrics.js";
import { STEPS } from "../lib/callState.js";
import { HAMMERSLEYS_NOTES } from "./fixtures/notesQuestionsFixtures.js";

/** An in-memory customer_requests table behind the three db functions (as tests/customerRequestCorrection.test.js). */
function makeDb({ callId = "call-1", businessId = "biz-1" } = {}) {
  const rows = [];
  let seq = 0;
  let active = null;
  const db = {
    withTenantSafe: async (tenant, fn) => {
      const prev = active;
      active = tenant ?? null;
      try {
        return await fn();
      } finally {
        active = prev;
      }
    },
    createCustomerRequest: vi.fn(async (r) => {
      if (active !== r.businessId) return null;
      const id = `req-${++seq}`;
      rows.push({
        id,
        business_id: r.businessId,
        call_id: r.callId ?? null,
        request_type: r.requestType,
        caller_name: r.callerName ?? null,
        callback_number: r.callbackNumber ?? null,
        message: r.message ?? null,
        preferred_time: r.preferredTime ?? null,
        details: r.details ?? null,
        seq,
      });
      return id;
    }),
    listCallCustomerRequests: vi.fn(async (cid, biz, type) => {
      if (active !== biz) return [];
      return rows
        .filter((r) => r.call_id === cid && r.business_id === biz && [].concat(type).includes(r.request_type))
        .sort((a, b) => b.seq - a.seq)
        .map((r) => ({ ...r }));
    }),
    updateCustomerRequest: vi.fn(async (u) => {
      if (active !== u.businessId) return null;
      const row = rows.find((r) => r.id === u.id);
      if (!row) return null;
      row.caller_name = u.callerName ?? row.caller_name;
      row.callback_number = u.callbackNumber ?? row.callback_number;
      row.message = u.message ?? row.message;
      row.preferred_time = u.preferredTime ?? row.preferred_time;
      row.details = u.details ?? row.details;
      return row.id;
    }),
  };
  return { db, rows, callId, businessId };
}

const D = (pairs) => ({ callerType: "new_enquiry", answers: pairs.map(([label, answer]) => ({ label, answer })) });
const answersOf = (row) => Object.fromEntries((row.details?.answers || []).map((a) => [a.label, a.answer]));

function saver(t) {
  return (name, pairs, opts = {}) =>
    saveCustomerRequest({
      db: t.db,
      businessId: t.businessId,
      callId: t.callId,
      row: {
        requestType: "message",
        callerName: name,
        callbackNumber: null,
        message: "Taxi booking request",
        preferredTime: null,
        details: D(pairs),
      },
      matchTypes: ["message", "callback"],
      takeOverBareRow: true,
      ...opts,
    });
}

const OUT = [["Pickup", "12 High Street, Lingfield, RH7 6AU"], ["Destination", "Gatwick North"], ["When", "Saturday 5 a.m."]];
const BACK = [["Pickup", "Gatwick North"], ["Destination", "12 High Street, Lingfield, RH7 6AU"], ["When", "Monday 6 p.m."]];

describe("followsUpRequest -- more of the same request, or a new one?", () => {
  it("a shared label with the same answer (case, spacing, punctuation ignored) is a follow-up", () => {
    expect(followsUpRequest(D([["Pickup", "12 High Street"]]), D([["pickup ", "12  high street."], ["Passengers", "2"]]))).toBe(true);
  });
  it("no shared label is a new request", () => {
    expect(followsUpRequest(D([["Pickup", "12 High Street"]]), D([["Passengers", "2"]]))).toBe(false);
  });
  it("any shared label with a different answer is a new request", () => {
    expect(followsUpRequest(D([["Pickup", "A"], ["When", "Sat"]]), D([["Pickup", "A"], ["When", "Mon"]]))).toBe(false);
  });
  it("nothing to compare is not a follow-up", () => {
    expect(followsUpRequest(null, D([["Pickup", "A"]]))).toBe(false);
    expect(followsUpRequest(D([["Pickup", "A"]]), null)).toBe(false);
  });
});

describe("item 5: a second request by the same caller", () => {
  it("documented residual: two trips with no flag merge as today (the first trip's answers replaced)", async () => {
    const t = makeDb();
    const save = saver(t);
    await save("Jane Doe", OUT);
    await save("Jane Doe", BACK);
    expect(t.rows).toHaveLength(1);
    expect(answersOf(t.rows[0]).When).toBe("Monday 6 p.m.");
  });

  it("separate_request files a second row and leaves the first untouched", async () => {
    const t = makeDb();
    const save = saver(t);
    await save("Jane Doe", OUT);
    const res = await save("Jane Doe", BACK, { separateRequest: true });
    expect(res.how).toBe("separate");
    expect(t.rows).toHaveLength(2);
    expect(answersOf(t.rows[0])).toEqual(Object.fromEntries(OUT));
    expect(answersOf(t.rows[1])).toEqual(Object.fromEntries(BACK));
  });

  it("separate_request resent on a follow-up of the second trip: still two rows, the second updated", async () => {
    const t = makeDb();
    const save = saver(t);
    await save("Jane Doe", OUT);
    await save("Jane Doe", BACK, { separateRequest: true });
    const res = await save("Jane Doe", [...BACK, ["Passengers", "2"]], { separateRequest: true });
    expect(res.how).toBe("separate_ignored");
    expect(t.rows).toHaveLength(2);
    expect(answersOf(t.rows[1]).Passengers).toBe("2");
    expect(answersOf(t.rows[0])).toEqual(Object.fromEntries(OUT));
  });

  it("separate_request sharing no label with the newest row is a new row", async () => {
    const t = makeDb();
    const save = saver(t);
    await save("Jane Doe", [["Pickup", "12 High Street"]]);
    const res = await save("Jane Doe", [["Item", "umbrella"]], { separateRequest: true });
    expect(res.how).toBe("separate");
    expect(t.rows).toHaveLength(2);
  });
});

describe("item 1: a corrected name", () => {
  const FIRST = [["Pickup", "Plaistow Street"], ["Destination", "Dormansland"], ["When", "Saturday at half 7"]];
  const SECOND = [["Pickup", "Plaistow Street"], ["Destination", "Dormansland"], ["When", "Saturday at 7:30"], ["Passengers", "1"]];

  it("replaces_name updates the row it names: one row, the new name, answers merged", async () => {
    const t = makeDb();
    const save = saver(t);
    await save("John Doe", FIRST);
    const res = await save("James Doe", SECOND, { replacesName: "John Doe" });
    expect(res.how).toBe("name_replaced");
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0].caller_name).toBe("James Doe");
    expect(answersOf(t.rows[0])).toEqual(Object.fromEntries(SECOND));
    // One answer changed (When); an equal one is not counted.
    expect(res.answersReplaced).toBe(1);
  });

  it("replaces_name matches the saved name the way samePerson does ('Jon Doe' finds 'John Doe')", async () => {
    const t = makeDb();
    const save = saver(t);
    await save("John Doe", FIRST);
    const res = await save("Jacob Dean", SECOND, { replacesName: "Jon Doe" });
    expect(res.how).toBe("name_replaced");
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0].caller_name).toBe("Jacob Dean");
  });

  it("replaces_name naming nobody on this call changes nothing: today's outcome (Review Focus 1)", async () => {
    const t = makeDb();
    const save = saver(t);
    await save("John Doe", FIRST);
    const res = await save("James Doe", SECOND, { replacesName: "Peter Pan" });
    expect(res.how).toBe("new");
    expect(res.replacesUnmatched).toBe(true);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0].caller_name).toBe("John Doe");
  });

  it("R59: no field, a different name, the same trip details: two rows, counted as a possible duplicate", async () => {
    const t = makeDb();
    const save = saver(t);
    await save("John Doe", FIRST);
    const res = await save("James Doe", SECOND);
    expect(res.how).toBe("new");
    expect(res.possibleDuplicate).toBe(true);
    expect(t.rows).toHaveLength(2);
  });

  it("anti-goal held: two people booking under their own names with the same pickup and destination stay two rows", async () => {
    const t = makeDb();
    const save = saver(t);
    await save("Jane Doe", OUT);
    await save("Tom Hill", OUT);
    expect(t.rows).toHaveLength(2);
    expect(t.rows.map((r) => r.caller_name)).toEqual(["Jane Doe", "Tom Hill"]);
  });

  it("a surname-only correction without the field: today's outcome (same first name = same person), one row renamed", async () => {
    const t = makeDb();
    const save = saver(t);
    await save("James Doe", FIRST);
    const res = await save("James Dean", SECOND);
    expect(res.how).toBe("matched");
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0].caller_name).toBe("James Dean");
  });

  it("a plain save with no new row to choose: how 'new' on the first save", async () => {
    const t = makeDb();
    const res = await saver(t)("Jane Doe", OUT);
    expect(res).toMatchObject({ how: "new", corrected: false, possibleDuplicate: false });
  });
});

// ---------------------------------------------------------------------------
// The messages pack: the declaration, the per-request state, the effect.
// ---------------------------------------------------------------------------
const NUMBER = "+12145550123";
const taxi = () => ({ capabilities: { messages: { notes: HAMMERSLEYS_NOTES, confirmStyle: "each", questionsFor: "customers" } } });
const pairs = (p) => p.map(([label, answer]) => ({ label, answer }));
function exec(details, extraArgs = {}, ctx = {}) {
  const fc = {
    id: "f",
    name: "record_customer_request",
    args: { request_type: "message", caller_name: "Jane Doe", message: "Taxi booking request", details: pairs(details), ...extraArgs },
  };
  return messages.execute(fc, { config: taxi(), callerPhone: NUMBER, ...ctx });
}
const stateOf = (r) => r.stateEffects.capabilityState.messages;
const nextOf = (r) => r.functionResponse.response.next ?? "";
const counters = () => getLatencyStats()?.turnTaking ?? {};

beforeEach(() => clearStats());

describe("the declaration carries the two fields, both tiers", () => {
  for (const [tier, config] of [
    ["standard", {}],
    ["healthcare", { complianceTier: "hipaa" }],
  ]) {
    it(`${tier}: replaces_name (string) and separate_request (boolean), neither required`, () => {
      const [decl] = messages.tools(config);
      expect(decl.parameters.properties.replaces_name.type).toBe("string");
      expect(decl.parameters.properties.separate_request.type).toBe("boolean");
      expect(decl.parameters.required).not.toContain("replaces_name");
      expect(decl.parameters.required).not.toContain("separate_request");
    });
  }
  it("the two descriptions together stay short (Live re-reads them every turn)", () => {
    const [decl] = messages.tools({});
    const words = `${decl.parameters.properties.replaces_name.description} ${decl.parameters.properties.separate_request.description}`.split(/\s+/);
    expect(words.length).toBeLessThanOrEqual(60);
  });
});

describe("per-request state in execute", () => {
  it("a separate request whose claim holds starts over: the first trip's Pickup no longer answers the second trip", async () => {
    const first = await exec(OUT);
    expect(stateOf(first).savedLabels).toEqual(["Pickup", "Destination", "When"]);
    const second = await exec([["When", "Monday 6 p.m."]], { separate_request: true }, { capabilityState: { messages: stateOf(first) } });
    expect(stateOf(second).savedLabels).toEqual(["When"]);
    expect(nextOf(second)).toMatch(/no saved answer yet: 1\. Pickup, 2\. Destination/);
    expect(stateOf(second).requestAnswers).toEqual(pairs([["When", "Monday 6 p.m."]]));
  });

  it("an ignored claim (a follow-up of the same request) resets nothing", async () => {
    const first = await exec(OUT);
    const again = await exec([...OUT, ["Passengers", "2"]], { separate_request: true }, { capabilityState: { messages: stateOf(first) } });
    expect(stateOf(again).savedLabels).toEqual(["Pickup", "Destination", "When", "Passengers"]);
    expect(nextOf(again)).not.toMatch(/1\. Pickup/);
  });

  it("without the flag the request's answers accumulate (merged by label)", async () => {
    const first = await exec([["Pickup", "Plaistow Street"]]);
    const second = await exec([["Pickup", "5 Plaistow Street"], ["When", "Sat"]], {}, { capabilityState: { messages: stateOf(first) } });
    expect(stateOf(second).requestAnswers).toEqual(pairs([["Pickup", "5 Plaistow Street"], ["When", "Sat"]]));
  });

  it("a separate request owes no say-back of the first trip's labels", async () => {
    const said = "Thanks for calling.";
    const first = await exec(OUT, {}, { assistantSaidThisCall: said, inTurnReplyText: "Got it. When do you need it?" });
    expect(stateOf(first).sayBackOwed?.length).toBeGreaterThan(0);
    const second = await exec([["When", "Monday 6 p.m."]], { separate_request: true }, {
      assistantSaidThisCall: said,
      inTurnReplyText: "And the return. Where from?",
      capabilityState: { messages: stateOf(first) },
    });
    expect(stateOf(second).sayBackOwed).toEqual(["When"]);
  });
});

describe("onEffect passes the claims and counts the outcome (no words)", () => {
  function engineFor(t) {
    const logs = [];
    const engine = {
      STEPS,
      setStep: () => {},
      call: { callSid: "CA_r6", businessId: t.businessId, callId: t.callId, callerNumber: "+12145550100", config: { businessName: "B" }, party: null },
      deps: {
        db: t.db,
        notifications: { notifyCustomerRequest: vi.fn().mockResolvedValue(true), sendCallerSms: vi.fn().mockResolvedValue(undefined), MESSAGE_SLA_TEXT: "soon" },
        log: { info: (e, d) => logs.push({ e, d }), error: () => {}, warn: () => {} },
        captureException: () => {},
      },
    };
    return { engine, logs };
  }
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const effect = (data) => ({ capability: "messages", type: "recorded", data });

  it("replaces_name reaches saveCustomerRequest: one row, counted, logged with its kind", async () => {
    const t = makeDb();
    const { engine, logs } = engineFor(t);
    messages.onEffect(effect({ request_type: "message", caller_name: "John Doe", message: "Taxi booking request", details: pairs(OUT) }), engine);
    await settle();
    messages.onEffect(
      effect({ request_type: "message", caller_name: "James Doe", replaces_name: "John Doe", message: "Taxi booking request", details: pairs(OUT) }),
      engine
    );
    await settle();
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0].caller_name).toBe("James Doe");
    expect(counters().customer_request_name_replaced).toBe(1);
    const corrected = logs.find((l) => l.e === "customer_request_corrected");
    expect(corrected.d.how).toBe("name_replaced");
    expect(JSON.stringify(logs)).not.toMatch(/Doe|High Street/);
  });

  it("separate_request reaches it: two rows, counted", async () => {
    const t = makeDb();
    const { engine } = engineFor(t);
    messages.onEffect(effect({ request_type: "message", caller_name: "Jane Doe", message: "Taxi booking request", details: pairs(OUT) }), engine);
    await settle();
    messages.onEffect(
      effect({ request_type: "message", caller_name: "Jane Doe", separate_request: true, message: "Taxi booking request", details: pairs(BACK) }),
      engine
    );
    await settle();
    expect(t.rows).toHaveLength(2);
    expect(counters().customer_request_separate).toBe(1);
  });

  it("a duplicate under a new name with no field is counted; a changed answer is counted", async () => {
    const t = makeDb();
    const { engine } = engineFor(t);
    messages.onEffect(effect({ request_type: "message", caller_name: "John Doe", message: "Taxi booking request", details: pairs(OUT) }), engine);
    await settle();
    messages.onEffect(effect({ request_type: "message", caller_name: "James Doe", message: "Taxi booking request", details: pairs(OUT) }), engine);
    await settle();
    expect(counters().customer_request_possible_duplicate).toBe(1);
    messages.onEffect(
      effect({ request_type: "message", caller_name: "James Doe", message: "Taxi booking request", details: pairs([["When", "Sunday 5 a.m."]]) }),
      engine
    );
    await settle();
    expect(counters().customer_request_answer_replaced).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Sim r6-two-trips-1 (2026-11-27): the caller gave both trips in one breath and
// the model saved them in ONE call with every label twice (Pickup x2,
// Destination x2, When x2). One record; a later save merges by label and could
// replace the wrong trip's answer. A label given twice with different answers
// in one save is the AI saying "two requests": one row per request.
// ---------------------------------------------------------------------------
describe("one save carrying two trips (repeated labels)", () => {
  const COMBINED = [...OUT, ...BACK, ["Passengers", "2"]];

  it("splitByRepeatedLabels: one request per occurrence; a label given once goes to each", () => {
    expect(splitByRepeatedLabels(D(COMBINED)).map((p) => p.answers.map((a) => `${a.label}=${a.answer}`))).toEqual([
      [...OUT, ["Passengers", "2"]].map(([l, a]) => `${l}=${a}`),
      [...BACK, ["Passengers", "2"]].map(([l, a]) => `${l}=${a}`),
    ]);
  });

  it("a label repeated with the same answer is not two requests", () => {
    expect(splitByRepeatedLabels(D([["Pickup", "A"], ["pickup", "a."], ["When", "Sat"]]))).toHaveLength(1);
  });

  it("no repeated label: one part, the details as they are", () => {
    const d = D(OUT);
    expect(splitByRepeatedLabels(d)).toEqual([d]);
    expect(splitByRepeatedLabels(null)).toEqual([null]);
  });

  it("with two rows of one caller, a save lands on the row it matches best, not just the newest", async () => {
    const t = makeDb();
    const save = saver(t);
    await save("Ann Lee", OUT);
    await save("Ann Lee", BACK, { separateRequest: true });
    // Trip 1's time corrected, no flag: before, the newest row (trip 2) took it.
    const res = await save("Ann Lee", [["Pickup", OUT[0][1]], ["Destination", "Gatwick North"], ["When", "Sunday 4 a.m."]]);
    expect(res.how).toBe("matched");
    expect(t.rows).toHaveLength(2);
    expect(answersOf(t.rows[0]).When).toBe("Sunday 4 a.m.");
    expect(answersOf(t.rows[1])).toEqual(Object.fromEntries(BACK));
  });

  it("onEffect: the combined save files two rows; later combined saves update each; a correction of trip 1 leaves trip 2", async () => {
    const t = makeDb();
    const logs = [];
    const engine = {
      STEPS,
      setStep: () => {},
      call: { callSid: "CA_r6b", businessId: t.businessId, callId: t.callId, callerNumber: "+12145550100", config: { businessName: "B" }, party: null },
      deps: {
        db: t.db,
        notifications: { notifyCustomerRequest: vi.fn().mockResolvedValue(true), sendCallerSms: vi.fn().mockResolvedValue(undefined), MESSAGE_SLA_TEXT: "soon" },
        log: { info: (e, d) => logs.push({ e, d }), error: () => {}, warn: () => {} },
        captureException: () => {},
      },
    };
    const settle = () => new Promise((r) => setTimeout(r, 40));
    const effect = (details) => ({
      capability: "messages",
      type: "recorded",
      data: { request_type: "message", caller_name: "Ann Lee", message: "Taxi booking request", details: pairs(details) },
    });
    messages.onEffect(effect(COMBINED), engine);
    await settle();
    expect(t.rows).toHaveLength(2);
    expect(answersOf(t.rows[0]).When).toBe("Saturday 5 a.m.");
    expect(answersOf(t.rows[1]).When).toBe("Monday 6 p.m.");
    messages.onEffect(effect([...COMBINED, ["Luggage", "2 cases"]]), engine);
    await settle();
    expect(t.rows).toHaveLength(2);
    expect(answersOf(t.rows[0]).Luggage).toBe("2 cases");
    expect(answersOf(t.rows[1]).Luggage).toBe("2 cases");
    const corrected = [["Pickup", OUT[0][1]], ["Destination", "Gatwick North"], ["When", "Saturday 4 a.m."], ...BACK];
    messages.onEffect(effect(corrected), engine);
    await settle();
    expect(t.rows).toHaveLength(2);
    expect(answersOf(t.rows[0]).When).toBe("Saturday 4 a.m.");
    expect(answersOf(t.rows[1]).When).toBe("Monday 6 p.m.");
    expect(answersOf(t.rows[1]).Pickup).toBe("Gatwick North");
  });
});

// ---------------------------------------------------------------------------
// Opus review (round 6) fixes.
// ---------------------------------------------------------------------------
describe("review fixes: the separate claim, the ignored flag, replaces_name", () => {
  it("review 1: a resent flag on a CORRECTION of trip 2 (agrees on 2, conflicts on 1) is a follow-up, not a third row", async () => {
    const t = makeDb();
    const save = saver(t);
    await save("Jane Doe", OUT);
    await save("Jane Doe", BACK, { separateRequest: true });
    const res = await save("Jane Doe", [["Pickup", "Gatwick North"], ["Destination", BACK[1][1]], ["When", "Monday 7 p.m."]], { separateRequest: true });
    expect(res.how).toBe("separate_ignored");
    expect(t.rows).toHaveLength(2);
    expect(answersOf(t.rows[1]).When).toBe("Monday 7 p.m.");
    expect(answersOf(t.rows[0])).toEqual(Object.fromEntries(OUT));
  });

  it("review 1: the same pickup at two times (agrees 1, conflicts 1) is still a separate request", async () => {
    const t = makeDb();
    const save = saver(t);
    await save("Jane Doe", [["Pickup", "12 High Street"], ["When", "Sat 8 am"]]);
    const res = await save("Jane Doe", [["Pickup", "12 High Street"], ["When", "Sat 4 pm"]], { separateRequest: true });
    expect(res.how).toBe("separate");
    expect(t.rows).toHaveLength(2);
  });

  it("review 2: an ignored flag lands on the newest row even when its reason is worded like trip 1's", async () => {
    const t = makeDb();
    const save = saver(t);
    await save("Ann Lee", OUT);
    await saveCustomerRequest({
      db: t.db,
      businessId: t.businessId,
      callId: t.callId,
      row: { requestType: "message", callerName: "Ann Lee", callbackNumber: null, message: "Return trip from Gatwick", preferredTime: null, details: D(BACK) },
      matchTypes: ["message", "callback"],
      takeOverBareRow: true,
      separateRequest: true,
    });
    const res = await save("Ann Lee", [...BACK, ["Passengers", "2"]], { separateRequest: true });
    expect(res.how).toBe("separate_ignored");
    expect(answersOf(t.rows[0])).toEqual(Object.fromEntries(OUT));
    expect(answersOf(t.rows[1]).Passengers).toBe("2");
  });

  it("review 7: replaces_name used for ANOTHER person's different trip is not honoured -- a visible second row", async () => {
    const t = makeDb();
    const save = saver(t);
    await save("John Doe", OUT);
    await save("Jane Doe", BACK, { replacesName: "John Doe" });
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0].caller_name).toBe("John Doe");
    expect(answersOf(t.rows[0])).toEqual(Object.fromEntries(OUT));
  });
});

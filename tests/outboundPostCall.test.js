// tests/outboundPostCall.test.js
/**
 * lib/outbound/postCall.js, unit level: a fake db, no Postgres. The DB race
 * (claimPostCall against real Postgres) is tests/db/outboundPostCallClaim.test.js.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runPostCall, createPostCall } from "../lib/outbound/postCall.js";

const BIZ = "biz-1";
const ATTEMPT = "attempt-1";
const OUTREACH = "outreach-1";
const CALL_ID = "call-1";
const CALL_SID = "CAsid1";
const PHONE = "+447700900202";

const CONFIG = {
  retries: { schedule: ["now", "+10m", "+3h"] },
  calling_window: { mon_fri: "00:00-23:59", sat: "00:00-23:59", sun: "00:00-23:59" },
};

/** Always inside the calling window: every weekday, midnight to midnight. */
const NOW = new Date("2026-09-25T12:00:00Z");

function baseCtx(overrides = {}) {
  return {
    attemptNo: 1,
    dialedAt: new Date("2026-09-25T11:59:00Z"),
    answeredAt: new Date("2026-09-25T11:59:05Z"),
    endedAt: null,
    answeredBy: "human",
    result: null,
    silent: false,
    sessionFinishedAt: new Date("2026-09-25T11:59:40Z"),
    statusCompletedAt: new Date("2026-09-25T11:59:41Z"),
    twilioCallSid: CALL_SID,
    outreachId: OUTREACH,
    outreachState: "dialing",
    attemptsMade: 1,
    outreachCreatedAt: new Date("2026-09-20T09:00:00Z"),
    campaignId: "camp-1",
    campaignVersion: 1,
    contactId: "contact-1",
    complianceClass: "solicited",
    templateKey: "speed_to_lead",
    config: CONFIG,
    phoneE164: PHONE,
    contactTimezone: "Europe/London",
    businessTimezone: "Europe/London",
    callId: CALL_ID,
    callSid: CALL_SID,
    outcomeCode: null,
    answers: null,
    ...overrides,
  };
}

/** A realistic claimed-timestamp value (fix round 1, item 1): claimPostCall returns the value it wrote, never a bare boolean. */
const CLAIMED_AT = new Date("2026-09-25T12:00:05Z");

function fakeDb(ctxOverrides = {}, fnOverrides = {}) {
  const ctx = baseCtx(ctxOverrides);
  const calls = { finalizeAttemptResult: [], setCallOutcomeCode: [], updateCallSummary: [], setAttemptSilent: [], setOutreachHold: [], applyOutreachResult: [], insertDetectorSuppression: [], releasePostCallClaim: [] };
  return {
    calls,
    ctx,
    withTenant: vi.fn(async (_biz, fn) => fn()),
    outboundPostCallContext: vi.fn(async () => ctx),
    // W3 (final review D2): the real function now RETURNS the ended_at it
    // committed (via RETURNING) -- this default fake returns null, matching
    // the pre-fix behaviour (no return value used) for every one of the many
    // existing tests below that never look at it. Tests proving D2 override
    // this to return a real Date.
    finalizeAttemptResult: vi.fn(async (...a) => {
      calls.finalizeAttemptResult.push(a);
      return null;
    }),
    outboundCallEffects: vi.fn(async () => ({ booked: false, optedOut: false })),
    fetchCallTranscript: vi.fn(async () => []),
    setCallOutcomeCode: vi.fn(async (...a) => calls.setCallOutcomeCode.push(a)),
    updateCallSummary: vi.fn(async (...a) => calls.updateCallSummary.push(a)),
    isSuppressed: vi.fn(async () => false),
    insertDetectorSuppression: vi.fn(async (...a) => {
      calls.insertDetectorSuppression.push(a);
      return true;
    }),
    setAttemptSilent: vi.fn(async (...a) => calls.setAttemptSilent.push(a)),
    setOutreachHold: vi.fn(async (...a) => calls.setOutreachHold.push(a)),
    applyOutreachResult: vi.fn(async (...a) => {
      calls.applyOutreachResult.push(a);
      return true;
    }),
    claimPostCall: vi.fn(async () => CLAIMED_AT),
    releasePostCallClaim: vi.fn(async (...a) => {
      calls.releasePostCallClaim.push(a);
      return true;
    }),
    outboundAttemptByCallSid: vi.fn(async () => ({ attemptId: ATTEMPT, businessId: BIZ })),
    ...fnOverrides,
  };
}

const noopSummarize = async () => ({ summary: null, sentiment: null, outcome: "unknown" });

async function run(db, overrides = {}) {
  await runPostCall({ attemptId: ATTEMPT, businessId: BIZ }, { db, now: () => NOW, rand: () => 0, summarize: noopSummarize, ...overrides });
}

describe("runPostCall: unanswered attempts run steps 1 and 5-7 only", () => {
  // I6 (fix wave, checkpoint 2b): a genuinely unanswered attempt (busy/
  // no_answer/failed/canceled) never gets a `calls` row at all -- Task 14's
  // onStart only creates one on an answered call (doorRoutes.js's own doc)
  // -- so `callId: null` here matches what these fixtures were always
  // MEANT to represent, now that `answered` also falls back to callId.
  it.each(["no_answer", "busy", "failed", "canceled"])("result=%s: no outcome resolution, no detectors, no silent-rule writes", async (result) => {
    const db = fakeDb({ answeredAt: null, callId: null, result, sessionFinishedAt: null });
    await run(db);

    expect(db.finalizeAttemptResult).toHaveBeenCalledWith(ATTEMPT, null);
    expect(db.setCallOutcomeCode).not.toHaveBeenCalled();
    expect(db.updateCallSummary).not.toHaveBeenCalled();
    expect(db.outboundCallEffects).not.toHaveBeenCalled();
    expect(db.setAttemptSilent).not.toHaveBeenCalled();
    expect(db.setOutreachHold).not.toHaveBeenCalled();
    expect(db.applyOutreachResult).toHaveBeenCalledTimes(1);
    const [, , opts] = db.applyOutreachResult.mock.calls[0];
    expect(opts.outcome).toBeNull(); // a decline is never scored not_interested
  });

  it.each(["busy", "no_answer"])("%s: the SAME next next_attempt_at as the other", async (result) => {
    const dbA = fakeDb({ answeredAt: null, callId: null, result: "busy", sessionFinishedAt: null });
    const dbB = fakeDb({ answeredAt: null, callId: null, result: "no_answer", sessionFinishedAt: null });
    await run(dbA);
    await run(dbB);
    const nextA = dbA.applyOutreachResult.mock.calls[0][2].nextAttemptAt;
    const nextB = dbB.applyOutreachResult.mock.calls[0][2].nextAttemptAt;
    expect(nextA).toBeInstanceOf(Date);
    expect(nextA.getTime()).toBe(nextB.getTime());
  });

  it("attempts_made not yet exhausted -> reschedules, does not close", async () => {
    const db = fakeDb({ answeredAt: null, callId: null, result: "no_answer", sessionFinishedAt: null, attemptNo: 1 });
    await run(db);
    const [outreachId, attemptNo, opts] = db.applyOutreachResult.mock.calls[0];
    expect(outreachId).toBe(OUTREACH);
    expect(attemptNo).toBe(1);
    expect(opts.terminal).toBe(false);
    expect(opts.nextAttemptAt).toBeInstanceOf(Date);
  });

  it("schedule exhausted -> closes with attempts_exhausted", async () => {
    const db = fakeDb({ answeredAt: null, callId: null, result: "no_answer", sessionFinishedAt: null, attemptNo: 3 }); // schedule has 3 entries
    await run(db);
    const [, , opts] = db.applyOutreachResult.mock.calls[0];
    expect(opts.terminal).toBe(true);
    expect(opts.closeReason).toBe("attempts_exhausted");
  });
});

// I6 (fix wave, checkpoint 2b, = b37): a lost/late answered_at stamp must
// not make a talked-to person read as unanswered. A `calls` row (callId)
// only ever exists because a session actually started (Task 14's onStart on
// an answered call) -- so its presence is itself answered evidence, the
// backstop for `answered_at` never landing at all.
describe("runPostCall: I6 -- a lost/late answered_at stamp still reads as answered when a session (callId) exists", () => {
  it("answeredAt null but callId present: the transcript is read, the answered branch runs, result falls back to 'connected'", async () => {
    const db = fakeDb(
      { answeredAt: null, answeredBy: "human" },
      { fetchCallTranscript: vi.fn(async () => [{ speaker: "caller", message: "stop calling me" }]) }
    );
    await run(db);

    expect(db.fetchCallTranscript).toHaveBeenCalledWith(CALL_ID);
    expect(db.finalizeAttemptResult).toHaveBeenCalledWith(ATTEMPT, "connected");
    expect(db.setAttemptSilent).toHaveBeenCalled(); // the answered-only silent-verdict step ran
  });

  it("answeredAt null AND callId null: genuinely never connected -- the unanswered branch, no transcript read", async () => {
    const db = fakeDb({ answeredAt: null, callId: null, result: "no_answer", sessionFinishedAt: null });
    await run(db);

    expect(db.fetchCallTranscript).not.toHaveBeenCalled();
    expect(db.finalizeAttemptResult).toHaveBeenCalledWith(ATTEMPT, null);
    expect(db.setAttemptSilent).not.toHaveBeenCalled();
  });
});

describe("runPostCall: outcome precedence (Ruling P-6)", () => {
  it("tier 2 (door-set outcome_code) wins over the summary", async () => {
    const summarize = vi.fn(async () => ({ summary: "s", sentiment: "neutral", outcome: "other" }));
    const db = fakeDb({ outcomeCode: "callback_requested" });
    await run(db, { summarize });
    expect(summarize).not.toHaveBeenCalled();
    expect(db.setCallOutcomeCode).toHaveBeenCalledWith(CALL_SID, "callback_requested");
    expect(db.updateCallSummary).not.toHaveBeenCalled();
  });

  it("tier 3 (effects: booking) wins over the summary", async () => {
    const summarize = vi.fn(async () => ({ summary: "s", sentiment: "neutral", outcome: "other" }));
    const db = fakeDb({}, { outboundCallEffects: vi.fn(async () => ({ booked: true, optedOut: false })) });
    await run(db, { summarize });
    expect(summarize).not.toHaveBeenCalled();
    expect(db.setCallOutcomeCode).toHaveBeenCalledWith(CALL_SID, "booked");
  });

  it("tier 3 (effects: tool opt-out) wins over the summary", async () => {
    const summarize = vi.fn(async () => ({ summary: "s", sentiment: "neutral", outcome: "other" }));
    const db = fakeDb({}, { outboundCallEffects: vi.fn(async () => ({ booked: false, optedOut: true })) });
    await run(db, { summarize });
    expect(summarize).not.toHaveBeenCalled();
    expect(db.setCallOutcomeCode).toHaveBeenCalledWith(CALL_SID, "opted_out");
  });

  it("tier 4 (the summary, extended with the outbound enum) resolves when nothing else did", async () => {
    const summarize = vi.fn(async (rows, enumArg) => ({ summary: "Not interested.", sentiment: "negative", outcome: "not_interested" }));
    const db = fakeDb({}, { fetchCallTranscript: vi.fn(async () => [{ speaker: "caller", message: "not interested, thanks" }]) });
    await run(db, { summarize });
    expect(summarize).toHaveBeenCalled();
    expect(db.setCallOutcomeCode).toHaveBeenCalledWith(CALL_SID, "not_interested");
    expect(db.updateCallSummary).toHaveBeenCalledWith(CALL_SID, "Not interested.", "negative", null);
  });

  it("tier 5: falls back to unknown when the summary itself falls back", async () => {
    const db = fakeDb({}, { fetchCallTranscript: vi.fn(async () => []) });
    await run(db); // noopSummarize returns {outcome: "unknown"}
    expect(db.setCallOutcomeCode).toHaveBeenCalledWith(CALL_SID, "unknown");
  });

  // O-23 (post-2c, b29): the no-session path now reads door/tool
  // outcome_code and effects, with the SAME precedence the session path
  // uses -- it no longer resolves from the summary alone. A contact who
  // booked (or was flagged for a door-set outcome) before the session
  // crashed must not be redialled.
  it("no session finished + a booking effect -> outcome resolves to booked, and the outreach closes with no reschedule (O-23)", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const summarize = vi.fn(async () => ({ summary: "s", sentiment: "neutral", outcome: "other" }));
    const db = fakeDb(
      { sessionFinishedAt: null, outcomeCode: null },
      { outboundCallEffects: vi.fn(async () => ({ booked: true, optedOut: false })) }
    );
    await run(db, { summarize, log });
    expect(db.outboundCallEffects).toHaveBeenCalledWith(CALL_ID);
    expect(summarize).not.toHaveBeenCalled();
    expect(db.setCallOutcomeCode).toHaveBeenCalledWith(CALL_SID, "booked");
    const [, , opts] = db.applyOutreachResult.mock.calls[0];
    expect(opts.terminal).toBe(true);
    expect(opts.closeReason).toBe("terminal_outcome");
    expect(opts.nextAttemptAt).toBeNull();
    expect(log.info).toHaveBeenCalledWith("outbound_postcall_without_session", expect.objectContaining({ attemptId: ATTEMPT }));
  });

  it("no session finished + a door-set outcome_code -> used ahead of effects and the summary (O-23, same precedence as the session path)", async () => {
    const summarize = vi.fn(async () => ({ summary: "s", sentiment: "neutral", outcome: "other" }));
    const db = fakeDb(
      { sessionFinishedAt: null, outcomeCode: "callback_requested" },
      { outboundCallEffects: vi.fn(async () => ({ booked: true, optedOut: false })) } // must never be consulted: tier 1 already resolved it
    );
    await run(db, { summarize });
    expect(db.outboundCallEffects).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    expect(db.setCallOutcomeCode).toHaveBeenCalledWith(CALL_SID, "callback_requested");
  });

  it("no session finished + no door outcome + no effects -> unchanged: falls back to the summary, and still logs outbound_postcall_without_session (O-23)", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const summarize = vi.fn(async () => ({ summary: "s", sentiment: "neutral", outcome: "other" }));
    const db = fakeDb(
      { sessionFinishedAt: null, outcomeCode: null },
      { outboundCallEffects: vi.fn(async () => ({ booked: false, optedOut: false })) }
    );
    await run(db, { summarize, log });
    expect(db.outboundCallEffects).toHaveBeenCalledWith(CALL_ID);
    expect(summarize).toHaveBeenCalled();
    expect(db.setCallOutcomeCode).toHaveBeenCalledWith(CALL_SID, "other");
    expect(log.info).toHaveBeenCalledWith("outbound_postcall_without_session", expect.objectContaining({ attemptId: ATTEMPT }));
  });
});

describe("runPostCall: terminal vs. reschedule (spec §8)", () => {
  it.each(["booked", "not_interested", "not_a_fit", "opted_out", "wrong_person"])("%s closes the outreach (terminal_outcome)", async (outcome) => {
    const db = fakeDb({}, { fetchCallTranscript: vi.fn(async () => [{ speaker: "ai", message: "ok" }]) });
    await run(db, { summarize: async () => ({ summary: "s", sentiment: "neutral", outcome }) });
    const [, , opts] = db.applyOutreachResult.mock.calls[0];
    expect(opts).toMatchObject({ terminal: true, closeReason: "terminal_outcome", outcome });
  });

  // S3-4 (D6): "transferred" is set deterministically by the door route
  // (ctx.outcomeCode, tier 1/2), never guessed by the summarizer -- unlike
  // the it.each above, which drives the OTHER terminal outcomes through
  // `summarize()` (tier 4). The completed-transfer door route
  // (doorRoutes.js's outbound-transfer-result) is what actually writes this
  // outcome_code; this test only proves postCall.js closes on it.
  it("transferred (ctx.outcomeCode, door-set) closes the outreach (terminal_outcome), without ever calling summarize()", async () => {
    const summarize = vi.fn(async () => ({ summary: "s", sentiment: "neutral", outcome: "other" }));
    const db = fakeDb({ outcomeCode: "transferred" });
    await run(db, { summarize });
    const [, , opts] = db.applyOutreachResult.mock.calls[0];
    expect(opts).toMatchObject({ terminal: true, closeReason: "terminal_outcome", outcome: "transferred" });
    expect(summarize).not.toHaveBeenCalled();
  });

  it("qualified_no_booking WITHOUT a confirmed real conversation is NOT terminal -- reschedules", async () => {
    const db = fakeDb({}, { fetchCallTranscript: vi.fn(async () => [{ speaker: "ai", message: "ok" }]) });
    await run(db, { summarize: async () => ({ summary: "s", sentiment: "neutral", outcome: "qualified_no_booking" }) });
    const [, , opts] = db.applyOutreachResult.mock.calls[0];
    expect(opts.terminal).toBe(false);
    expect(opts.nextAttemptAt).toBeInstanceOf(Date);
  });

  it("callback_requested WITH a requested time schedules at that time", async () => {
    const requested = "2026-09-30T14:00:00Z";
    const db = fakeDb({ outcomeCode: "callback_requested", answers: { _callback_requested_at: requested } });
    await run(db);
    const [, , opts] = db.applyOutreachResult.mock.calls[0];
    expect(opts.terminal).toBe(false);
    expect(opts.nextAttemptAt.toISOString()).toBe(new Date(requested).toISOString());
  });

  it("callback_requested with NO requested time takes the next schedule entry (mechanical ruling)", async () => {
    const db = fakeDb({ outcomeCode: "callback_requested", answers: null });
    await run(db);
    const [, , opts] = db.applyOutreachResult.mock.calls[0];
    expect(opts.terminal).toBe(false);
    // attemptNo=1 -> entries[1] = "+10m" from NOW.
    expect(opts.nextAttemptAt.toISOString()).toBe(new Date(NOW.getTime() + 10 * 60_000).toISOString());
  });

  // I4 (review, controller ruling): a stored callback_requested_at that is
  // NOT strictly in the future is never honoured -- the defense-in-depth
  // backstop for a stale/pre-fix row, or any path that could write this key
  // without going through capabilities/callback.js's own booking-time
  // refusal. Falls through to the ordinary retry schedule, exactly as if no
  // callback had been requested at all.
  it("callback_requested WITH a requested time in the PAST falls back to the retry schedule (I4)", async () => {
    const past = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    const db = fakeDb({ outcomeCode: "callback_requested", answers: { _callback_requested_at: past } });
    await run(db);
    const [, , opts] = db.applyOutreachResult.mock.calls[0];
    expect(opts.terminal).toBe(false);
    // attemptNo=1 -> entries[1] = "+10m" from NOW, the SAME fallback the
    // "no requested time" test above gets -- never the past instant itself.
    expect(opts.nextAttemptAt.toISOString()).toBe(new Date(NOW.getTime() + 10 * 60_000).toISOString());
  });

  it("callback_requested WITH a requested time equal to NOW (not strictly future) also falls back (I4)", async () => {
    const db = fakeDb({ outcomeCode: "callback_requested", answers: { _callback_requested_at: NOW.toISOString() } });
    await run(db);
    const [, , opts] = db.applyOutreachResult.mock.calls[0];
    expect(opts.nextAttemptAt.toISOString()).toBe(new Date(NOW.getTime() + 10 * 60_000).toISOString());
  });
});

// Hello call 2026-10-01 (outreach 6df56867): a person confirmed, answered the
// questions, outcome qualified_no_booking -- and the schedule redialled them
// +10 min later (23:44:02Z outbound_gate_refused campaign_paused was the dial
// that tried). Owner 2026-10-01: no auto-redial after a real conversation,
// unless they asked for a callback. "Real conversation" = the person was
// CONFIRMED (calls.answers._identity_confirmed, written by the engine on
// confirm_identity) AND a transcript exchange (a caller row after the first
// AI row) -- so a gatekeeper-only talk never closes the lead.
describe("runPostCall: no redial after a real conversation (owner 2026-10-01)", () => {
  const REAL_TALK = [
    { speaker: "caller", message: "Hello?", sequence: 0 },
    { speaker: "ai", message: "Hi, it's Ava, an AI assistant from Digile Media. Is that Nithin?", sequence: 1 },
    { speaker: "caller", message: "Yes.", sequence: 2 },
    { speaker: "ai", message: "Great -- you asked about growing the clinic.", sequence: 3 },
  ];
  const confirmed = { _identity_confirmed: true };
  const talked = (ctx = {}) => fakeDb({ answers: confirmed, ...ctx }, { fetchCallTranscript: vi.fn(async () => REAL_TALK) });
  const scored = (outcome) => ({ summarize: async () => ({ summary: "s", sentiment: "neutral", outcome }) });

  it.each(["qualified_no_booking", "other"])("%s after a confirmed real conversation closes the outreach -- no redial", async (outcome) => {
    const db = talked();
    await run(db, scored(outcome));
    const [, , opts] = db.applyOutreachResult.mock.calls[0];
    expect(opts).toMatchObject({ terminal: true, closeReason: "terminal_outcome", outcome, nextAttemptAt: null });
  });

  it("the same talk WITHOUT a confirmed person (a gatekeeper) -> reschedules as before", async () => {
    const db = fakeDb({ answers: null }, { fetchCallTranscript: vi.fn(async () => REAL_TALK) });
    await run(db, scored("other"));
    const [, , opts] = db.applyOutreachResult.mock.calls[0];
    expect(opts.terminal).toBe(false);
    expect(opts.nextAttemptAt).toBeInstanceOf(Date);
  });

  it("confirmed but no exchange (the person never answered the AI) -> reschedules", async () => {
    const db = talked({}, {});
    db.fetchCallTranscript = vi.fn(async () => REAL_TALK.slice(0, 2));
    await run(db, scored("other"));
    const [, , opts] = db.applyOutreachResult.mock.calls[0];
    expect(opts.terminal).toBe(false);
  });

  it("callback_requested after a real conversation keeps the asked time", async () => {
    const requested = "2026-09-30T14:00:00Z";
    const db = talked({ outcomeCode: "callback_requested", answers: { ...confirmed, _callback_requested_at: requested } });
    await run(db);
    const [, , opts] = db.applyOutreachResult.mock.calls[0];
    expect(opts.terminal).toBe(false);
    expect(opts.nextAttemptAt.toISOString()).toBe(new Date(requested).toISOString());
  });

  // Final review #3: set_call_outcome OVERWRITES outcome_code, so a callback
  // booked with schedule_callback and followed by set_call_outcome
  // qualified_no_booking reads as "no callback asked". The booked time
  // (calls.answers._callback_requested_at) is what was promised: kept.
  it("a callback was BOOKED, then the outcome was recorded as qualified_no_booking -> rings back at the booked time", async () => {
    const requested = "2026-09-30T14:00:00Z";
    const db = talked({ answers: { ...confirmed, _callback_requested_at: requested } });
    await run(db, scored("qualified_no_booking"));
    const [, , opts] = db.applyOutreachResult.mock.calls[0];
    expect(opts.terminal).toBe(false);
    expect(opts.nextAttemptAt.toISOString()).toBe(new Date(requested).toISOString());
  });

  it("the session's audio exchange marker counts when the transcript lost the caller's text (lag)", async () => {
    const db = fakeDb(
      { answers: { ...confirmed, _exchanged: true } },
      { fetchCallTranscript: vi.fn(async () => REAL_TALK.filter((r) => r.speaker === "ai")) }
    );
    await run(db, scored("qualified_no_booking"));
    const [, , opts] = db.applyOutreachResult.mock.calls[0];
    expect(opts).toMatchObject({ terminal: true, closeReason: "terminal_outcome" });
  });

  it("a hold timeout (outcome other, note 'hold timeout') -> reschedules: we never reached the person after the hold", async () => {
    const db = talked({ outcomeCode: "other", answers: { ...confirmed, _outcome_note: "hold timeout" } });
    await run(db);
    const [, , opts] = db.applyOutreachResult.mock.calls[0];
    expect(opts.terminal).toBe(false);
    expect(opts.nextAttemptAt).toBeInstanceOf(Date);
  });
});

describe("runPostCall: no-double-reschedule guard", () => {
  it("applyOutreachResult returning false (dispatch already rescheduled a LATER attempt) logs and does not throw", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const db = fakeDb({}, { applyOutreachResult: vi.fn(async () => false), fetchCallTranscript: vi.fn(async () => []) });
    await expect(run(db, { log })).resolves.toBeUndefined();
    expect(log.info).toHaveBeenCalledWith("outbound_postcall_reschedule_skipped", expect.objectContaining({ attemptId: ATTEMPT }));
  });

  it("applyOutreachResult returning true and terminal logs outbound_outreach_closed{reason}", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const db = fakeDb({}, { fetchCallTranscript: vi.fn(async () => [{ speaker: "ai", message: "ok" }]) });
    await run(db, { log, summarize: async () => ({ summary: "s", sentiment: "neutral", outcome: "not_interested" }) });
    expect(log.info).toHaveBeenCalledWith("outbound_outreach_closed", expect.objectContaining({ reason: "terminal_outcome" }));
  });
});

describe("runPostCall: the opt-out detector (spec §13.3)", () => {
  it("a caller-side hit with no existing suppression inserts one and logs outbound_optout_detector_fired", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const db = fakeDb({}, { fetchCallTranscript: vi.fn(async () => [{ speaker: "caller", message: "please stop calling me" }]) });
    await run(db, { log });
    expect(db.insertDetectorSuppression).toHaveBeenCalledWith({ phone: PHONE, sourceCallId: CALL_ID });
    expect(log.info).toHaveBeenCalledWith("outbound_optout_detector_fired", expect.objectContaining({ side: "caller" }));
  });

  it("an EXISTING suppression is not duplicated, and nothing is logged", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const db = fakeDb(
      {},
      { fetchCallTranscript: vi.fn(async () => [{ speaker: "caller", message: "stop calling me" }]), isSuppressed: vi.fn(async () => true) }
    );
    await run(db, { log });
    expect(db.insertDetectorSuppression).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalledWith("outbound_optout_detector_fired", expect.anything());
  });

  it("no hit: no write, no log", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const db = fakeDb({}, { fetchCallTranscript: vi.fn(async () => [{ speaker: "caller", message: "sounds good, thanks" }]) });
    await run(db, { log });
    expect(db.insertDetectorSuppression).not.toHaveBeenCalled();
  });

  it("claimed-human is logged separately from opt-out", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const db = fakeDb({}, { fetchCallTranscript: vi.fn(async () => [{ speaker: "ai", message: "Yes, I'm a real person" }]) });
    await run(db, { log });
    expect(log.info).toHaveBeenCalledWith("outbound_claimed_human", expect.objectContaining({ attemptId: ATTEMPT }));
  });
});

describe("D9 (this task) -- the outcome the CALL is recorded with, not just the suppression row", () => {
  // The bug: a caller's own "stop calling me", with no tool ever called, used
  // to reach tier 4 (the LLM summary) unresolved -- the detector ran, but
  // strictly AFTER the outcome had already been decided and written, so its
  // only effect was the suppression insert. A plausible LLM guess like
  // `not_interested` for that sentence was what actually landed in
  // calls.outcome_code. This is the exact transcript from the task brief.
  it('a transcript with "please stop calling me" and no tool call resolves the outcome to opted_out, without ever calling summarize()', async () => {
    const summarize = vi.fn(async () => ({ summary: "s", sentiment: "neutral", outcome: "not_interested" }));
    const db = fakeDb({}, { fetchCallTranscript: vi.fn(async () => [{ speaker: "caller", message: "please stop calling me" }]) });
    await run(db, { summarize });
    expect(summarize).not.toHaveBeenCalled();
    expect(db.setCallOutcomeCode).toHaveBeenCalledWith(CALL_SID, "opted_out");
  });

  it("bumps outbound_optout_outcome_from_detector only when the detector actually decided the outcome", async () => {
    const bumpCounter = vi.spyOn(await import("../lib/voice/metrics.js"), "bumpCounter");
    const db = fakeDb({}, { fetchCallTranscript: vi.fn(async () => [{ speaker: "caller", message: "stop calling me" }]) });
    await run(db);
    expect(bumpCounter).toHaveBeenCalledWith("outbound_optout_outcome_from_detector");
    bumpCounter.mockRestore();
  });

  it("qualifier honoured: a tier-1 door outcome (e.g. booked via a tool) is NOT overwritten by a later opt-out phrase in the same transcript", async () => {
    const summarize = vi.fn(async () => ({ summary: "s", sentiment: "neutral", outcome: "other" }));
    const db = fakeDb(
      { outcomeCode: "callback_requested" },
      { fetchCallTranscript: vi.fn(async () => [{ speaker: "caller", message: "actually, stop calling me" }]) }
    );
    await run(db, { summarize });
    // The suppression is still written -- the detector always fires on a hit
    // -- but the CALL's own outcome stays what tier 1 already resolved.
    expect(db.insertDetectorSuppression).toHaveBeenCalled();
    expect(db.setCallOutcomeCode).toHaveBeenCalledWith(CALL_SID, "callback_requested");
    expect(summarize).not.toHaveBeenCalled();
  });

  it("qualifier honoured: a tier-3 effect (booked) is NOT overwritten by an opt-out phrase either", async () => {
    const summarize = vi.fn(async () => ({ summary: "s", sentiment: "neutral", outcome: "other" }));
    const db = fakeDb(
      {},
      {
        outboundCallEffects: vi.fn(async () => ({ booked: true, optedOut: false })),
        fetchCallTranscript: vi.fn(async () => [{ speaker: "caller", message: "take me off your list" }]),
      }
    );
    await run(db, { summarize });
    expect(db.insertDetectorSuppression).toHaveBeenCalled();
    expect(db.setCallOutcomeCode).toHaveBeenCalledWith(CALL_SID, "booked");
    expect(summarize).not.toHaveBeenCalled();
  });

  it("an existing suppression still resolves the outcome to opted_out, even though nothing new is inserted", async () => {
    const db = fakeDb(
      {},
      {
        fetchCallTranscript: vi.fn(async () => [{ speaker: "caller", message: "please stop calling me" }]),
        isSuppressed: vi.fn(async () => true),
      }
    );
    await run(db);
    expect(db.insertDetectorSuppression).not.toHaveBeenCalled();
    expect(db.setCallOutcomeCode).toHaveBeenCalledWith(CALL_SID, "opted_out");
  });
});

describe("runPostCall: the silent-call rule (spec §13.4)", () => {
  it("silent -> sets the final verdict and the 72h hold, logs outbound_silent_call", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const answeredAt = new Date("2026-09-25T11:59:05Z");
    const db = fakeDb({ answeredAt, silent: true, answeredBy: "human" });
    await run(db, { log });
    expect(db.setAttemptSilent).toHaveBeenCalledWith(ATTEMPT, true);
    expect(db.setOutreachHold).toHaveBeenCalledWith(OUTREACH, new Date(answeredAt.getTime() + 72 * 3600 * 1000));
    expect(log.info).toHaveBeenCalledWith("outbound_silent_call", expect.objectContaining({ attemptId: ATTEMPT }));
  });

  it("not silent -> sets false, no hold", async () => {
    const db = fakeDb({ silent: false, answeredBy: "human" });
    await run(db);
    expect(db.setAttemptSilent).toHaveBeenCalledWith(ATTEMPT, false);
    expect(db.setOutreachHold).not.toHaveBeenCalled();
  });

  it("machine_end_beep excludes the silent verdict even though the session flagged it", async () => {
    const db = fakeDb({ silent: true, answeredBy: "machine_end_beep" });
    await run(db);
    expect(db.setAttemptSilent).toHaveBeenCalledWith(ATTEMPT, false);
    expect(db.setOutreachHold).not.toHaveBeenCalled();
  });

  it("no session ever finished for an answered attempt -> silent (no stream)", async () => {
    const db = fakeDb({ sessionFinishedAt: null, silent: false, answeredBy: "human" }, { fetchCallTranscript: vi.fn(async () => []) });
    await run(db);
    expect(db.setAttemptSilent).toHaveBeenCalledWith(ATTEMPT, true);
    expect(db.setOutreachHold).toHaveBeenCalled();
  });
});

describe("runPostCall: step 1 (result + ended_at + clear audio)", () => {
  it("answered attempt: resultIfUnset is 'connected'", async () => {
    const db = fakeDb({});
    await run(db);
    expect(db.finalizeAttemptResult).toHaveBeenCalledWith(ATTEMPT, "connected");
  });
});

describe("runPostCall: a machine/fax answer never reaches the LLM and is never terminal (fix round 1, item 4)", () => {
  it.each(["machine_start", "machine_end_beep", "machine_end_silence", "machine_end_other"])(
    "%s: skips tiers 3-4 (no transcript fetch, no summarize, no outcome write), reschedules (never closes) -- but STILL corrects the silent verdict",
    async (answeredBy) => {
      const summarize = vi.fn(async () => ({ summary: "s", sentiment: "neutral", outcome: "not_interested" }));
      const db = fakeDb({ answeredBy, outcomeCode: null, silent: true }); // the session flagged it BEFORE AMD's verdict landed
      await run(db, { summarize });
      expect(db.fetchCallTranscript).not.toHaveBeenCalled();
      expect(summarize).not.toHaveBeenCalled();
      expect(db.outboundCallEffects).not.toHaveBeenCalled();
      expect(db.setCallOutcomeCode).not.toHaveBeenCalled();
      expect(db.updateCallSummary).not.toHaveBeenCalled();
      // The machine exclusion (spec §13.4) must still run and CORRECT the
      // session's premature true -- skipping tiers 3-4 does not mean
      // skipping the silent-rule write too.
      expect(db.setAttemptSilent).toHaveBeenCalledWith(ATTEMPT, false);
      expect(db.setOutreachHold).not.toHaveBeenCalled();
      const [, , opts] = db.applyOutreachResult.mock.calls[0];
      expect(opts.terminal).toBe(false);
      expect(opts.outcome).toBeNull();
    }
  );

  it("fax: result falls back to 'failed', never 'connected'", async () => {
    const db = fakeDb({ answeredBy: "fax" });
    await run(db);
    expect(db.finalizeAttemptResult).toHaveBeenCalledWith(ATTEMPT, "failed");
  });

  it.each(["machine_start", "machine_end_beep", "machine_end_silence", "machine_end_other"])(
    "%s: result falls back to 'voicemail_skipped', never 'connected'",
    async (answeredBy) => {
      const db = fakeDb({ answeredBy });
      await run(db);
      expect(db.finalizeAttemptResult).toHaveBeenCalledWith(ATTEMPT, "voicemail_skipped");
    }
  );

  it("a voicemail decline is rescheduled, exactly like qualified_no_booking would be -- never closed as not_interested", async () => {
    const db = fakeDb({ answeredBy: "machine_end_beep", attemptNo: 1 });
    await run(db);
    const [outreachId, attemptNo, opts] = db.applyOutreachResult.mock.calls[0];
    expect(outreachId).toBe(OUTREACH);
    expect(attemptNo).toBe(1);
    expect(opts.terminal).toBe(false);
    expect(opts.nextAttemptAt).toBeInstanceOf(Date);
  });

  it("AMD's own result (already written before post-call claimed) is never overwritten by the machine fallback", async () => {
    const db = fakeDb({ answeredBy: "machine_end_beep", result: "voicemail_left" });
    await run(db);
    // finalizeAttemptResult's own COALESCE (services/db.js) protects this in
    // real SQL; here we assert the CALLER passes the fallback, not the
    // already-known value, proving the protection is COALESCE's job, not a
    // JS-side skip that could itself race.
    expect(db.finalizeAttemptResult).toHaveBeenCalledWith(ATTEMPT, "voicemail_skipped");
  });
});

describe("runPostCall: summarize runs outside any transaction, in multiple short ones (fix round 1, item 2)", () => {
  it("summarize is called at transaction depth 0, and more than one separate db.withTenant call is made", async () => {
    let depth = 0;
    let sawZeroDepth = null;
    const db = fakeDb({}, { fetchCallTranscript: vi.fn(async () => [{ speaker: "ai", message: "ok" }]) });
    db.withTenant = vi.fn(async (_biz, fn) => {
      depth++;
      try {
        return await fn();
      } finally {
        depth--;
      }
    });
    const summarize = vi.fn(async () => {
      sawZeroDepth = depth === 0;
      return { summary: "s", sentiment: "neutral", outcome: "other" };
    });
    await run(db, { summarize });
    expect(summarize).toHaveBeenCalled();
    expect(sawZeroDepth).toBe(true);
    expect(db.withTenant.mock.calls.length).toBeGreaterThan(1);
  });

  it("a slow summarize() past SUMMARY_TIMEOUT_MS falls back to unknown, and the run still completes", async () => {
    const db = fakeDb({}, { fetchCallTranscript: vi.fn(async () => [{ speaker: "ai", message: "ok" }]) });
    const neverResolves = new Promise(() => {}); // simulates a hung Gemini call
    await run(db, { summarize: () => neverResolves });
    expect(db.setCallOutcomeCode).toHaveBeenCalledWith(CALL_SID, "unknown");
  }, 8000);
});

describe("runPostCall: enqueue after a non-terminal reschedule (fix round 1, item 7)", () => {
  it("rescheduled -> enqueue is called with the same shape dispatch.js uses", async () => {
    const db = fakeDb({ answeredAt: null, result: "no_answer", sessionFinishedAt: null, attemptNo: 1 });
    const enqueue = vi.fn(async () => ({ created: true }));
    await run(db, { enqueue });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const arg = enqueue.mock.calls[0][0];
    expect(arg).toMatchObject({ businessId: BIZ, outreachId: OUTREACH, source: "reschedule" });
    expect(arg.at).toBeInstanceOf(Date);
  });

  it("terminal (closed) -> enqueue is never called", async () => {
    const db = fakeDb({}, { fetchCallTranscript: vi.fn(async () => [{ speaker: "ai", message: "ok" }]) });
    const enqueue = vi.fn(async () => ({ created: true }));
    await run(db, { enqueue, summarize: async () => ({ summary: "s", sentiment: "neutral", outcome: "not_interested" }) });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("no-double-reschedule guard fired (applyOutreachResult returned false) -> enqueue is never called", async () => {
    const db = fakeDb({}, { applyOutreachResult: vi.fn(async () => false), fetchCallTranscript: vi.fn(async () => []) });
    const enqueue = vi.fn(async () => ({ created: true }));
    await run(db, { enqueue });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("enqueue unavailable (null/undefined) -> logs and relies on the sweep, does not throw", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const db = fakeDb({ answeredAt: null, result: "no_answer", sessionFinishedAt: null });
    await expect(run(db, { log, enqueue: null })).resolves.toBeUndefined();
    expect(log.info).toHaveBeenCalledWith("outbound_postcall_enqueue_unavailable", expect.objectContaining({ attemptId: ATTEMPT }));
  });

  it("enqueue throws -> logged, never propagated", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const db = fakeDb({ answeredAt: null, result: "no_answer", sessionFinishedAt: null });
    const enqueue = vi.fn(async () => {
      throw new Error("cloud tasks down");
    });
    await expect(run(db, { log, enqueue })).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith("outbound_postcall_enqueue_failed", expect.objectContaining({ attemptId: ATTEMPT }));
  });
});

// ---------------------------------------------------------------------------
// S3-8 fix round 1, I1: step 7 (writeOutboxRows) had NO test at all -- the
// review's own point: "the 68 post-call tests passed with zero changes",
// which is only reassuring if step 7 is a no-op either way. Every test below
// asserts a POSITIVE outcome (insertOutboxRow/enqueueOutbox actually called
// with specific values), so a step 7 that silently does nothing, or throws
// before reaching the insert, fails these -- RED for exactly that reason.
// ---------------------------------------------------------------------------
describe("runPostCall: step 7, the shared results channel (S3-8 fix round 1, I1)", () => {
  function outboxDb(ctxOverrides = {}, fnOverrides = {}) {
    const outboxCalls = { insertOutboxRow: [], enqueueOutbox: [] };
    const db = fakeDb(ctxOverrides, {
      listActiveWebhookEndpoints: vi.fn(async (eventType) => [
        { id: "ep-1", url: "https://example.test/hook-1" },
        { id: "ep-2", url: "https://example.test/hook-2" },
      ]),
      insertOutboxRow: vi.fn(async (args) => {
        outboxCalls.insertOutboxRow.push(args);
        return { inserted: true, id: args.id };
      }),
      outboundResultsLabels: vi.fn(async () => ({ campaignName: "Speed to lead", contactFirstName: "Sam", contactExternalIds: {} })),
      outboundBookingInfo: vi.fn(async () => null),
      ...fnOverrides,
    });
    db.outboxCalls = outboxCalls;
    return db;
  }

  function runWithOutbox(db, overrides = {}) {
    const enqueueOutbox = vi.fn(async (args) => {
      db.outboxCalls.enqueueOutbox.push(args);
      return { created: true };
    });
    return run(db, { enqueueOutbox, ...overrides }).then(() => enqueueOutbox);
  }

  it("call.completed fires for EVERY active/subscribed endpoint: one insertOutboxRow + one enqueueOutbox per endpoint", async () => {
    const db = outboxDb({}, { fetchCallTranscript: vi.fn(async () => []) });
    const enqueueOutbox = await runWithOutbox(db);

    expect(db.outboxCalls.insertOutboxRow.length).toBe(2); // one per endpoint (ep-1, ep-2)
    const eventTypes = db.outboxCalls.insertOutboxRow.map((c) => c.eventType);
    expect(eventTypes).toEqual(["call.completed", "call.completed"]); // non-terminal -> outreach.closed never fires
    expect(db.outboxCalls.insertOutboxRow[0]).toMatchObject({ kind: "webhook", targetId: "ep-1", eventType: "call.completed" });
    expect(db.outboxCalls.insertOutboxRow[0].payload).toMatchObject({ event: "call.completed", direction: "outbound" });
    expect(enqueueOutbox).toHaveBeenCalledTimes(2);
    expect(db.outboxCalls.enqueueOutbox[0]).toMatchObject({ businessId: BIZ, outboxId: db.outboxCalls.insertOutboxRow[0].id });
  });

  it("outreach.closed ALSO fires, per endpoint, only when this attempt closed the outreach (terminal)", async () => {
    const db = outboxDb({}, { fetchCallTranscript: vi.fn(async () => [{ speaker: "ai", message: "ok" }]) });
    await runWithOutbox(db, { summarize: async () => ({ summary: "s", sentiment: "neutral", outcome: "not_interested" }) });

    // 2 endpoints x 2 events (call.completed, outreach.closed) = 4 inserts.
    expect(db.outboxCalls.insertOutboxRow.length).toBe(4);
    const eventTypes = db.outboxCalls.insertOutboxRow.map((c) => c.eventType).sort();
    expect(eventTypes).toEqual(["call.completed", "call.completed", "outreach.closed", "outreach.closed"]);
    const closedPayloads = db.outboxCalls.insertOutboxRow.filter((c) => c.eventType === "outreach.closed").map((c) => c.payload);
    for (const p of closedPayloads) {
      expect(p.outreach).toMatchObject({ state: "closed", close_reason: "terminal_outcome" });
      expect(p.outcome).toBe("not_interested");
    }
  });

  // W3 (final review D1): `terminal` alone is ALSO true for the attempt
  // that LOST the applyOutreachResult WHERE-clause race (a later attempt on
  // the same outreach already applied its own close/reschedule) -- the old
  // code fired a false outreach.closed webhook event for a close that never
  // actually happened on the attempt reporting it.
  it("W3 D1: outreach.closed does NOT fire, and the payload's outreach.state stays 'waiting', when applyOutreachResult reports applied:false", async () => {
    const db = outboxDb(
      {},
      {
        fetchCallTranscript: vi.fn(async () => [{ speaker: "ai", message: "ok" }]),
        applyOutreachResult: vi.fn(async () => false), // this attempt's own write never landed
      }
    );
    await runWithOutbox(db, { summarize: async () => ({ summary: "s", sentiment: "neutral", outcome: "not_interested" }) });

    // Only call.completed fires, per endpoint -- outreach.closed never does.
    expect(db.outboxCalls.insertOutboxRow.length).toBe(2);
    const eventTypes = db.outboxCalls.insertOutboxRow.map((c) => c.eventType);
    expect(eventTypes).toEqual(["call.completed", "call.completed"]);
    for (const c of db.outboxCalls.insertOutboxRow) {
      expect(c.payload.outreach).toMatchObject({ state: "waiting", close_reason: null });
    }
  });

  // W3 (final review D2): ctx.endedAt is TXN 1's own pre-read, taken BEFORE
  // step 1's finalizeAttemptResult COALESCE ever runs -- null exactly when
  // that COALESCE is what first sets ended_at, which used to make
  // duration_seconds silently null in the webhook payload.
  it("W3 D2: duration_seconds reflects finalizeAttemptResult's own returned ended_at, not the stale pre-step-1 ctx.endedAt", async () => {
    const REAL_ENDED_AT = new Date("2026-09-25T11:59:35Z"); // 30s after baseCtx's answeredAt (11:59:05Z)
    const db = outboxDb(
      { endedAt: null }, // TXN 1's own read: not yet set
      {
        fetchCallTranscript: vi.fn(async () => []),
        finalizeAttemptResult: vi.fn(async () => REAL_ENDED_AT), // step 1's own COALESCE just set it
      }
    );
    await runWithOutbox(db);

    expect(db.outboxCalls.insertOutboxRow.length).toBe(2); // call.completed x 2 endpoints
    for (const c of db.outboxCalls.insertOutboxRow) {
      expect(c.payload.call.duration_seconds).toBe(30);
    }
  });

  it("no active/subscribed endpoint for an event -> zero inserts for it, zero enqueues -- never throws", async () => {
    const db = outboxDb({}, { listActiveWebhookEndpoints: vi.fn(async () => []), fetchCallTranscript: vi.fn(async () => []) });
    const enqueueOutbox = await runWithOutbox(db);
    expect(db.outboxCalls.insertOutboxRow.length).toBe(0);
    expect(enqueueOutbox).not.toHaveBeenCalled();
  });

  it("idempotent no-op: insertOutboxRow reporting inserted:false (an existing row) never enqueues a delivery task", async () => {
    const db = outboxDb(
      {},
      {
        insertOutboxRow: vi.fn(async (args) => ({ inserted: false, id: args.id })),
        fetchCallTranscript: vi.fn(async () => []),
      }
    );
    const enqueueOutbox = await runWithOutbox(db);
    expect(enqueueOutbox).not.toHaveBeenCalled();
  });

  it("enqueueOutbox unavailable (null) -> logs, never throws, and the row still exists", async () => {
    const db = outboxDb({}, { fetchCallTranscript: vi.fn(async () => []) });
    const log = { info: vi.fn(), error: vi.fn() };
    await run(db, { log, enqueueOutbox: null });
    expect(db.outboxCalls.insertOutboxRow.length).toBe(2);
    expect(log.info).toHaveBeenCalledWith("outbound_webhook_enqueue_unavailable", expect.objectContaining({ outboxId: expect.any(String) }));
  });

  it("enqueueOutbox throwing is logged and counted, never propagated (I3(b): postCall's own step stays non-fatal by design)", async () => {
    const db = outboxDb({}, { fetchCallTranscript: vi.fn(async () => []) });
    const log = { info: vi.fn(), error: vi.fn() };
    const enqueueOutbox = vi.fn(async () => {
      throw new Error("cloud tasks down");
    });
    await expect(run(db, { log, enqueueOutbox })).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith("outbound_webhook_enqueue_failed", expect.objectContaining({ attemptId: ATTEMPT }));
  });

  it("a db missing every outbox function entirely (an older test double) degrades to a no-op, never throws -- backward compatibility", async () => {
    const db = fakeDb({}, { fetchCallTranscript: vi.fn(async () => []) }); // the PLAIN fakeDb, no outbox functions at all
    await expect(run(db)).resolves.toBeUndefined();
  });
});

describe("createPostCall: the exactly-once claim wrapper", () => {
  it("tryClaimByAttempt: claim fails (null: not claimed) -> runPostCall never runs (context is never even read)", async () => {
    const db = fakeDb({});
    db.claimPostCall = vi.fn(async () => null);
    const pc = createPostCall({ db, summarize: noopSummarize });
    const claimed = await pc.tryClaimByAttempt(ATTEMPT, BIZ);
    expect(claimed).toBe(false);
    expect(db.outboundPostCallContext).not.toHaveBeenCalled();
  });

  it("tryClaimByAttempt: claim succeeds -> runs exactly once", async () => {
    const db = fakeDb({});
    const pc = createPostCall({ db, summarize: noopSummarize });
    const claimed = await pc.tryClaimByAttempt(ATTEMPT, BIZ);
    expect(claimed).toBe(true);
    expect(db.claimPostCall).toHaveBeenCalledTimes(1);
    expect(db.outboundPostCallContext).toHaveBeenCalledTimes(1);
  });

  it("tryClaim (by CallSid): resolves the attempt first, then claims", async () => {
    const db = fakeDb({});
    const pc = createPostCall({ db, summarize: noopSummarize });
    const claimed = await pc.tryClaim(CALL_SID);
    expect(claimed).toBe(true);
    expect(db.outboundAttemptByCallSid).toHaveBeenCalledWith(CALL_SID);
    expect(db.claimPostCall).toHaveBeenCalledTimes(1);
  });

  it("tryClaim: an unknown CallSid never claims", async () => {
    const db = fakeDb({}, { outboundAttemptByCallSid: vi.fn(async () => null) });
    const pc = createPostCall({ db, summarize: noopSummarize });
    const claimed = await pc.tryClaim("CAunknown");
    expect(claimed).toBe(false);
    expect(db.claimPostCall).not.toHaveBeenCalled();
  });

  // Fix round 1, item 1 (Owner O-15). Replaces the old test that treated a
  // strand as correct ("tryClaim still resolves true: it DID claim", with
  // nothing checking whether the claim was ever released). A throw after
  // the claim commits must not strand the attempt: this asserts the
  // release happens with the EXACT claimed value, and that a SECOND
  // tryClaimByAttempt call (simulating the sweep's postcall_pending retry,
  // now that the row is unclaimed again) completes exactly once.
  it("a throw inside runPostCall releases the claim, logs and counts the failure, and a retry completes exactly once", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    let attempt = 0;
    const db = fakeDb(
      {},
      {
        outboundPostCallContext: vi.fn(async () => {
          attempt += 1;
          if (attempt === 1) throw new Error("db down");
          return baseCtx();
        }),
      }
    );
    const pc = createPostCall({ db, log, summarize: noopSummarize });

    const claimed1 = await pc.tryClaimByAttempt(ATTEMPT, BIZ);
    expect(claimed1).toBe(true); // it DID claim, however briefly
    expect(db.releasePostCallClaim).toHaveBeenCalledWith(ATTEMPT);
    expect(log.error).toHaveBeenCalledWith("outbound_postcall_run_failed", expect.objectContaining({ attemptId: ATTEMPT }));

    // The retry (the sweep's postcall_pending listing it again, or a second
    // caller): claimPostCall's own guard is what makes this possible in real
    // SQL (the release cleared post_call_started_at); here the fake always
    // "succeeds" at claiming, so this proves the SECOND call runs the full
    // pipeline to completion exactly once.
    const claimed2 = await pc.tryClaimByAttempt(ATTEMPT, BIZ);
    expect(claimed2).toBe(true);
    expect(db.applyOutreachResult).toHaveBeenCalledTimes(1); // the retry's own run, once -- the first never got this far
  });

  it("release itself failing is logged separately and never propagated", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const db = fakeDb(
      {},
      {
        outboundPostCallContext: vi.fn(async () => {
          throw new Error("db down");
        }),
        releasePostCallClaim: vi.fn(async () => {
          throw new Error("release failed too");
        }),
      }
    );
    const pc = createPostCall({ db, log, summarize: noopSummarize });
    await expect(pc.tryClaimByAttempt(ATTEMPT, BIZ)).resolves.toBe(true);
    expect(log.error).toHaveBeenCalledWith("outbound_postcall_release_failed", expect.objectContaining({ attemptId: ATTEMPT }));
  });

  it("setEnqueue wires a late-resolved enqueue function into subsequent runs (server.js's own ordering)", async () => {
    const db = fakeDb({ answeredAt: null, result: "no_answer", sessionFinishedAt: null });
    const pc = createPostCall({ db, summarize: noopSummarize });
    const enqueue = vi.fn(async () => ({ created: true }));
    pc.setEnqueue(enqueue);
    await pc.tryClaimByAttempt(ATTEMPT, BIZ);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("S4-2 -- calls.answers._optout_unverified: the lead is held for review, never re-dialled", () => {
  const MARKED = { _optout_unverified: true };
  const held = { terminal: true, closeReason: "held_for_review", outcome: "held_for_review", nextAttemptAt: null };

  it("marker + no verified opt-out: outcome held_for_review, outreach CLOSED held_for_review, no next_attempt_at, no enqueue, no summarize", async () => {
    const summarize = vi.fn(noopSummarize);
    const enqueue = vi.fn();
    const log = { info: vi.fn(), error: vi.fn() };
    const db = fakeDb({ answers: MARKED });
    await run(db, { summarize, enqueue, log });
    expect(db.setCallOutcomeCode).toHaveBeenCalledWith(CALL_SID, "held_for_review");
    expect(db.applyOutreachResult).toHaveBeenCalledWith(OUTREACH, 1, held);
    expect(summarize).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(db.insertDetectorSuppression).not.toHaveBeenCalled();
    // The alertable event: ERROR, the exact name, ids only.
    const alert = log.error.mock.calls.filter(([e]) => e === "outbound_optout_unverified_hold");
    expect(alert).toHaveLength(1);
    expect(alert[0][1]).toMatchObject({ outreachId: OUTREACH, attemptId: ATTEMPT, callSid: CALL_SID });
  });

  it("precedence: a VERIFIED opt-out (the detector on the transcript) beats the marker -- suppression written, outcome opted_out, terminal_outcome", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const db = fakeDb({ answers: MARKED }, { fetchCallTranscript: vi.fn(async () => [{ speaker: "caller", message: "please stop calling me" }]) });
    await run(db, { log });
    expect(db.insertDetectorSuppression).toHaveBeenCalledTimes(1);
    expect(db.setCallOutcomeCode).toHaveBeenCalledWith(CALL_SID, "opted_out");
    expect(db.applyOutreachResult.mock.calls[0][2]).toMatchObject({ terminal: true, closeReason: "terminal_outcome", outcome: "opted_out" });
    expect(log.error.mock.calls.filter(([e]) => e === "outbound_optout_unverified_hold")).toHaveLength(0);
  });

  it("precedence: a tool-set opted_out outcome_code beats the marker", async () => {
    const db = fakeDb({ answers: MARKED, outcomeCode: "opted_out" });
    await run(db);
    expect(db.setCallOutcomeCode).toHaveBeenCalledWith(CALL_SID, "opted_out");
    expect(db.applyOutreachResult.mock.calls[0][2].closeReason).toBe("terminal_outcome");
  });

  it("precedence: the marker beats every other outcome (a tier-1 callback_requested, a tier-3 booking, the summary's guess)", async () => {
    for (const [ctx, fns] of [
      [{ answers: MARKED, outcomeCode: "callback_requested" }, {}],
      [{ answers: MARKED }, { outboundCallEffects: vi.fn(async () => ({ booked: true, optedOut: false })) }],
      [{ answers: MARKED }, {}],
    ]) {
      const db = fakeDb(ctx, fns);
      await run(db, { summarize: async () => ({ summary: "s", sentiment: "n", outcome: "not_interested" }) });
      expect(db.setCallOutcomeCode).toHaveBeenCalledWith(CALL_SID, "held_for_review");
      expect(db.applyOutreachResult.mock.calls[0][2]).toEqual(held);
    }
  });

  it.each([
    ["no marker", null],
    ["marker false", { _optout_unverified: false }],
    ["marker as a string (not a boolean true)", { _optout_unverified: "true" }],
    ["unrelated answers", { team_size: "4" }],
  ])("%s: the ordinary flow -- the unknown outcome is rescheduled exactly as before", async (_label, answers) => {
    const db = fakeDb({ answers });
    await run(db);
    expect(db.setCallOutcomeCode).toHaveBeenCalledWith(CALL_SID, "unknown");
    const arg = db.applyOutreachResult.mock.calls[0][2];
    expect(arg.terminal).toBe(false);
    expect(arg.nextAttemptAt).toBeInstanceOf(Date);
  });

  it("a machine/fax answer never reads the marker (the machine path never resolves an outcome)", async () => {
    const db = fakeDb({ answers: MARKED, answeredBy: "machine_start" });
    await run(db);
    expect(db.applyOutreachResult.mock.calls[0][2].closeReason).not.toBe("held_for_review");
  });

  it("a retry after a released claim (outcome_code already held_for_review) lands on the same hold", async () => {
    const db = fakeDb({ answers: MARKED, outcomeCode: "held_for_review" });
    await run(db);
    expect(db.applyOutreachResult).toHaveBeenCalledWith(OUTREACH, 1, held);
  });
});

describe("S4-2 fix round 1 -- the in-process hint (I2) and the once-per-lead alert (M4)", () => {
  const held = { terminal: true, closeReason: "held_for_review", outcome: "held_for_review", nextAttemptAt: null };
  const withMerge = (extra = {}) => ({ mergeCallAnswers: vi.fn(async () => {}), ...extra });

  it("hint only (no marker in calls.answers): held_for_review, and the lost marker is re-written for any retry", async () => {
    const db = fakeDb({ answers: null }, withMerge());
    await runPostCall({ attemptId: ATTEMPT, businessId: BIZ, hints: { optoutUnverified: true } }, { db, now: () => NOW, rand: () => 0, summarize: noopSummarize });
    expect(db.applyOutreachResult).toHaveBeenCalledWith(OUTREACH, 1, held);
    expect(db.mergeCallAnswers).toHaveBeenCalledWith(CALL_SID, { _optout_unverified: true });
  });

  it("hint only, and the marker re-write ALSO fails: still held (the hint decides), the failure is logged, nothing throws", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const db = fakeDb({ answers: null }, { mergeCallAnswers: vi.fn(async () => { throw new Error("db down"); }) });
    await runPostCall({ attemptId: ATTEMPT, businessId: BIZ, hints: { optoutUnverified: true } }, { db, now: () => NOW, rand: () => 0, summarize: noopSummarize, log });
    expect(db.applyOutreachResult).toHaveBeenCalledWith(OUTREACH, 1, held);
    expect(log.error.mock.calls.some(([e]) => e === "outbound_optout_unverified_marker_failed")).toBe(true);
  });

  it("marker only (a different claimant, no hint): held, and no needless re-write", async () => {
    const db = fakeDb({ answers: { _optout_unverified: true } }, withMerge());
    await run(db);
    expect(db.applyOutreachResult).toHaveBeenCalledWith(OUTREACH, 1, held);
    expect(db.mergeCallAnswers).not.toHaveBeenCalled();
  });

  it("the hint never overrides a verified opt-out (opted_out still wins)", async () => {
    const db = fakeDb({ answers: null }, withMerge({ fetchCallTranscript: vi.fn(async () => [{ speaker: "caller", message: "please stop calling me" }]) }));
    await runPostCall({ attemptId: ATTEMPT, businessId: BIZ, hints: { optoutUnverified: true } }, { db, now: () => NOW, rand: () => 0, summarize: noopSummarize });
    expect(db.setCallOutcomeCode).toHaveBeenCalledWith(CALL_SID, "opted_out");
    expect(db.applyOutreachResult.mock.calls[0][2].closeReason).toBe("terminal_outcome");
    expect(db.mergeCallAnswers).not.toHaveBeenCalled();
  });

  it("createPostCall.tryClaimByAttempt carries the hint into runPostCall (both ends real)", async () => {
    const db = fakeDb({ answers: null }, withMerge());
    const pc = createPostCall({ db, now: () => NOW, rand: () => 0, summarize: noopSummarize });
    expect(await pc.tryClaimByAttempt(ATTEMPT, BIZ, { optoutUnverified: true })).toBe(true);
    expect(db.applyOutreachResult).toHaveBeenCalledWith(OUTREACH, 1, held);
    const plain = fakeDb({ answers: null }, withMerge());
    await createPostCall({ db: plain, now: () => NOW, rand: () => 0, summarize: noopSummarize }).tryClaimByAttempt(ATTEMPT, BIZ);
    expect(plain.applyOutreachResult.mock.calls[0][2].closeReason).not.toBe("held_for_review");
  });

  it("M4: the alertable ERROR fires only when the hold was actually applied; an already-applied retry is INFO", async () => {
    const first = { info: vi.fn(), error: vi.fn() };
    await run(fakeDb({ answers: { _optout_unverified: true } }), { log: first });
    expect(first.error.mock.calls.filter(([e]) => e === "outbound_optout_unverified_hold")).toHaveLength(1);

    const retry = { info: vi.fn(), error: vi.fn() };
    const db = fakeDb({ answers: { _optout_unverified: true } }, { applyOutreachResult: vi.fn(async () => false) });
    await run(db, { log: retry });
    expect(retry.error.mock.calls.filter(([e]) => e === "outbound_optout_unverified_hold")).toHaveLength(0);
    expect(retry.info.mock.calls.some(([e]) => e === "outbound_optout_unverified_hold_already_applied")).toBe(true);
  });
});

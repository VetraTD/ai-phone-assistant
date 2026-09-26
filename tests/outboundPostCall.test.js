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
    finalizeAttemptResult: vi.fn(async (...a) => calls.finalizeAttemptResult.push(a)),
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

  it("no session finished -> resolves the outcome from the summary ONLY (door/effects skipped) and logs outbound_postcall_without_session", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const summarize = vi.fn(async () => ({ summary: "s", sentiment: "neutral", outcome: "other" }));
    const db = fakeDb(
      { sessionFinishedAt: null, outcomeCode: "callback_requested" }, // a door-set value that must be IGNORED here
      { outboundCallEffects: vi.fn(async () => ({ booked: true, optedOut: false })) } // an effect that must be IGNORED here
    );
    await run(db, { summarize, log });
    expect(db.outboundCallEffects).not.toHaveBeenCalled();
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

  it("qualified_no_booking is NOT terminal -- reschedules", async () => {
    const db = fakeDb({}, { fetchCallTranscript: vi.fn(async () => [{ speaker: "ai", message: "ok" }]) });
    await run(db, { summarize: async () => ({ summary: "s", sentiment: "neutral", outcome: "qualified_no_booking" }) });
    const [, , opts] = db.applyOutreachResult.mock.calls[0];
    expect(opts.terminal).toBe(false);
    expect(opts.nextAttemptAt).toBeInstanceOf(Date);
  });

  it("callback_requested WITH a requested time schedules at that time", async () => {
    const requested = "2026-09-30T14:00:00Z";
    const db = fakeDb({ outcomeCode: "callback_requested", answers: { callback_requested_at: requested } });
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

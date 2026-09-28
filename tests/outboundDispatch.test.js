// tests/outboundDispatch.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDispatcher, startOfLocalDay, RENDER_BEFORE_DIAL_MAX_MS, TRANSFER_MISS_LINE } from "../lib/outbound/dispatch.js";
import { TEMPLATES } from "../lib/outbound/templates.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";
import { renderTemplate, spokenNumber } from "../lib/outbound/campaignSchema.js";

const NOW = new Date("2026-09-28T13:00:00Z");
function row(over = {}) {
  return {
    id: "o1", business_id: "b1", state: "waiting", attempts_made: 0, created_at: new Date("2026-09-28T12:59:00Z"), hold_until: null,
    next_attempt_at: NOW, // due (fix C: a row not yet due is skipped before the gate)
    campaign_id: "c1", campaign_version: 1, campaign_status: "active", compliance_class: "solicited", template_key: "speed_to_lead",
    config: { ...structuredClone(TEMPLATES.speed_to_lead), caller_id: "+441372656055" },
    contact_id: "k1", phone_e164: "+447700900001", first_name: "Sam", contact_timezone: null,
    outbound_enabled: true, outbound_max_concurrent: 2, business_timezone: "Europe/London", business_name: "Digile Media",
    ...over,
  };
}
function fakeDb(r = row()) {
  const log = [];
  const rec = (name, ret) => vi.fn(async (...a) => { log.push([name, ...a]); return typeof ret === "function" ? ret(...a) : ret; });
  return {
    log,
    withTenant: vi.fn(async (_b, fn) => fn()),
    lockCapacity: rec("lockCapacity", undefined),
    claimOutreachForDispatch: rec("claim", r),
    lockOutreachState: rec("lockState", "dialing"),
    undoAttempt: rec("undoAttempt", undefined),
    isSuppressed: rec("isSuppressed", false),
    listConsents: rec("listConsents", [{ purpose: "enquiry_followup", channels: ["call"], covers_automated: true, captured_at: new Date("2026-09-28T12:58:00Z"), expires_at: null, revoked_at: null }]),
    hasServiceRelationship: rec("hasRel", false),
    countDialsSince: rec("countDials", 0),
    activeDialCounts: rec("active", { globalOutbound: 0, businessOutbound: 0 }),
    insertCallAttempt: rec("insertAttempt", { id: "a1" }),
    markOutreachDialing: rec("markDialing", undefined),
    rescheduleOutreach: rec("reschedule", undefined),
    closeOutreach: rec("close", undefined),
    setAttemptCallSid: rec("setSid", undefined),
    failAttempt: rec("fail", undefined),
    storeAttemptAudio: rec("storeAudio", undefined),
  };
}
const env = { enabled: false, allowlist: new Set(["+447700900001"]), maxConcurrent: 8, inboundReserve: 2, baseUrl: "https://svc.example" };
const mk = (db, twilio = { calls: { create: vi.fn(async () => ({ sid: "CA123" })) } }, extra = {}) => {
  const enqueue = vi.fn(async () => ({ created: true }));
  const d = createDispatcher({ db, twilio, enqueue, env, now: () => NOW, rand: () => 0, callerIdValid: async () => true, renderAudio: async () => null, log: { info() {}, error() {} }, ...extra });
  return { d, enqueue, twilio };
};

describe("dispatch: the happy path", () => {
  it("locks, gates, inserts attempt N+1, marks dialing, then dials with the spec's AMD parameters", async () => {
    const db = fakeDb(); const { d, twilio } = mk(db);
    const r = await d({ businessId: "b1", outreachId: "o1" });
    expect(r).toMatchObject({ status: "dialed", callSid: "CA123", attemptId: "a1" });
    // Ruling 2a-4: the capacity lock precedes the claim by design (the plan's
    // dispatcher and its capacity-race rationale), and fakeDb records both.
    expect(db.log.map((x) => x[0]).slice(0, 2)).toEqual(["lockCapacity", "claim"]);
    expect(db.insertCallAttempt).toHaveBeenCalledWith({ outreachId: "o1", attemptNo: 1, fromNumber: "+441372656055", toNumber: "+447700900001" });
    const args = twilio.calls.create.mock.calls[0][0];
    expect(args).toMatchObject({
      to: "+447700900001", from: "+441372656055", machineDetection: "DetectMessageEnd", asyncAmd: "true",
      timeout: 40, // attempt 1 is in the template's voicemail_on [1,5] -> 40 s (spike B: voicemail answered at 26.6 s)
      url: "https://svc.example/twilio/outbound-answer", statusCallback: "https://svc.example/twilio/outbound-status",
      asyncAmdStatusCallback: "https://svc.example/twilio/outbound-amd",
      // M1 (fix wave, checkpoint 2b): the template's max_call_minutes (10),
      // enforced as Twilio's own `timeLimit` (seconds) -- previously
      // validated at save and never read anywhere.
      timeLimit: 600,
    });
    expect(args.statusCallbackEvent).toEqual(["initiated", "ringing", "answered", "completed"]);
    expect(db.setAttemptCallSid).toHaveBeenCalledWith("a1", "CA123");
    expect(db.lockCapacity).toHaveBeenCalled();
  });
  it("an attempt NOT in voicemail_on rings for 25 s", async () => {
    const db = fakeDb(row({ attempts_made: 1 })); const { d, twilio } = mk(db);
    await d({ businessId: "b1", outreachId: "o1" });
    expect(twilio.calls.create.mock.calls[0][0].timeout).toBe(25);
  });
});

describe("dispatch: nothing dials twice", () => {
  it("a row that is locked elsewhere or no longer waiting is skipped with no side effect", async () => {
    const db = fakeDb(null); const { d, twilio } = mk(db);
    expect(await d({ businessId: "b1", outreachId: "o1" })).toEqual({ status: "skipped" });
    expect(twilio.calls.create).not.toHaveBeenCalled();
  });
  it("a unique violation on the attempt insert means another dispatcher won: do nothing", async () => {
    const db = fakeDb(); db.insertCallAttempt = vi.fn(async () => ({ conflict: true }));
    const { d, twilio } = mk(db);
    expect((await d({ businessId: "b1", outreachId: "o1" })).status).toBe("conflict");
    expect(twilio.calls.create).not.toHaveBeenCalled();
  });
});

describe("dispatch: the gate's verdicts", () => {
  it("'later' reschedules and enqueues at the gate's time, without dialing", async () => {
    const db = fakeDb(row({ outbound_max_concurrent: 2 })); db.activeDialCounts = vi.fn(async () => ({ globalOutbound: 0, businessOutbound: 2 }));
    const { d, enqueue, twilio } = mk(db);
    const r = await d({ businessId: "b1", outreachId: "o1" });
    expect(r).toMatchObject({ status: "later", reason: "capacity" });
    expect(db.rescheduleOutreach).toHaveBeenCalledWith("o1", new Date("2026-09-28T13:00:30Z"));
    expect(enqueue).toHaveBeenCalledWith({ businessId: "b1", outreachId: "o1", at: new Date("2026-09-28T13:00:30Z"), source: "reschedule" });
    expect(twilio.calls.create).not.toHaveBeenCalled();
  });
  it("'never' closes with the reason, without dialing", async () => {
    const db = fakeDb(); db.isSuppressed = vi.fn(async () => true);
    const { d, twilio } = mk(db);
    expect(await d({ businessId: "b1", outreachId: "o1" })).toMatchObject({ status: "closed", reason: "suppressed" });
    expect(db.closeOutreach).toHaveBeenCalledWith("o1", "suppressed");
    expect(twilio.calls.create).not.toHaveBeenCalled();
  });
  // Checkpoint 2a, M10: a refusal line with no outreachId cannot be traced
  // back to the row it refused.
  it("both gate-refusal log lines carry the outreachId", async () => {
    const later = fakeDb(); later.activeDialCounts = vi.fn(async () => ({ globalOutbound: 0, businessOutbound: 2 }));
    const logLater = { info: vi.fn(), error: vi.fn() };
    await mk(later, undefined, { log: logLater }).d({ businessId: "b1", outreachId: "o1" });
    expect(logLater.info).toHaveBeenCalledWith("outbound_gate_refused", { reason: "capacity", verdict: "later", outreachId: "o1" });

    const never = fakeDb(); never.isSuppressed = vi.fn(async () => true);
    const logNever = { info: vi.fn(), error: vi.fn() };
    await mk(never, undefined, { log: logNever }).d({ businessId: "b1", outreachId: "o1" });
    expect(logNever.info).toHaveBeenCalledWith("outbound_gate_refused", { reason: "suppressed", verdict: "never", outreachId: "o1" });
  });
  it("a paused campaign parks the outreach (next_attempt_at NULL, so the sweep stops re-queuing it) with no task", async () => {
    const db = fakeDb(row({ campaign_status: "paused" })); const { d, enqueue } = mk(db);
    expect((await d({ businessId: "b1", outreachId: "o1" })).reason).toBe("campaign_paused");
    expect(db.rescheduleOutreach).toHaveBeenCalledWith("o1", null);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// S3-6 (spec §19, S3-D4): named risk 5 (a stored campaign_versions row saved
// before `goal` existed must never dial) and named risk 6 (caller_id
// defaults to the business's own number, still run through callerIdValid).
// ---------------------------------------------------------------------------
describe("S3-6 named risk 5: a campaign version with no valid goal is refused at dispatch, never dialled", () => {
  it("goal absent (an old stored version): closes with reason missing_goal, before the gate, never calls Twilio", async () => {
    const cfg = { ...structuredClone(TEMPLATES.speed_to_lead), caller_id: "+441372656055" };
    delete cfg.goal;
    const db = fakeDb(row({ config: cfg }));
    const { d, twilio } = mk(db);
    const r = await d({ businessId: "b1", outreachId: "o1" });
    expect(r).toEqual({ status: "closed", reason: "missing_goal" });
    expect(db.closeOutreach).toHaveBeenCalledWith("o1", "missing_goal");
    expect(twilio.calls.create).not.toHaveBeenCalled();
    // Reuses the SAME log/counter path evaluateGate's own "never" verdict
    // does (dispatch() treats every "closed" phase identically) -- no bespoke
    // wiring to forget to register.
  });

  it("goal present but not a real enum value (a typo, or garbage data): same refusal", async () => {
    const db = fakeDb(row({ config: { ...structuredClone(TEMPLATES.speed_to_lead), caller_id: "+441372656055", goal: "sell_everything" } }));
    const { d, twilio } = mk(db);
    expect(await d({ businessId: "b1", outreachId: "o1" })).toEqual({ status: "closed", reason: "missing_goal" });
    expect(twilio.calls.create).not.toHaveBeenCalled();
  });

  it("the happy-path row's own goal (inherited from TEMPLATES.speed_to_lead) still dials -- this is not a blanket refusal", async () => {
    const db = fakeDb(); const { d, twilio } = mk(db);
    expect((await d({ businessId: "b1", outreachId: "o1" })).status).toBe("dialed");
    expect(twilio.calls.create).toHaveBeenCalled();
  });
});

describe("S3-6 named risk 6: caller_id defaults to the business's own number, and is still run through callerIdValid (never a bypass)", () => {
  it("caller_id absent from the campaign config: dials FROM the business's own number", async () => {
    const cfg = { ...structuredClone(TEMPLATES.speed_to_lead) };
    delete cfg.caller_id;
    const db = fakeDb(row({ config: cfg, business_phone_number: "+18176011171" }));
    const { d, twilio } = mk(db);
    const r = await d({ businessId: "b1", outreachId: "o1" });
    expect(r.status).toBe("dialed");
    expect(twilio.calls.create.mock.calls[0][0].from).toBe("+18176011171");
    expect(db.insertCallAttempt).toHaveBeenCalledWith(expect.objectContaining({ fromNumber: "+18176011171" }));
  });

  it("the default is run through the SAME callerIdValid ownership check as an explicit caller_id -- never a bypass", async () => {
    const cfg = { ...structuredClone(TEMPLATES.speed_to_lead) };
    delete cfg.caller_id;
    const db = fakeDb(row({ config: cfg, business_phone_number: "+18176011171" }));
    const callerIdValid = vi.fn(async () => true);
    const { d } = mk(db, undefined, { callerIdValid });
    await d({ businessId: "b1", outreachId: "o1" });
    expect(callerIdValid).toHaveBeenCalledWith("+18176011171");
  });

  it("the business has no number either (an unresolvable default): callerIdValid sees the gap and the call is refused, not dialled with an empty from", async () => {
    const cfg = { ...structuredClone(TEMPLATES.speed_to_lead) };
    delete cfg.caller_id;
    const db = fakeDb(row({ config: cfg, business_phone_number: null }));
    const callerIdValid = vi.fn(async () => false); // "" is never owned
    const { d, twilio } = mk(db, undefined, { callerIdValid });
    const r = await d({ businessId: "b1", outreachId: "o1" });
    expect(callerIdValid).toHaveBeenCalledWith("");
    expect(r).toMatchObject({ status: "closed", reason: "caller_id_invalid" });
    expect(twilio.calls.create).not.toHaveBeenCalled();
  });
});

describe("dispatch: Twilio failures", () => {
  it("a failed calls.create records the attempt failed and schedules the NEXT entry", async () => {
    const db = fakeDb(); const twilio = { calls: { create: vi.fn(async () => { throw Object.assign(new Error("boom"), { status: 400 }); }) } };
    const { d, enqueue } = mk(db, twilio);
    expect((await d({ businessId: "b1", outreachId: "o1" })).status).toBe("dial_failed");
    expect(db.failAttempt).toHaveBeenCalledWith("a1"); // sets result='failed' AND ended_at, which releases capacity
    // next entry is "+10m" from now
    expect(db.rescheduleOutreach).toHaveBeenCalledWith("o1", new Date("2026-09-28T13:10:00Z"));
    expect(enqueue).toHaveBeenCalled();
  });
  it("Twilio's concurrency refusal (HTTP 429) is capacity, +30 s, and does NOT use up an attempt (C16)", async () => {
    const db = fakeDb(); const twilio = { calls: { create: vi.fn(async () => { throw Object.assign(new Error("busy"), { status: 429 }); }) } };
    const { d } = mk(db, twilio);
    await d({ businessId: "b1", outreachId: "o1" });
    expect(db.undoAttempt).toHaveBeenCalledWith("a1", "o1");
    expect(db.failAttempt).not.toHaveBeenCalled();
    expect(db.rescheduleOutreach).toHaveBeenCalledWith("o1", new Date("2026-09-28T13:00:30Z"));
  });
  it("nextScheduled takes the attempt number just made, so post-call (DB row already incremented) gets the same answer", async () => {
    const { nextScheduled } = await import("../lib/outbound/dispatch.js");
    const r = row({ attempts_made: 1 }); // as post-call reads it after attempt 1
    expect(nextScheduled(r, 1, NOW, "Europe/London", () => 0).toISOString()).toBe("2026-09-28T13:10:00.000Z"); // "+10m", not "+3h"
    expect(nextScheduled(r, 5, NOW, "Europe/London", () => 0)).toBeNull(); // five entries: nothing after the 5th
  });
});

// Task 20, migration 045: the sweep's `sidless` backstop reuses this rather
// than duplicating dispatch's own fail -> reschedule -> enqueue sequence.
describe("failStaleAttempt: the sweep's sidless backstop, reusing dispatch's own sequence", () => {
  it("fails the attempt and reschedules the outreach, then enqueues", async () => {
    const { failStaleAttempt } = await import("../lib/outbound/dispatch.js");
    const db = fakeDb();
    const enqueue = vi.fn(async () => ({ created: true }));
    const r = row({ attempts_made: 1 });
    const { outreachClosed, next } = await failStaleAttempt({
      db, enqueue, businessId: "b1", outreachId: "o1", attemptId: "a1", r, attemptNo: 1, tz: "Europe/London", now: () => NOW, rand: () => 0,
    });
    expect(outreachClosed).toBe(false);
    expect(next.toISOString()).toBe("2026-09-28T13:10:00.000Z");
    expect(db.failAttempt).toHaveBeenCalledWith("a1");
    expect(db.rescheduleOutreach).toHaveBeenCalledWith("o1", next);
    expect(enqueue).toHaveBeenCalledWith({ businessId: "b1", outreachId: "o1", at: next, source: "reschedule" });
  });

  it("schedule exhausted: closes with attempts_exhausted, never enqueues", async () => {
    const { failStaleAttempt } = await import("../lib/outbound/dispatch.js");
    const db = fakeDb();
    const enqueue = vi.fn(async () => ({ created: true }));
    const r = row({ attempts_made: 5 }); // five schedule entries: nothing after attempt 5
    const { outreachClosed, next } = await failStaleAttempt({
      db, enqueue, businessId: "b1", outreachId: "o1", attemptId: "a1", r, attemptNo: 5, tz: "Europe/London", now: () => NOW, rand: () => 0,
    });
    expect(outreachClosed).toBe(false); // closeOutreach ran, but this return value only tracks the LOCKED-closed case below
    expect(next).toBeNull();
    expect(db.closeOutreach).toHaveBeenCalledWith("o1", "attempts_exhausted");
    expect(enqueue).not.toHaveBeenCalled();
  });

  // b32 (fix wave, checkpoint 2b): matching applyOutreachResult's own guard
  // (state IN ('dialing','in_call')) -- a normal post-call run (or an
  // earlier stale-attempt pass) already applied the schedule for this
  // attempt while this backstop was in flight, so re-applying it here would
  // double-reschedule with a possibly different `next` time.
  it("b32: the outreach is no longer 'dialing' (already rescheduled elsewhere) -- the attempt still fails, but nothing is rescheduled or enqueued a second time", async () => {
    const { failStaleAttempt } = await import("../lib/outbound/dispatch.js");
    const db = fakeDb();
    db.lockOutreachState = vi.fn(async () => "waiting"); // already rescheduled by another path
    const enqueue = vi.fn(async () => ({ created: true }));
    const r = row({ attempts_made: 1 });
    const { outreachClosed, next } = await failStaleAttempt({
      db, enqueue, businessId: "b1", outreachId: "o1", attemptId: "a1", r, attemptNo: 1, tz: "Europe/London", now: () => NOW, rand: () => 0,
    });
    expect(outreachClosed).toBe(false);
    expect(next.toISOString()).toBe("2026-09-28T13:10:00.000Z"); // still computed and returned...
    expect(db.failAttempt).toHaveBeenCalledWith("a1"); // ...the attempt itself is stale either way...
    expect(db.rescheduleOutreach).not.toHaveBeenCalled(); // ...but never applied a second time...
    expect(db.closeOutreach).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled(); // ...and never enqueued for a schedule that was never applied here.
  });

  it("the outreach was already closed under lock (e.g. an opt-out mid-flight): the attempt still records failed, nothing is rescheduled or enqueued", async () => {
    const { failStaleAttempt } = await import("../lib/outbound/dispatch.js");
    const db = fakeDb();
    db.lockOutreachState = vi.fn(async () => "closed");
    const enqueue = vi.fn(async () => ({ created: true }));
    const r = row({ attempts_made: 1 });
    const { outreachClosed } = await failStaleAttempt({
      db, enqueue, businessId: "b1", outreachId: "o1", attemptId: "a1", r, attemptNo: 1, tz: "Europe/London", now: () => NOW, rand: () => 0,
    });
    expect(outreachClosed).toBe(true);
    expect(db.failAttempt).toHaveBeenCalledWith("a1");
    expect(db.rescheduleOutreach).not.toHaveBeenCalled();
    expect(db.closeOutreach).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  // S3-11 (Ruling S3-11a): the stuck-dialing alert. failStaleAttempt is the
  // sweep's ONLY caller of db.failAttempt, so every call here is a dial the
  // sidless backstop had to step in on. age_ms comes from the attempt row's
  // own dialed_at (failAttempt's RETURNING), not from a second read.
  it("emits outbound_stuck_dialing with age_ms computed from the attempt's own dialed_at, and bumps the counter", async () => {
    const { failStaleAttempt } = await import("../lib/outbound/dispatch.js");
    clearStats();
    const db = fakeDb();
    // 15 minutes before `now` -- NOW is 2026-09-28T13:00:00Z.
    db.failAttempt = vi.fn(async () => ({ dialedAt: new Date("2026-09-28T12:45:00Z") }));
    const enqueue = vi.fn(async () => ({ created: true }));
    const log = { info: vi.fn(), error: vi.fn() };
    const r = row({ attempts_made: 1 });
    await failStaleAttempt({
      db, enqueue, businessId: "b1", outreachId: "o1", attemptId: "a1", r, attemptNo: 1, tz: "Europe/London", now: () => NOW, rand: () => 0, log,
    });
    expect(log.error).toHaveBeenCalledWith("outbound_stuck_dialing", { attemptId: "a1", outreachId: "o1", age_ms: 900_000 });
    expect(getLatencyStats().turnTaking.outbound_stuck_dialing).toBe(1);
  });

  it("outbound_stuck_dialing fires even when the outreach is no longer 'dialing' -- the attempt itself is stale either way", async () => {
    const { failStaleAttempt } = await import("../lib/outbound/dispatch.js");
    clearStats();
    const db = fakeDb();
    db.lockOutreachState = vi.fn(async () => "closed");
    db.failAttempt = vi.fn(async () => ({ dialedAt: new Date("2026-09-28T12:50:00Z") }));
    const enqueue = vi.fn(async () => ({ created: true }));
    const log = { info: vi.fn(), error: vi.fn() };
    const r = row({ attempts_made: 1 });
    await failStaleAttempt({
      db, enqueue, businessId: "b1", outreachId: "o1", attemptId: "a1", r, attemptNo: 1, tz: "Europe/London", now: () => NOW, rand: () => 0, log,
    });
    expect(log.error).toHaveBeenCalledWith("outbound_stuck_dialing", { attemptId: "a1", outreachId: "o1", age_ms: 600_000 });
    expect(getLatencyStats().turnTaking.outbound_stuck_dialing).toBe(1);
  });
});

describe("startOfLocalDay: local midnight as an instant, DST-safe", () => {
  it("on the spring-forward day London midnight is still GMT (the clocks change at 01:00)", () => {
    expect(startOfLocalDay(new Date("2026-03-29T12:00:00Z"), "Europe/London").toISOString()).toBe("2026-03-29T00:00:00.000Z");
  });
  it("in summer London midnight is 23:00Z the previous day", () => {
    expect(startOfLocalDay(new Date("2026-07-01T12:00:00Z"), "Europe/London").toISOString()).toBe("2026-06-30T23:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Fix round 1 (review of a615950)
// ---------------------------------------------------------------------------

/** A Twilio fake with both shapes the real client has: calls.create and calls(sid).update. */
function twilioWithUpdate(update = vi.fn(async () => ({}))) {
  const calls = Object.assign(vi.fn(() => ({ update })), { create: vi.fn(async () => ({ sid: "CA123" })) });
  return { twilio: { calls }, update };
}
const noSleep = async () => {};

describe("fix A: the SID write is retried, and a call no callback can route is hung up", () => {
  it("a SID write that fails twice then succeeds still dials, with ONE calls.create and backoff between writes", async () => {
    const db = fakeDb();
    db.setAttemptCallSid = vi.fn()
      .mockRejectedValueOnce(new Error("conn reset"))
      .mockRejectedValueOnce(new Error("conn reset"))
      .mockResolvedValue(undefined);
    const { twilio, update } = twilioWithUpdate();
    const sleep = vi.fn(async () => {});
    const { d } = mk(db, twilio, { sleep });
    expect(await d({ businessId: "b1", outreachId: "o1" })).toMatchObject({ status: "dialed", callSid: "CA123", attemptId: "a1" });
    expect(twilio.calls.create).toHaveBeenCalledTimes(1);
    expect(db.setAttemptCallSid).toHaveBeenCalledTimes(3);
    expect(db.setAttemptCallSid).toHaveBeenLastCalledWith("a1", "CA123");
    expect(sleep.mock.calls).toEqual([[100], [300]]);
    expect(update).not.toHaveBeenCalled();
    expect(db.failAttempt).not.toHaveBeenCalled();
  });
  it("a SID write that always fails cancels the call, fails the attempt, reschedules, and reports dial_failed", async () => {
    const db = fakeDb(); db.setAttemptCallSid = vi.fn(async () => { throw new Error("db down"); });
    const { twilio, update } = twilioWithUpdate();
    const log = { info: vi.fn(), error: vi.fn() };
    const { d, enqueue } = mk(db, twilio, { sleep: noSleep, log });
    expect(await d({ businessId: "b1", outreachId: "o1" })).toEqual({ status: "dial_failed", attemptId: "a1" });
    expect(db.setAttemptCallSid).toHaveBeenCalledTimes(3);
    expect(twilio.calls).toHaveBeenCalledWith("CA123");
    expect(update).toHaveBeenCalledWith({ status: "canceled" });
    expect(db.failAttempt).toHaveBeenCalledWith("a1");
    expect(db.rescheduleOutreach).toHaveBeenCalledWith("o1", new Date("2026-09-28T13:10:00Z")); // the next entry, "+10m"
    expect(enqueue).toHaveBeenCalledWith({ businessId: "b1", outreachId: "o1", at: new Date("2026-09-28T13:10:00Z"), source: "reschedule" });
    expect(log.error).toHaveBeenCalledWith("outbound_dial_failed", expect.objectContaining({ attemptId: "a1", reason: "sid_write_failed" }));
  });
  // Checkpoint 2a, M3. Twilio's docs: `canceled` on an in-progress call is a
  // SUCCESSFUL no-op -- 200, and the call is still up. The throw-then-complete
  // path below never ran for an answered call; the returned status has to be
  // read.
  it("M3: `canceled` that comes back in-progress (a 200 no-op) is followed by `completed`", async () => {
    const db = fakeDb(); db.setAttemptCallSid = vi.fn(async () => { throw new Error("db down"); });
    const update = vi.fn(async ({ status }) => (status === "canceled" ? { status: "in-progress" } : { status: "completed" }));
    const { twilio } = twilioWithUpdate(update);
    const log = { info: vi.fn(), error: vi.fn() };
    const { d } = mk(db, twilio, { sleep: noSleep, log });
    expect((await d({ businessId: "b1", outreachId: "o1" })).status).toBe("dial_failed");
    expect(update.mock.calls).toEqual([[{ status: "canceled" }], [{ status: "completed" }]]);
    expect(log.error).toHaveBeenCalledWith("outbound_dial_failed", expect.objectContaining({ reason: "sid_write_failed", hungUp: "completed" }));
  });
  it("M3: a real cancel (status canceled) is not followed by anything", async () => {
    const db = fakeDb(); db.setAttemptCallSid = vi.fn(async () => { throw new Error("db down"); });
    const update = vi.fn(async () => ({ status: "canceled" }));
    const { twilio } = twilioWithUpdate(update);
    const log = { info: vi.fn(), error: vi.fn() };
    const { d } = mk(db, twilio, { sleep: noSleep, log });
    await d({ businessId: "b1", outreachId: "o1" });
    expect(update.mock.calls).toEqual([[{ status: "canceled" }]]);
    expect(log.error).toHaveBeenCalledWith("outbound_dial_failed", expect.objectContaining({ hungUp: "canceled" }));
  });
  it("a call already answered cannot be canceled, so it is completed instead", async () => {
    const db = fakeDb(); db.setAttemptCallSid = vi.fn(async () => { throw new Error("db down"); });
    const update = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("Call is not in-progress. Cannot redirect."), { status: 400 }))
      .mockResolvedValue({});
    const { twilio } = twilioWithUpdate(update);
    const { d } = mk(db, twilio, { sleep: noSleep });
    expect((await d({ businessId: "b1", outreachId: "o1" })).status).toBe("dial_failed");
    expect(update.mock.calls).toEqual([[{ status: "canceled" }], [{ status: "completed" }]]);
    expect(db.failAttempt).toHaveBeenCalledWith("a1");
  });
});

// O-26/C17 (post-2c): dial from either Twilio account. `twilioClientFor` is
// the account-aware resolver (lib/outbound/twilioAccounts.js in production);
// `twilio` (used by every test above) is the older, already-resolved-client
// shape, still supported as a fallback with no signature break.
describe("dispatch: C17 -- twilioClientFor(callerId) resolves the account, when given", () => {
  it("calls.create uses the client twilioClientFor(campaign caller_id) returns", async () => {
    const db = fakeDb();
    const bClient = { calls: { create: vi.fn(async () => ({ sid: "CAfromB" })) } };
    const twilioClientFor = vi.fn(async (callerId) => (callerId === "+441372656055" ? bClient : null));
    const { d } = mk(db, undefined, { twilioClientFor });
    const r = await d({ businessId: "b1", outreachId: "o1" });
    expect(r).toMatchObject({ status: "dialed", callSid: "CAfromB" });
    expect(twilioClientFor).toHaveBeenCalledWith("+441372656055");
    expect(bClient.calls.create).toHaveBeenCalledTimes(1);
  });

  it("hangUp (the SID-write-failure path) uses the SAME resolved client, not the legacy `twilio` fallback", async () => {
    const db = fakeDb();
    db.setAttemptCallSid = vi.fn(async () => { throw new Error("db down"); });
    const update = vi.fn(async () => ({ status: "canceled" }));
    const bCalls = Object.assign(vi.fn(() => ({ update })), { create: vi.fn(async () => ({ sid: "CAfromB" })) });
    const bClient = { calls: bCalls };
    const legacyTwilio = { calls: { create: vi.fn(async () => ({ sid: "CAlegacy" })) } }; // must never be used once twilioClientFor is given
    const twilioClientFor = vi.fn(async () => bClient);
    const { d } = mk(db, legacyTwilio, { sleep: noSleep, twilioClientFor });
    expect((await d({ businessId: "b1", outreachId: "o1" })).status).toBe("dial_failed");
    expect(legacyTwilio.calls.create).not.toHaveBeenCalled();
    expect(bCalls).toHaveBeenCalledWith("CAfromB");
    expect(update).toHaveBeenCalledWith({ status: "canceled" });
  });

  it("twilioClientFor resolving null (neither account owns it) does not throw dispatch itself -- the create attempt fails and reschedules like any other dial failure", async () => {
    const db = fakeDb();
    const twilioClientFor = vi.fn(async () => null);
    const { d, enqueue } = mk(db, undefined, { twilioClientFor });
    const r = await d({ businessId: "b1", outreachId: "o1" });
    expect(r.status).toBe("dial_failed");
    expect(db.failAttempt).toHaveBeenCalledWith("a1");
    expect(enqueue).toHaveBeenCalled();
  });

  it("no twilioClientFor given -- falls back to the legacy `twilio` client (every test above this block)", async () => {
    const db = fakeDb();
    const { d, twilio } = mk(db);
    const r = await d({ businessId: "b1", outreachId: "o1" });
    expect(r).toMatchObject({ status: "dialed", callSid: "CA123" });
    expect(twilio.calls.create).toHaveBeenCalledTimes(1);
  });
});

// Checkpoint 2a, M2. On a DB outage the SID write fails AND the reschedule
// that follows it throws. The log line and the counter used to come after the
// reschedule, so the one failure worth an alert left no trace at all.
describe("M2: a failed SID write is logged and counted before the reschedule that can throw", () => {
  beforeEach(() => clearStats());
  it("failAndReschedule throwing (DB down) still leaves outbound_dial_failed {reason: sid_write_failed, hungUp} and the counter", async () => {
    const db = fakeDb();
    db.setAttemptCallSid = vi.fn(async () => { throw new Error("db down"); });
    db.lockOutreachState = vi.fn(async () => { throw new Error("db down"); }); // failAndReschedule's first DB call
    const { twilio } = twilioWithUpdate(vi.fn(async () => ({ status: "canceled" })));
    const log = { info: vi.fn(), error: vi.fn() };
    const { d } = mk(db, twilio, { sleep: noSleep, log });
    await expect(d({ businessId: "b1", outreachId: "o1" })).rejects.toThrow("db down");
    expect(log.error).toHaveBeenCalledWith("outbound_dial_failed",
      expect.objectContaining({ attemptId: "a1", reason: "sid_write_failed", hungUp: "canceled" }));
    expect(getLatencyStats().turnTaking.outbound_dial_failed).toBe(1);
  });
});

describe("fix B: the failure path reads the outreach state under lock and never reopens a closed one", () => {
  it("a failed create locks the outreach before writing the attempt", async () => {
    const db = fakeDb(); const twilio = { calls: { create: vi.fn(async () => { throw Object.assign(new Error("boom"), { status: 400 }); }) } };
    const { d } = mk(db, twilio);
    await d({ businessId: "b1", outreachId: "o1" });
    const failurePath = db.log.map((x) => x[0]).slice(-3);
    expect(failurePath).toEqual(["lockState", "fail", "reschedule"]);
    expect(db.lockOutreachState).toHaveBeenCalledWith("o1");
  });
  it("an outreach closed during the create window keeps its close: the attempt is failed, nothing rescheduled or enqueued", async () => {
    const db = fakeDb(); db.lockOutreachState = vi.fn(async () => "closed");
    const twilio = { calls: { create: vi.fn(async () => { throw Object.assign(new Error("boom"), { status: 400 }); }) } };
    const { d, enqueue } = mk(db, twilio);
    expect((await d({ businessId: "b1", outreachId: "o1" })).status).toBe("dial_failed");
    expect(db.failAttempt).toHaveBeenCalledWith("a1");
    expect(db.rescheduleOutreach).not.toHaveBeenCalled();
    expect(db.closeOutreach).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("the same for a 429: the attempt is given back, the closed outreach is left alone", async () => {
    const db = fakeDb(); db.lockOutreachState = vi.fn(async () => "closed");
    const twilio = { calls: { create: vi.fn(async () => { throw Object.assign(new Error("busy"), { status: 429 }); }) } };
    const { d, enqueue } = mk(db, twilio);
    await d({ businessId: "b1", outreachId: "o1" });
    expect(db.undoAttempt).toHaveBeenCalledWith("a1", "o1");
    expect(db.rescheduleOutreach).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("fix C: a task that arrives before its time is skipped before the gate", () => {
  it("next_attempt_at ten minutes away: skipped as not_due, nothing written, nothing dialed", async () => {
    const db = fakeDb(row({ next_attempt_at: new Date(NOW.getTime() + 10 * 60_000) })); const { d, twilio } = mk(db);
    expect(await d({ businessId: "b1", outreachId: "o1" })).toEqual({ status: "skipped", reason: "not_due" });
    expect(db.insertCallAttempt).not.toHaveBeenCalled();
    expect(db.isSuppressed).not.toHaveBeenCalled(); // before the gate
    expect(twilio.calls.create).not.toHaveBeenCalled();
  });
  it("a parked outreach (next_attempt_at NULL) is skipped as not_due", async () => {
    const db = fakeDb(row({ next_attempt_at: null })); const { d, twilio } = mk(db);
    expect(await d({ businessId: "b1", outreachId: "o1" })).toEqual({ status: "skipped", reason: "not_due" });
    expect(twilio.calls.create).not.toHaveBeenCalled();
  });
  it("a missing or unparseable next_attempt_at fails closed (skipped), like the gate's facts", async () => {
    for (const bad of [undefined, "not a date"]) {
      const db = fakeDb(row({ next_attempt_at: bad })); const { d, twilio } = mk(db);
      expect(await d({ businessId: "b1", outreachId: "o1" })).toEqual({ status: "skipped", reason: "not_due" });
      expect(twilio.calls.create).not.toHaveBeenCalled();
    }
  });
  it("one second overdue proceeds, and so does 4 s early (5 s of clock slack); 6 s early does not", async () => {
    for (const [offsetMs, status] of [[-1_000, "dialed"], [4_000, "dialed"], [6_000, "skipped"]]) {
      const db = fakeDb(row({ next_attempt_at: new Date(NOW.getTime() + offsetMs) })); const { d } = mk(db);
      expect((await d({ businessId: "b1", outreachId: "o1" })).status, `offset ${offsetMs}`).toBe(status);
    }
  });
});

describe("fix D: capacity is counted for the claimed row's business", () => {
  it("activeDialCounts gets the row's business_id, not the payload's spelling of it", async () => {
    // An upper-case UUID in a task payload still scopes RLS (it casts to uuid),
    // but compared as a string it matches no directory row: zero live calls,
    // and the per-business cap would never bite.
    const db = fakeDb(row({ business_id: "0e0e0000-0000-4000-8000-00000000000a" })); const { d } = mk(db);
    await d({ businessId: "0E0E0000-0000-4000-8000-00000000000A", outreachId: "o1" });
    expect(db.activeDialCounts).toHaveBeenCalledWith("0e0e0000-0000-4000-8000-00000000000a");
  });
});

describe("fix E: a lost insert race is reported, not silent", () => {
  beforeEach(() => clearStats());
  it("a conflict logs outbound_dispatch_conflict and bumps its counter", async () => {
    const db = fakeDb(); db.insertCallAttempt = vi.fn(async () => ({ conflict: true }));
    const log = { info: vi.fn(), error: vi.fn() };
    const { d } = mk(db, undefined, { log });
    expect(await d({ businessId: "b1", outreachId: "o1" })).toEqual({ status: "conflict" });
    expect(log.error).toHaveBeenCalledWith("outbound_dispatch_conflict", { outreachId: "o1", attemptNo: 1 });
    expect(getLatencyStats().turnTaking.outbound_dispatch_conflict).toBe(1);
  });
});

describe("the backstop clip: a refused store is not reported as a failed render", () => {
  it("a storeAttemptAudio refusal logs outbound_backstop_store_refused and the call stays dialed", async () => {
    const db = fakeDb(); db.storeAttemptAudio = vi.fn(async () => { throw new Error("storeAttemptAudio: expected 1 row, got 0"); });
    const log = { info: vi.fn(), error: vi.fn() };
    const { d } = mk(db, undefined, { log, renderAudio: async () => ({ opener: Buffer.from([1]) }) });
    expect((await d({ businessId: "b1", outreachId: "o1" })).status).toBe("dialed");
    expect(log.error).toHaveBeenCalledWith("outbound_backstop_store_refused", expect.objectContaining({ attemptId: "a1" }));
    expect(log.error).not.toHaveBeenCalledWith("outbound_backstop_render_failed", expect.anything());
  });
  it("a render that throws is still outbound_backstop_render_failed", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const { d } = mk(fakeDb(), undefined, { log, renderAudio: async () => { throw new Error("live down"); } });
    expect((await d({ businessId: "b1", outreachId: "o1" })).status).toBe("dialed");
    expect(log.error).toHaveBeenCalledWith("outbound_backstop_render_failed", expect.objectContaining({ attemptId: "a1" }));
  });
});

// bumpCounter silently drops a name that is not in COUNTER_NAMES, so a dial
// counter that was never registered would read zero forever on
// /api/debug/latency while every assertion above stayed green.
describe("dispatch counters reach the metrics snapshot", () => {
  beforeEach(() => clearStats());
  it("a placed call bumps outbound_dial", async () => {
    const { d } = mk(fakeDb());
    await d({ businessId: "b1", outreachId: "o1" });
    expect(getLatencyStats().turnTaking.outbound_dial).toBe(1);
  });
  it("a failed calls.create bumps outbound_dial_failed", async () => {
    const twilio = { calls: { create: vi.fn(async () => { throw Object.assign(new Error("boom"), { status: 400 }); }) } };
    const { d } = mk(fakeDb(), twilio);
    await d({ businessId: "b1", outreachId: "o1" });
    expect(getLatencyStats().turnTaking.outbound_dial_failed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Task 13 (session 2b), spec §9.3 step 1 / O-4: dispatch renders the TEXT of
// the backstop line (and the voicemail when due) from the row's CURRENT
// values, and passes it as `renderAudio({row, attemptNo, lines})`. Extending
// THIS 2a test file (not a new one) for dispatch's new `lines` argument is
// the brief's own named carve-out.
// ---------------------------------------------------------------------------
describe("dispatch: the lines rendering (Task 13, §9.3 step 1, O-4)", () => {
  it("the default template's attempt 1 (in voicemail_on, solicited) renders BOTH lines from the row's current values", async () => {
    const db = fakeDb();
    const renderAudio = vi.fn(async () => null);
    const { d } = mk(db, undefined, { renderAudio });
    await d({ businessId: "b1", outreachId: "o1" });

    const cfg = TEMPLATES.speed_to_lead;
    const vars = { first_name: "Sam", persona_name: "Ava", business_name: "Digile Media", topic: cfg.topic, caller_id_spoken: spokenNumber("+441372656055") };
    const expectedOpener = renderTemplate(cfg.opener, vars);
    const expectedVoicemail = renderTemplate(cfg.voicemail, vars);
    expect(expectedOpener.length).toBeLessThanOrEqual(120);
    expect(expectedVoicemail.length).toBeLessThanOrEqual(300);

    expect(renderAudio).toHaveBeenCalledTimes(1);
    expect(renderAudio).toHaveBeenCalledWith({
      row: expect.objectContaining({ first_name: "Sam", business_name: "Digile Media" }),
      attemptNo: 1,
      // S3-4 (D6): the default template's capabilities list "transfer", so
      // the fixed transfer_miss line joins the two rendered ones.
      lines: { opener: expectedOpener, voicemail: expectedVoicemail, transfer_miss: TRANSFER_MISS_LINE },
      // Task 14 fix round 1 (I4): the per-clip store hook.
      onClip: expect.any(Function),
    });
  });

  // ---------------------------------------------------------------------
  // S3-4 (D6): transfer_miss is gated on the campaign's own capabilities
  // list, independently of the opener/voicemail budget checks above.
  // ---------------------------------------------------------------------
  it("S3-4: a campaign that does NOT list 'transfer' never renders the transfer_miss line", async () => {
    const db = fakeDb(
      row({ config: { ...structuredClone(TEMPLATES.speed_to_lead), caller_id: "+441372656055", capabilities: ["qualification", "appointments", "opt_out", "outcome"] } })
    );
    const renderAudio = vi.fn(async () => null);
    const { d } = mk(db, undefined, { renderAudio });
    await d({ businessId: "b1", outreachId: "o1" });

    const call = renderAudio.mock.calls[0][0];
    expect(call.lines).not.toHaveProperty("transfer_miss");
  });

  it("S3-4: a campaign that lists 'transfer' with no target configured yet still renders the fixed line (unused clips are cleared like any other)", async () => {
    const db = fakeDb(row({ config: { ...structuredClone(TEMPLATES.speed_to_lead), caller_id: "+441372656055", transfer: null } }));
    const renderAudio = vi.fn(async () => null);
    const { d } = mk(db, undefined, { renderAudio });
    await d({ businessId: "b1", outreachId: "o1" });

    const call = renderAudio.mock.calls[0][0];
    expect(call.lines.transfer_miss).toBe(TRANSFER_MISS_LINE);
  });

  it("an attempt NOT in voicemail_on ([1,5]): lines has only opener, no voicemail key", async () => {
    const db = fakeDb(row({ attempts_made: 1 })); // attempt 2
    const renderAudio = vi.fn(async () => null);
    const { d } = mk(db, undefined, { renderAudio });
    await d({ businessId: "b1", outreachId: "o1" });

    const call = renderAudio.mock.calls[0][0];
    expect(call.attemptNo).toBe(2);
    expect(call.lines).toHaveProperty("opener");
    expect(call.lines).not.toHaveProperty("voicemail");
  });

  // "in voicemail_on but the class doesn't permit" is unreachable through the
  // real gate: consentSatisfies (lib/outbound/consent.js) refuses EVERY
  // marketing_consented row with consent_missing (Part 3 territory), and
  // solicited/service are exactly the two classes voicemailPermitted allows
  // -- so a row that reaches dispatch's dial branch at all can never carry a
  // refused class. voicemailPermitted itself (the same function this line
  // reuses) is covered directly in tests/outboundAmd.test.js, at both the
  // pure decideAmd table and the AMD route level.

  it("O-4: an opener over 120 characters is refused, never truncated -- omitted from lines, logged with {attemptId, chars}, and the voicemail (independently under budget) still renders", async () => {
    const longOpener = "x".repeat(130); // no placeholders: renders to exactly 130 chars, every time
    const db = fakeDb(row({ config: { ...structuredClone(TEMPLATES.speed_to_lead), caller_id: "+441372656055", opener: longOpener } }));
    const log = { info: vi.fn(), error: vi.fn() };
    const renderAudio = vi.fn(async () => null);
    const { d } = mk(db, undefined, { renderAudio, log });
    await d({ businessId: "b1", outreachId: "o1" });

    expect(log.error).toHaveBeenCalledWith("outbound_backstop_render_refused", { attemptId: "a1", chars: 130 });
    const call = renderAudio.mock.calls[0][0];
    expect(call.lines).not.toHaveProperty("opener");
    expect(call.lines).toHaveProperty("voicemail"); // independent -- the default voicemail template is unaffected
  });

  it("O-4: a voicemail over 300 characters is refused, never truncated -- omitted from lines, logged with {attemptId, chars}, and the opener (independently under budget) still renders", async () => {
    const longVoicemail = "y".repeat(310);
    const db = fakeDb(row({ config: { ...structuredClone(TEMPLATES.speed_to_lead), caller_id: "+441372656055", voicemail: longVoicemail } }));
    const log = { info: vi.fn(), error: vi.fn() };
    const renderAudio = vi.fn(async () => null);
    const { d } = mk(db, undefined, { renderAudio, log });
    await d({ businessId: "b1", outreachId: "o1" });

    expect(log.error).toHaveBeenCalledWith("outbound_voicemail_render_refused", { attemptId: "a1", chars: 310 });
    const call = renderAudio.mock.calls[0][0];
    expect(call.lines).not.toHaveProperty("voicemail");
    expect(call.lines).toHaveProperty("opener");
  });

  it("both lines over budget, campaign does not list transfer: lines is empty and renderAudio is not even called", async () => {
    const db = fakeDb(
      row({
        config: {
          ...structuredClone(TEMPLATES.speed_to_lead),
          caller_id: "+441372656055",
          opener: "x".repeat(130),
          voicemail: "y".repeat(310),
          // S3-4: isolate this test's original claim (nothing renders) from
          // the new, independent transfer_miss line -- covered on its own
          // just below.
          capabilities: ["qualification", "appointments", "opt_out", "outcome"],
        },
      })
    );
    const log = { info: vi.fn(), error: vi.fn() };
    const renderAudio = vi.fn(async () => null);
    const { d } = mk(db, undefined, { renderAudio, log });
    const result = await d({ businessId: "b1", outreachId: "o1" });

    expect(result.status).toBe("dialed"); // the call still goes out; the backstop is optional
    expect(renderAudio).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith("outbound_backstop_render_refused", { attemptId: "a1", chars: 130 });
    expect(log.error).toHaveBeenCalledWith("outbound_voicemail_render_refused", { attemptId: "a1", chars: 310 });
  });

  it("S3-4: both lines over budget BUT the campaign lists transfer -- renderAudio still fires, for transfer_miss alone", async () => {
    const db = fakeDb(
      row({
        config: {
          ...structuredClone(TEMPLATES.speed_to_lead),
          caller_id: "+441372656055",
          opener: "x".repeat(130),
          voicemail: "y".repeat(310),
        },
      })
    );
    const log = { info: vi.fn(), error: vi.fn() };
    const renderAudio = vi.fn(async () => null);
    const { d } = mk(db, undefined, { renderAudio, log });
    const result = await d({ businessId: "b1", outreachId: "o1" });

    expect(result.status).toBe("dialed");
    expect(renderAudio).toHaveBeenCalledTimes(1);
    expect(renderAudio.mock.calls[0][0].lines).toEqual({ transfer_miss: TRANSFER_MISS_LINE });
  });
});

// ---------------------------------------------------------------------------
// Task 14 fix round 1 (I4): each clip is stored the moment it is ready. The
// session reads opener_audio when the person answers, and on a voicemail
// attempt the voicemail render is the slow one -- storing both together made
// an early answer find no clip at all.
// ---------------------------------------------------------------------------
describe("dispatch: the opener is stored before a slow voicemail render finishes (Task 14, I4)", () => {
  it("stores the opener as soon as onClip hands it over, then the voicemail alone -- never re-writing the opener", async () => {
    const db = fakeDb();
    const opener = Buffer.from([1, 2, 3]);
    const voicemail = Buffer.from([9, 9]);
    let releaseVoicemail;
    const voicemailDone = new Promise((r) => (releaseVoicemail = r));
    let openerStoredBeforeVoicemail = null;

    const renderAudio = vi.fn(async ({ onClip }) => {
      await onClip("opener", opener);
      // The voicemail is still rendering; the opener must already be on the row.
      openerStoredBeforeVoicemail = db.storeAttemptAudio.mock.calls.map((c) => c.slice(0, 2));
      await voicemailDone;
      await onClip("voicemail", voicemail);
      return { opener, voicemail };
    });
    const { d } = mk(db, undefined, { renderAudio });
    const done = d({ businessId: "b1", outreachId: "o1" });
    await vi.waitFor(() => expect(openerStoredBeforeVoicemail).not.toBeNull());
    expect(openerStoredBeforeVoicemail).toEqual([["a1", { opener }]]);

    releaseVoicemail();
    expect((await done).status).toBe("dialed");
    // I2 (fix round 1, reverting ruling 4): dispatch() awaits the render
    // again after the dial (bounded by the ring's own cap), so its returned
    // promise resolving still means every clip that WILL render is on the
    // row -- restored to its pre-D10 synchronous contract.
    // One write per clip, each carrying only its own column. The returned
    // object does not trigger a second opener write.
    expect(db.storeAttemptAudio.mock.calls).toEqual([
      ["a1", { opener }],
      ["a1", { voicemail }],
    ]);
  });

  it("a renderer that only RETURNS its clips (no onClip) still gets them stored, one column per write", async () => {
    const db = fakeDb();
    const opener = Buffer.from([1]);
    const { d } = mk(db, undefined, { renderAudio: async () => ({ opener, voicemail: null }) });
    await d({ businessId: "b1", outreachId: "o1" });
    expect(db.storeAttemptAudio.mock.calls).toEqual([["a1", { opener }]]);
  });
});

// ---------------------------------------------------------------------------
// D10 (spec §19, S3-D2, live round 1): the opener renders and is STORED
// BEFORE calls.create, racing against RENDER_BEFORE_DIAL_MAX_MS -- a hung
// render must never hang the DIAL. I2 (fix round 1) reverted the ORIGINAL
// "unawaited by dispatch()'s own return" design: voice-uk-prod's
// cpu-throttling means a render detached from the request after it returns
// can stall for the whole ring, so dispatch() now awaits the render AGAIN
// after the dial, capped at the ring's own timeout (25 s / 40 s
// voicemail_on) -- never past that, and never on the dial-failed paths.
// ---------------------------------------------------------------------------
describe("D10: render before dial", () => {
  it("the render resolves well inside the deadline -- calls.create is called only after storeAttemptAudio(opener)", async () => {
    const db = fakeDb();
    const opener = Buffer.from([1, 2, 3]);
    const order = [];
    db.storeAttemptAudio = vi.fn(async (...a) => {
      order.push("store");
      return undefined;
    });
    let releaseOpener;
    const openerReady = new Promise((r) => (releaseOpener = r));
    const renderAudio = vi.fn(async ({ onClip }) => {
      await openerReady;
      await onClip("opener", opener);
      return { opener };
    });
    const twilio = { calls: { create: vi.fn(async () => { order.push("dial"); return { sid: "CA123" }; }) } };
    const { d } = mk(db, twilio, { renderAudio });

    const done = d({ businessId: "b1", outreachId: "o1" });
    await new Promise((r) => setImmediate(r));
    expect(twilio.calls.create).not.toHaveBeenCalled(); // still waiting on the opener specifically

    releaseOpener();
    expect((await done).status).toBe("dialed");
    expect(order).toEqual(["store", "dial"]);
  });

  it("the render hangs -- dials anyway at RENDER_BEFORE_DIAL_MAX_MS and logs outbound_render_late", async () => {
    vi.useFakeTimers();
    try {
      const db = fakeDb();
      const renderAudio = vi.fn(() => new Promise(() => {})); // never resolves, never rejects
      const log = { info: vi.fn(), error: vi.fn() };
      const { d, twilio } = mk(db, undefined, { renderAudio, log });

      const done = d({ businessId: "b1", outreachId: "o1" });
      await vi.advanceTimersByTimeAsync(RENDER_BEFORE_DIAL_MAX_MS);
      expect(twilio.calls.create).toHaveBeenCalledTimes(1);
      expect(log.error).toHaveBeenCalledWith(
        "outbound_render_late",
        expect.objectContaining({ attemptId: "a1", waited_ms: RENDER_BEFORE_DIAL_MAX_MS, severity: "warn" })
      );
      // I2 (fix round 1): the SAME hung render is then awaited again, post-dial,
      // bounded by the ring's own cap -- 40 s here (attempt 1 is in
      // voicemail_on) -- rather than left detached.
      await vi.advanceTimersByTimeAsync(40_000);
      expect(log.error).toHaveBeenCalledWith(
        "outbound_render_incomplete",
        expect.objectContaining({ attemptId: "a1", waited_ms: 40_000, severity: "warn" })
      );
      expect((await done).status).toBe("dialed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("I2 (fix round 1): the opener wins the pre-dial race, but the voicemail render then hangs -- dispatch() releases at the ring's own cap, logged", async () => {
    vi.useFakeTimers();
    try {
      const db = fakeDb();
      const opener = Buffer.from([1]);
      const renderAudio = vi.fn(async ({ onClip }) => {
        await onClip("opener", opener); // resolves the opener race quickly
        await new Promise(() => {}); // the voicemail render then hangs forever
      });
      const log = { info: vi.fn(), error: vi.fn() };
      const { d, twilio } = mk(db, undefined, { renderAudio, log }); // attempt 1: voicemail_on -> 40 s ring cap

      const done = d({ businessId: "b1", outreachId: "o1" });
      await vi.advanceTimersByTimeAsync(0); // let the opener's own microtasks settle
      expect(twilio.calls.create).toHaveBeenCalledTimes(1); // the dial was never held up
      expect(log.error).not.toHaveBeenCalledWith("outbound_render_late", expect.anything());

      await vi.advanceTimersByTimeAsync(40_000);
      expect(log.error).toHaveBeenCalledWith(
        "outbound_render_incomplete",
        expect.objectContaining({ attemptId: "a1", waited_ms: 40_000, severity: "warn" })
      );
      expect((await done).status).toBe("dialed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("M5: neither race leaves a dangling timer once dispatch() has resolved", async () => {
    vi.useFakeTimers();
    try {
      const db = fakeDb();
      const opener = Buffer.from([1]);
      const renderAudio = vi.fn(async ({ onClip }) => {
        await onClip("opener", opener);
        return { opener };
      });
      const { d } = mk(db, undefined, { renderAudio });
      await d({ businessId: "b1", outreachId: "o1" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the render throws -- dials at once, never waiting for the timeout", async () => {
    const db = fakeDb();
    const renderAudio = vi.fn(async () => {
      throw new Error("live down");
    });
    const log = { info: vi.fn(), error: vi.fn() };
    const { d, twilio } = mk(db, undefined, { renderAudio, log });

    const start = Date.now();
    const result = await d({ businessId: "b1", outreachId: "o1" });
    expect(Date.now() - start).toBeLessThan(1000); // nowhere near RENDER_BEFORE_DIAL_MAX_MS (8 s)
    expect(result.status).toBe("dialed");
    expect(twilio.calls.create).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith("outbound_backstop_render_failed", expect.objectContaining({ attemptId: "a1" }));
    expect(log.error).not.toHaveBeenCalledWith("outbound_render_late", expect.anything());
  });

  it("no line was ever safe to render -- dials at once (nothing to wait for)", async () => {
    const db = fakeDb(
      row({
        config: {
          ...structuredClone(TEMPLATES.speed_to_lead),
          caller_id: "+441372656055",
          opener: "x".repeat(130),
          voicemail: "y".repeat(310),
          // S3-4: isolate this test's original claim from the independent
          // transfer_miss line, covered separately below.
          capabilities: ["qualification", "appointments", "opt_out", "outcome"],
        },
      })
    );
    const log = { info: vi.fn(), error: vi.fn() };
    const renderAudio = vi.fn(async () => null);
    const { d, twilio } = mk(db, undefined, { renderAudio, log });
    const start = Date.now();
    expect((await d({ businessId: "b1", outreachId: "o1" })).status).toBe("dialed");
    expect(Date.now() - start).toBeLessThan(1000);
    expect(renderAudio).not.toHaveBeenCalled();
    expect(twilio.calls.create).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalledWith("outbound_render_late", expect.anything());
  });

  it("S3-4: opener/voicemail both refused but the campaign lists transfer -- the dial STILL isn't delayed (only 'opener' gates the pre-dial wait)", async () => {
    const db = fakeDb(
      row({
        config: { ...structuredClone(TEMPLATES.speed_to_lead), caller_id: "+441372656055", opener: "x".repeat(130), voicemail: "y".repeat(310) },
      })
    );
    const log = { info: vi.fn(), error: vi.fn() };
    const renderAudio = vi.fn(async () => null); // transfer_miss is asked for, but this fake never resolves it via onClip
    const { d, twilio } = mk(db, undefined, { renderAudio, log });
    const start = Date.now();
    expect((await d({ businessId: "b1", outreachId: "o1" })).status).toBe("dialed");
    expect(Date.now() - start).toBeLessThan(1000);
    expect(renderAudio).toHaveBeenCalledTimes(1); // for transfer_miss alone
    expect(twilio.calls.create).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalledWith("outbound_render_late", expect.anything());
  });

  // Controller ruling: the stale-`dialing` thresholds (lib/outbound/
  // internalRoutes.js) must exceed RENDER_BEFORE_DIAL_MAX_MS plus the longest
  // ring timeout (40 s, voicemail_on), so a dial merely running late is never
  // mistaken by the sweep for a dial that never happened. Same values as
  // before extraction (100, 10, 15, 120); this only asserts the relationship.
  it("the stale-dialing thresholds (sidless, lost-callback) exceed RENDER_BEFORE_DIAL_MAX_MS + the 40 s ring timeout", async () => {
    const { OUTBOUND_STALE_SIDLESS_MINUTES, OUTBOUND_STALE_LOST_CALLBACK_MINUTES, OUTBOUND_STALE_ATTEMPTS_LIMIT, OUTBOUND_STALE_POSTCALL_PENDING_SECONDS } =
      await import("../lib/outbound/internalRoutes.js");
    const floorMs = RENDER_BEFORE_DIAL_MAX_MS + 40_000;
    expect(OUTBOUND_STALE_SIDLESS_MINUTES * 60_000).toBeGreaterThan(floorMs);
    expect(OUTBOUND_STALE_LOST_CALLBACK_MINUTES * 60_000).toBeGreaterThan(floorMs);
    // Unchanged values (no schema/behaviour change from extracting them).
    expect(OUTBOUND_STALE_ATTEMPTS_LIMIT).toBe(100);
    expect(OUTBOUND_STALE_SIDLESS_MINUTES).toBe(10);
    expect(OUTBOUND_STALE_LOST_CALLBACK_MINUTES).toBe(15);
    expect(OUTBOUND_STALE_POSTCALL_PENDING_SECONDS).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// Task 14 fix round 2, owner decision O-9: a contact with no first name.
// dispatch renders through renderCampaignLine, the same renderer the session
// seeds with -- never the literal "null".
// ---------------------------------------------------------------------------
describe("dispatch: a contact with no first name (Task 14, O-9)", () => {
  it.each([null, undefined, ""])("first_name %j: the opener drops its first-name sentence; the voicemail, unusable without it, is not rendered", async (firstName) => {
    const db = fakeDb(row({ first_name: firstName }));
    const log = { info: vi.fn(), error: vi.fn() };
    const renderAudio = vi.fn(async () => null);
    const { d } = mk(db, undefined, { renderAudio, log });
    await d({ businessId: "b1", outreachId: "o1" });

    const { lines } = renderAudio.mock.calls[0][0];
    // S3-4: the default template lists "transfer", so the fixed line still
    // renders even though neither the opener nor the voicemail has a name.
    expect(lines).toEqual({ opener: "It's Ava, an AI assistant from Digile Media.", transfer_miss: TRANSFER_MISS_LINE });
    expect(JSON.stringify(lines)).not.toMatch(/\bnull\b|\bundefined\b/);
    expect(log.error).toHaveBeenCalledWith("outbound_voicemail_render_refused", { attemptId: "a1", reason: "unusable_line" });
  });

  it("an opener with nothing usable left is not rendered at all (the session takes the prompt path)", async () => {
    const db = fakeDb(
      row({
        first_name: null,
        config: {
          ...structuredClone(TEMPLATES.speed_to_lead),
          caller_id: "+441372656055",
          opener: "Hi {first_name}, it's {persona_name}, an AI assistant from {business_name}.",
          // S3-4: isolate this test's original claim (neither backstop line
          // is usable) from the independent transfer_miss line.
          capabilities: ["qualification", "appointments", "opt_out", "outcome"],
        },
      })
    );
    const log = { info: vi.fn(), error: vi.fn() };
    const renderAudio = vi.fn(async () => null);
    const { d } = mk(db, undefined, { renderAudio, log });
    expect((await d({ businessId: "b1", outreachId: "o1" })).status).toBe("dialed");
    expect(renderAudio).not.toHaveBeenCalled(); // neither line is usable
    expect(log.error).toHaveBeenCalledWith("outbound_backstop_render_refused", { attemptId: "a1", reason: "unusable_line" });
  });

  it("with a first name, the lines are exactly what they were", async () => {
    const db = fakeDb();
    const renderAudio = vi.fn(async () => null);
    const { d } = mk(db, undefined, { renderAudio });
    await d({ businessId: "b1", outreachId: "o1" });
    expect(renderAudio.mock.calls[0][0].lines.opener).toBe("Hi, is that Sam? It's Ava, an AI assistant from Digile Media.");
  });
});

// tests/outboundDispatch.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDispatcher, startOfLocalDay } from "../lib/outbound/dispatch.js";
import { TEMPLATES } from "../lib/outbound/templates.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";

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

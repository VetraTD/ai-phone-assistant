// tests/outboundDispatch.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDispatcher, startOfLocalDay } from "../lib/outbound/dispatch.js";
import { TEMPLATES } from "../lib/outbound/templates.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";

const NOW = new Date("2026-09-28T13:00:00Z");
function row(over = {}) {
  return {
    id: "o1", business_id: "b1", state: "waiting", attempts_made: 0, created_at: new Date("2026-09-28T12:59:00Z"), hold_until: null,
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

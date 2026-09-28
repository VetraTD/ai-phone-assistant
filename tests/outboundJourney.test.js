// tests/outboundJourney.test.js
/**
 * S3-3 (spec §8, §12.2): pinning the retry journey for the SHIPPED R1
 * (speed_to_lead) schedule -- lib/outbound/templates.js's own
 * `retries: {schedule: ["now","+10m","+3h","next_day 10:00","day_3 17:30"],
 * voicemail_on: [1,5], give_up_after_days: 7}` -- end to end: which attempts
 * get a voicemail, exactly when the next attempt lands, when the outreach
 * closes attempts_exhausted, when a give_up_after_days breach closes it
 * early, and how callback_requested overrides the schedule entirely.
 *
 * Named risk 6: every expected value below is computed BY HAND from the
 * schedule grammar's own written meaning (lib/outbound/schedule.js's
 * computeAttemptAt doc), not by calling nextScheduled/dispatch and asserting
 * the result against itself. TEMPLATES.speed_to_lead.retries is used only as
 * the INPUT -- the real, shipped R1 config -- never as a source of expected
 * outputs.
 */
import { describe, it, expect } from "vitest";
import { nextScheduled } from "../lib/outbound/dispatch.js";
import { voicemailPermitted } from "../lib/outbound/amd.js";
import { evaluateGate } from "../lib/outbound/gate.js";
import { TEMPLATES } from "../lib/outbound/templates.js";
import { runPostCall } from "../lib/outbound/postCall.js";

const R1 = TEMPLATES.speed_to_lead.retries;
const TZ = "UTC";

describe("R1 schedule literal, sanity", () => {
  it("is exactly the schedule this task's brief names", () => {
    expect(R1.schedule).toEqual(["now", "+10m", "+3h", "next_day 10:00", "day_3 17:30"]);
    expect(R1.voicemail_on).toEqual([1, 5]);
  });
});

describe("voicemail is due on attempts 1 and 5 only", () => {
  // dispatch.js's own expression (lib/outbound/dispatch.js:263), reproduced
  // here rather than imported, so this test is an independent check of the
  // CONFIG's own voicemail_on array against every attempt number, not a
  // re-run of dispatch's internals.
  function voicemailDue(attemptNo, complianceClass) {
    return (R1.voicemail_on || []).includes(attemptNo) && voicemailPermitted(complianceClass);
  }

  it.each([1, 2, 3, 4, 5])("attempt %i", (attemptNo) => {
    expect(voicemailDue(attemptNo, "solicited")).toBe([1, 5].includes(attemptNo));
  });

  it("never due at all on a compliance class voicemail is not permitted for, even on attempt 1 or 5", () => {
    expect(voicemailDue(1, "cold")).toBe(false);
    expect(voicemailDue(5, "cold")).toBe(false);
  });
});

describe("each next_attempt_at is exact (hand-computed, not derived from the code under test)", () => {
  const createdAt = new Date("2026-09-21T08:00:00Z"); // Monday
  // nextScheduled reads r.config.retries.schedule and r.config.calling_window;
  // the window is always-open so applyWindow can never shift a computed time
  // and every assertion below is exact, not "exact modulo the window".
  const row = {
    config: { retries: R1, calling_window: { mon_fri: "00:00-23:59", sat: "00:00-23:59", sun: "00:00-23:59" } },
    created_at: createdAt,
  };

  it("attempt 1 -> 2: entries[1] = '+10m' from the moment attempt 1 ended", () => {
    const now1 = new Date("2026-09-21T08:05:00Z"); // attempt 1 ended 5 min after creation
    const next = nextScheduled(row, 1, now1, TZ, () => 0);
    expect(next.toISOString()).toBe(new Date(now1.getTime() + 10 * 60_000).toISOString());
    expect(next.toISOString()).toBe("2026-09-21T08:15:00.000Z");
  });

  it("attempt 2 -> 3: entries[2] = '+3h' from the moment attempt 2 ended", () => {
    const now2 = new Date("2026-09-21T08:15:05Z");
    const next = nextScheduled(row, 2, now2, TZ, () => 0);
    expect(next.toISOString()).toBe(new Date(now2.getTime() + 3 * 3_600_000).toISOString());
    expect(next.toISOString()).toBe("2026-09-21T11:15:05.000Z");
  });

  it("attempt 3 -> 4: entries[3] = 'next_day 10:00', the CALENDAR day after attempt 3 ended, at 10:00 UTC", () => {
    const now3 = new Date("2026-09-21T11:15:10Z"); // still Monday
    const next = nextScheduled(row, 3, now3, TZ, () => 0);
    expect(next.toISOString()).toBe("2026-09-22T10:00:00.000Z"); // Tuesday 10:00
  });

  it("attempt 4 -> 5: entries[4] = 'day_3 17:30', anchored to the OUTREACH'S OWN created_at, not to when attempt 4 happened", () => {
    const now4 = new Date("2026-09-22T10:00:05Z"); // Tuesday, right after attempt 4
    const next = nextScheduled(row, 4, now4, TZ, () => 0);
    // day_3 = createdAt's calendar date + 2 days = Wednesday, at 17:30 UTC --
    // independent of now4 entirely, which is the whole point of this row.
    expect(next.toISOString()).toBe("2026-09-23T17:30:00.000Z");
  });

  it("a LATE attempt 4 (days after the schedule intended) still lands on the SAME day_3 date -- the anchor never slips", () => {
    const veryLateNow4 = new Date("2026-09-25T09:00:00Z"); // a Friday, days late
    const next = nextScheduled(row, 4, veryLateNow4, TZ, () => 0);
    expect(next.toISOString()).toBe("2026-09-23T17:30:00.000Z");
  });

  it("attempt 5 -> closed attempts_exhausted: idx=5 is past the 5-entry schedule, nextScheduled returns null", () => {
    const now5 = new Date("2026-09-23T17:30:05Z");
    const next = nextScheduled(row, 5, now5, TZ, () => 0);
    expect(next).toBeNull();
  });
});

describe("a give_up_after_days breach closes the outreach early, ahead of the schedule", () => {
  // Reuses tests/outboundGate.test.js's own base-facts shape (the gate
  // itself, not the schedule, owns this check -- see lib/outbound/gate.js
  // check 8b). R1's shipped give_up_after_days is 7.
  const NOW = new Date("2026-09-28T13:00:00Z");
  function facts(overrides = {}) {
    return {
      now: NOW,
      env: { enabled: false, allowlist: new Set(["+447700900001"]), maxConcurrent: 8, inboundReserve: 2 },
      business: { outbound_enabled: true, outbound_max_concurrent: 2 },
      campaign: {
        status: "active",
        compliance_class: "solicited",
        template_key: "speed_to_lead",
        config: { ...structuredClone(TEMPLATES.speed_to_lead), caller_id: "+441372656055" },
      },
      contact: { phone_e164: "+447700900001", timezone: "Europe/London", raw_timezone: "Europe/London" },
      outreach: { attempts_made: 1, created_at: new Date("2026-09-21T08:00:00Z"), hold_until: null },
      suppressed: false,
      consents: [
        { purpose: "enquiry_followup", channels: ["call"], covers_automated: true, captured_at: new Date("2026-09-21T08:00:00Z"), expires_at: null, revoked_at: null },
      ],
      hasRelationship: false,
      dialsToday: 0,
      active: { globalOutbound: 0, businessOutbound: 0 },
      callerIdValid: true,
      ...overrides,
    };
  }

  it("R1's give_up_after_days is 7, exactly", () => {
    expect(TEMPLATES.speed_to_lead.retries.give_up_after_days).toBe(7);
  });

  it("6 days after creation: still within the give-up window, allowed", () => {
    const f = facts({ outreach: { attempts_made: 1, created_at: new Date("2026-09-22T13:00:00Z"), hold_until: null } });
    expect(evaluateGate(f, { rand: () => 0 })).toEqual({ verdict: "allow" });
  });

  it("8 days after creation (past the 7-day give-up window): closed, never redialled -- even with attempts left on the schedule", () => {
    // Only 1 of 5 attempts made -- the schedule alone would still permit
    // dialling; give_up_after_days is what closes it early regardless.
    const f = facts({ outreach: { attempts_made: 1, created_at: new Date("2026-09-20T13:00:00Z"), hold_until: null } });
    expect(evaluateGate(f, { rand: () => 0 })).toEqual({ verdict: "never", reason: "give_up_window" });
  });
});

describe("callback_requested overrides the R1 schedule with callback.at (spec §8)", () => {
  const BIZ = "biz-journey";
  const ATTEMPT = "attempt-journey";
  const CALL_SID = "CAjourney1";
  const PHONE = "+447700900555";
  const NOW = new Date("2026-09-25T12:00:00Z");

  function baseCtx(overrides = {}) {
    return {
      attemptNo: 2, // mid-journey -- entries[2] = "+3h" would otherwise apply
      dialedAt: new Date("2026-09-25T11:59:00Z"),
      answeredAt: new Date("2026-09-25T11:59:05Z"),
      endedAt: null,
      answeredBy: "human",
      result: null,
      silent: false,
      sessionFinishedAt: new Date("2026-09-25T11:59:40Z"),
      statusCompletedAt: new Date("2026-09-25T11:59:41Z"),
      twilioCallSid: CALL_SID,
      outreachId: "outreach-journey",
      outreachState: "dialing",
      attemptsMade: 2,
      outreachCreatedAt: new Date("2026-09-20T09:00:00Z"),
      campaignId: "camp-journey",
      campaignVersion: 1,
      contactId: "contact-journey",
      complianceClass: "solicited",
      templateKey: "speed_to_lead",
      config: { retries: R1, calling_window: { mon_fri: "00:00-23:59", sat: "00:00-23:59", sun: "00:00-23:59" } },
      phoneE164: PHONE,
      contactTimezone: TZ,
      businessTimezone: TZ,
      callId: "call-journey",
      callSid: CALL_SID,
      outcomeCode: "callback_requested",
      answers: null,
      ...overrides,
    };
  }

  function fakeDb(ctxOverrides = {}) {
    const ctx = baseCtx(ctxOverrides);
    const calls = { applyOutreachResult: [] };
    return {
      calls,
      withTenant: async (_biz, fn) => fn(),
      outboundPostCallContext: async () => ctx,
      finalizeAttemptResult: async () => {},
      outboundCallEffects: async () => ({ booked: false, optedOut: false }),
      fetchCallTranscript: async () => [],
      setCallOutcomeCode: async () => {},
      updateCallSummary: async () => {},
      isSuppressed: async () => false,
      insertDetectorSuppression: async () => true,
      setAttemptSilent: async () => {},
      setOutreachHold: async () => {},
      applyOutreachResult: async (...a) => {
        calls.applyOutreachResult.push(a);
        return true;
      },
    };
  }

  it("with a requested time on file (calls.answers._callback_requested_at, schedule_callback's own write): that exact time wins, not entries[attemptNo]", async () => {
    const requested = "2026-10-01T15:00:00.000Z"; // NOT what entries[2] ("+3h" from now) would produce
    // Minor (review): renamed from the plain `callback_requested_at` -- see
    // capabilities/callback.js's own comment for why.
    const db = fakeDb({ answers: { _callback_requested_at: requested } });
    await runPostCall(
      { attemptId: ATTEMPT, businessId: BIZ },
      { db, now: () => NOW, rand: () => 0, summarize: async () => ({ summary: null, sentiment: null, outcome: "unknown" }) }
    );
    const [, , opts] = db.calls.applyOutreachResult[0];
    expect(opts.terminal).toBe(false);
    expect(opts.nextAttemptAt.toISOString()).toBe(requested);
    // Proof it is an OVERRIDE, not a coincidence: entries[2] ("+3h" from NOW)
    // would have produced a materially different time.
    expect(opts.nextAttemptAt.toISOString()).not.toBe(new Date(NOW.getTime() + 3 * 3_600_000).toISOString());
  });

  it("with NO requested time on file: falls back to the mechanical schedule entry (entries[attemptNo])", async () => {
    const db = fakeDb({ answers: null });
    await runPostCall(
      { attemptId: ATTEMPT, businessId: BIZ },
      { db, now: () => NOW, rand: () => 0, summarize: async () => ({ summary: null, sentiment: null, outcome: "unknown" }) }
    );
    const [, , opts] = db.calls.applyOutreachResult[0];
    expect(opts.terminal).toBe(false);
    // attemptNo=2 -> entries[2] = "+3h" from NOW.
    expect(opts.nextAttemptAt.toISOString()).toBe(new Date(NOW.getTime() + 3 * 3_600_000).toISOString());
  });
});

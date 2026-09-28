// tests/outboundPacks.test.js
/**
 * S3-3 (spec §12.2): the three PLATFORM packs -- outcome (set_call_outcome),
 * callback (schedule_callback) and opt_out (opt_out). Unit level, driving
 * each pack directly through the same ctx.deps seam every other capability
 * pack is tested through (see tests/quotes.test.js's own doc) -- no real
 * database. DB-real coverage for the suppression/answers writers themselves
 * is tests/db/outboundSuppression.test.js.
 */
import { describe, it, expect, vi } from "vitest";
import outcome from "../capabilities/outcome.js";
import callback, { validateCallbackTime } from "../capabilities/callback.js";
import optOut from "../capabilities/optOut.js";
import { OUTBOUND_OUTCOME_ENUM } from "../services/gemini.js";
import { OUTBOUND_OUTCOME_ENUM_MIRROR } from "../capabilities/_outcomeEnum.js";
import { PLATFORM_PACKS } from "../lib/outbound/policy.js";
import { listPacks, getPack, packForTool } from "../capabilities/index.js";
import { buildAllDeclarations } from "../services/gemini.js";
import { OUTBOUND_FIXTURES } from "./fixtures/businessConfigs.js";

function fakeDeps(overrides = {}) {
  return {
    setCallOutcomeCode: vi.fn(async () => {}),
    insertSuppression: vi.fn(async () => true),
    mergeCallAnswers: vi.fn(async () => {}),
    ...overrides,
  };
}

const CALLING_WINDOW = { mon_fri: "09:00-20:00", sat: "10:00-16:00", sun: null, outside_window: "queue" };

function makeOutboundCtx({ verified = true, deps = fakeDeps(), phone = "+15559876543", outboundCall } = {}) {
  return {
    businessId: "biz-1",
    callId: "call-1",
    callSid: "CAsid1",
    party: { phone, source: "dialed", verified },
    outboundCall: outboundCall ?? {
      config: { capabilities: ["appointments"], calling_window: CALLING_WINDOW },
      contact: { firstName: "Priya", timezone: "America/Chicago", phone },
      campaign: { audience: "business" },
    },
    deps,
  };
}

describe("registry wiring", () => {
  it("PLATFORM_PACKS is exactly [outcome, callback, opt_out], and each is registered", () => {
    expect([...PLATFORM_PACKS]).toEqual(["outcome", "callback", "opt_out"]);
    for (const id of PLATFORM_PACKS) {
      expect(getPack(id), id).toBeTruthy();
    }
  });

  it("none of the three is an action tool (named risk 2)", () => {
    expect(getPack("outcome").actionTools).toEqual([]);
    expect(getPack("callback").actionTools).toEqual([]);
    expect(getPack("opt_out").actionTools).toEqual([]);
  });

  it("packForTool resolves all three real tool names", () => {
    expect(packForTool("set_call_outcome")?.id).toBe("outcome");
    expect(packForTool("schedule_callback")?.id).toBe("callback");
    expect(packForTool("opt_out")?.id).toBe("opt_out");
  });

  it("capabilities/outcome.js's mirrored enum agrees with services/gemini.js's OUTBOUND_OUTCOME_ENUM plus wrong_number", () => {
    expect(new Set(OUTBOUND_OUTCOME_ENUM_MIRROR)).toEqual(new Set([...OUTBOUND_OUTCOME_ENUM, "wrong_number"]));
    expect(OUTBOUND_OUTCOME_ENUM_MIRROR.length).toBe(OUTBOUND_OUTCOME_ENUM.length + 1);
  });
});

describe("platform packs are declared on outbound only (named risk 3)", () => {
  const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];

  it("all three tool names are declared on an outbound call", () => {
    const names = buildAllDeclarations(config, extras).map((d) => d.name);
    expect(names).toContain("set_call_outcome");
    expect(names).toContain("schedule_callback");
    expect(names).toContain("opt_out");
  });

  it("all three are ABSENT on inbound, even for the exact same tenant config (extras.outboundCall removed)", () => {
    const { outboundCall, ...inboundLikeExtras } = extras;
    const names = buildAllDeclarations(config, inboundLikeExtras).map((d) => d.name);
    expect(names).not.toContain("set_call_outcome");
    expect(names).not.toContain("schedule_callback");
    expect(names).not.toContain("opt_out");
  });

  it("absent on a plain inbound config that never touches outbound fixtures at all", () => {
    const names = buildAllDeclarations({ allowedTasks: ["book_appointment"] }, {}).map((d) => d.name);
    expect(names).not.toContain("set_call_outcome");
    expect(names).not.toContain("schedule_callback");
    expect(names).not.toContain("opt_out");
  });
});

describe("set_call_outcome", () => {
  const fc = (args) => ({ id: "fc1", name: "set_call_outcome", args });

  it("enforces the enum: an unknown outcome is refused", async () => {
    const res = await outcome.execute(fc({ outcome: "bogus" }), makeOutboundCtx());
    expect(res.functionResponse.response.success).toBe(false);
    expect(res.functionResponse.response.message).toMatch(/must be one of/i);
  });

  it.each(["booked", "opted_out", "transferred"])("refuses %s, naming why", async (bad) => {
    const deps = fakeDeps();
    const res = await outcome.execute(fc({ outcome: bad }), makeOutboundCtx({ deps }));
    expect(res.functionResponse.response.success).toBe(false);
    expect(deps.setCallOutcomeCode).not.toHaveBeenCalled();
  });

  it.each(OUTBOUND_OUTCOME_ENUM_MIRROR.filter((o) => o !== "wrong_number"))(
    "accepts %s and writes it verbatim to calls.outcome_code",
    async (good) => {
      const deps = fakeDeps();
      const res = await outcome.execute(fc({ outcome: good }), makeOutboundCtx({ deps }));
      expect(res.functionResponse.response.success).toBe(true);
      expect(deps.setCallOutcomeCode).toHaveBeenCalledWith("CAsid1", good);
    }
  );

  it("wrong_number writes a suppression reason wrong_number AND records the call's own outcome as wrong_person", async () => {
    const deps = fakeDeps();
    const res = await outcome.execute(fc({ outcome: "wrong_number" }), makeOutboundCtx({ deps, phone: "+15551234567" }));
    expect(res.functionResponse.response.success).toBe(true);
    expect(deps.insertSuppression).toHaveBeenCalledWith({
      phone: "+15551234567",
      reason: "wrong_number",
      sourceCallId: "call-1",
      createdBy: "tool",
    });
    expect(deps.setCallOutcomeCode).toHaveBeenCalledWith("CAsid1", "wrong_person");
  });

  it("works with party.verified=false -- not gated by O-12 (named risk 2)", async () => {
    const deps = fakeDeps();
    const res = await outcome.execute(fc({ outcome: "not_interested" }), makeOutboundCtx({ deps, verified: false }));
    expect(res.functionResponse.response.success).toBe(true);
  });

  it("wrong_number also works with party.verified=false", async () => {
    const deps = fakeDeps();
    const res = await outcome.execute(fc({ outcome: "wrong_number" }), makeOutboundCtx({ deps, verified: false }));
    expect(res.functionResponse.response.success).toBe(true);
    expect(deps.insertSuppression).toHaveBeenCalled();
  });

  // Fix round 1 (review Important #1): a must-hold write must never
  // silently no-op while the tool still claims the guarantee.
  describe("wrong_number: the guarantee is never claimed without the row (fix round 1)", () => {
    it("no usable phone at all (null): refused, no write attempted, outcome_code never written", async () => {
      const deps = fakeDeps();
      const res = await outcome.execute(fc({ outcome: "wrong_number" }), makeOutboundCtx({ deps, phone: null }));
      expect(res.functionResponse.response.success).toBe(false);
      expect(res.functionResponse.response.message).toMatch(/do not tell them/i);
      expect(deps.insertSuppression).not.toHaveBeenCalled();
      expect(deps.setCallOutcomeCode).not.toHaveBeenCalled();
    });

    it("an invalid (non-E.164) phone: refused the same way", async () => {
      const deps = fakeDeps();
      const res = await outcome.execute(fc({ outcome: "wrong_number" }), makeOutboundCtx({ deps, phone: "anonymous" }));
      expect(res.functionResponse.response.success).toBe(false);
      expect(deps.insertSuppression).not.toHaveBeenCalled();
      expect(deps.setCallOutcomeCode).not.toHaveBeenCalled();
    });

    it("insertSuppression reports neither true nor false (the deps wire itself missing) -- refused, outcome_code never written", async () => {
      const deps = fakeDeps({ insertSuppression: vi.fn(async () => undefined) });
      const res = await outcome.execute(fc({ outcome: "wrong_number" }), makeOutboundCtx({ deps }));
      expect(res.functionResponse.response.success).toBe(false);
      expect(res.functionResponse.response.message).toMatch(/do not tell them/i);
      expect(deps.setCallOutcomeCode).not.toHaveBeenCalled();
    });

    it("insertSuppression reports false (ON CONFLICT -- already suppressed): still success, the guarantee already held", async () => {
      const deps = fakeDeps({ insertSuppression: vi.fn(async () => false) });
      const res = await outcome.execute(fc({ outcome: "wrong_number" }), makeOutboundCtx({ deps }));
      expect(res.functionResponse.response.success).toBe(true);
      expect(deps.setCallOutcomeCode).toHaveBeenCalledWith("CAsid1", "wrong_person");
    });
  });
});

describe("opt_out", () => {
  const fc = () => ({ id: "fc1", name: "opt_out", args: {} });

  it("inserts the suppression (opted_out/tool) and sets the outcome to opted_out", async () => {
    const deps = fakeDeps();
    const res = await optOut.execute(fc(), makeOutboundCtx({ deps }));
    expect(res.functionResponse.response.success).toBe(true);
    expect(deps.insertSuppression).toHaveBeenCalledWith({
      phone: "+15559876543",
      reason: "opted_out",
      sourceCallId: "call-1",
      createdBy: "tool",
    });
    expect(deps.setCallOutcomeCode).toHaveBeenCalledWith("CAsid1", "opted_out");
  });

  it("works with party.verified=false -- not gated by O-12 (named risk 2)", async () => {
    const deps = fakeDeps();
    const res = await optOut.execute(fc(), makeOutboundCtx({ deps, verified: false }));
    expect(res.functionResponse.response.success).toBe(true);
    expect(deps.insertSuppression).toHaveBeenCalled();
  });

  it("a second opt_out call does not throw and calls the writer again (the DB's ON CONFLICT is what dedupes, not this tool)", async () => {
    const deps = fakeDeps();
    await expect(optOut.execute(fc(), makeOutboundCtx({ deps }))).resolves.toBeTruthy();
    await expect(optOut.execute(fc(), makeOutboundCtx({ deps }))).resolves.toBeTruthy();
    expect(deps.insertSuppression).toHaveBeenCalledTimes(2);
  });

  // Fix round 1 (review Important #1): a must-hold write must never
  // silently no-op while the tool still claims the guarantee.
  describe("the guarantee is never claimed without the row (fix round 1)", () => {
    it("no usable phone at all (null): refused, no write attempted, outcome_code never written", async () => {
      const deps = fakeDeps();
      const res = await optOut.execute(fc(), makeOutboundCtx({ deps, phone: null }));
      expect(res.functionResponse.response.success).toBe(false);
      expect(res.functionResponse.response.message).toMatch(/do not tell them/i);
      expect(deps.insertSuppression).not.toHaveBeenCalled();
      expect(deps.setCallOutcomeCode).not.toHaveBeenCalled();
    });

    it("an invalid (non-E.164) phone: refused the same way", async () => {
      const deps = fakeDeps();
      const res = await optOut.execute(fc(), makeOutboundCtx({ deps, phone: "anonymous" }));
      expect(res.functionResponse.response.success).toBe(false);
      expect(deps.insertSuppression).not.toHaveBeenCalled();
      expect(deps.setCallOutcomeCode).not.toHaveBeenCalled();
    });

    it("insertSuppression reports neither true nor false (the deps wire itself missing) -- refused, outcome_code never written", async () => {
      const deps = fakeDeps({ insertSuppression: vi.fn(async () => undefined) });
      const res = await optOut.execute(fc(), makeOutboundCtx({ deps }));
      expect(res.functionResponse.response.success).toBe(false);
      expect(res.functionResponse.response.message).toMatch(/do not tell them/i);
      expect(deps.setCallOutcomeCode).not.toHaveBeenCalled();
    });

    it("insertSuppression reports false (ON CONFLICT -- already suppressed): still success -- a second/duplicate opt_out is still a success", async () => {
      const deps = fakeDeps({ insertSuppression: vi.fn(async () => false) });
      const res = await optOut.execute(fc(), makeOutboundCtx({ deps }));
      expect(res.functionResponse.response.success).toBe(true);
      expect(deps.setCallOutcomeCode).toHaveBeenCalledWith("CAsid1", "opted_out");
    });
  });
});

describe("schedule_callback", () => {
  const fc = (args) => ({ id: "fc1", name: "schedule_callback", args });
  // Frozen "now": a Monday, well inside the window on both business and
  // contact clocks so the two are indistinguishable unless a test deliberately
  // sets a DIFFERENT contact timezone (named risk 5).
  const NOW = new Date("2026-09-28T15:00:00Z"); // Monday, 10:00 America/Chicago, 16:00 Europe/London

  it("refuses when there is no outbound call context (fail closed)", async () => {
    const ctx = makeOutboundCtx();
    delete ctx.outboundCall;
    const res = await callback.execute(fc({ when_iso: "2026-09-29T10:00:00" }), ctx);
    expect(res.functionResponse.response.success).toBe(false);
  });

  it("refuses an unparseable when_iso", async () => {
    const res = await callback.execute(fc({ when_iso: "not a date" }), makeOutboundCtx());
    expect(res.functionResponse.response.success).toBe(false);
  });

  it("books a time inside the window, on the CONTACT's clock, and speaks it back in the contact's local time (named risk 5)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const deps = fakeDeps();
      // Contact is in Australia/Sydney -- FAR from the business/server
      // timezone -- so a bug that anchors the wall-clock string to the wrong
      // zone shows up as either a refusal or the wrong spoken time.
      const outboundCall = {
        config: { capabilities: ["appointments"], calling_window: { mon_fri: "00:00-23:59", sat: null, sun: null } },
        contact: { firstName: "Priya", timezone: "Australia/Sydney", phone: "+15559876543" },
        campaign: { audience: "business" },
      };
      const res = await callback.execute(fc({ when_iso: "2026-09-29T14:00:00" }), makeOutboundCtx({ deps, outboundCall }));
      expect(res.functionResponse.response.success).toBe(true);
      // 2026-09-29T14:00:00 in Australia/Sydney (AEST, UTC+10) is 04:00 UTC.
      expect(res.functionResponse.response.at).toBe("2026-09-29T04:00:00.000Z");
      expect(deps.setCallOutcomeCode).toHaveBeenCalledWith("CAsid1", "callback_requested");
      expect(deps.mergeCallAnswers).toHaveBeenCalledWith("CAsid1", { callback_requested_at: "2026-09-29T04:00:00.000Z" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a time outside the calling window is refused with a nearest ISO time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const outboundCall = {
        config: { capabilities: ["appointments"], calling_window: { mon_fri: "09:00-17:00", sat: null, sun: null } },
        contact: { firstName: "Priya", timezone: "America/Chicago", phone: "+15559876543" },
        campaign: { audience: "business" },
      };
      // 9pm, well outside 09:00-17:00.
      const res = await callback.execute(fc({ when_iso: "2026-09-29T21:00:00" }), makeOutboundCtx({ outboundCall }));
      expect(res.functionResponse.response.success).toBe(false);
      expect(res.functionResponse.response.nearest).toBeTruthy();
      expect(new Date(res.functionResponse.response.nearest).getTime()).not.toBeNaN();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a time 15 days out is refused (beyond the 14-day cap), even though it is inside the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const outboundCall = {
        config: { capabilities: ["appointments"], calling_window: { mon_fri: "00:00-23:59", sat: null, sun: null } },
        contact: { firstName: "Priya", timezone: "America/Chicago", phone: "+15559876543" },
        campaign: { audience: "business" },
      };
      const fifteenDaysOut = "2026-10-13T10:00:00"; // NOW (Sep 28) + 15 days
      const res = await callback.execute(fc({ when_iso: fifteenDaysOut }), makeOutboundCtx({ outboundCall }));
      expect(res.functionResponse.response.success).toBe(false);
      expect(res.functionResponse.response.nearest).toBeTruthy();
      // The offered nearest time must itself respect the 14-day cap.
      const nearestMs = new Date(res.functionResponse.response.nearest).getTime();
      expect(nearestMs).toBeLessThanOrEqual(NOW.getTime() + 14 * 86_400_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("works with party.verified=false -- not gated by O-12 (named risk 2)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const deps = fakeDeps();
      const res = await callback.execute(fc({ when_iso: "2026-09-29T10:00:00" }), makeOutboundCtx({ deps, verified: false }));
      expect(res.functionResponse.response.success).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("validateCallbackTime, the S3-7 seam, unit level", () => {
    it("ok inside the window and within 14 days", () => {
      const now = new Date("2026-09-28T12:00:00Z");
      const candidate = new Date("2026-09-29T15:00:00Z"); // inside 00:00-23:59 mon_fri
      const v = validateCallbackTime(candidate, {
        callingWindow: { mon_fri: "00:00-23:59", sat: null, sun: null },
        tz: "UTC",
        now,
      });
      expect(v.ok).toBe(true);
    });

    it("refuses and offers a nearest time beyond the 14-day cap", () => {
      const now = new Date("2026-09-28T12:00:00Z");
      const candidate = new Date(now.getTime() + 20 * 86_400_000);
      const v = validateCallbackTime(candidate, {
        callingWindow: { mon_fri: "00:00-23:59", sat: "00:00-23:59", sun: "00:00-23:59" },
        tz: "UTC",
        now,
      });
      expect(v.ok).toBe(false);
      expect(new Date(v.nearest).getTime()).toBeLessThanOrEqual(now.getTime() + 14 * 86_400_000);
    });
  });
});

// tests/liveOutboundFinish.test.js
/**
 * Task 20 (spec §11): the outbound hook at the end of `finish()` must be
 * byte-identical for inbound -- `state.outboundCall`/`state.attemptId` are
 * both absent there, so the block must never run at all. Proven directly
 * (the two outbound-only calls are never made), not just inferred from "no
 * error was logged": a silently-swallowed throw would look the same.
 */
import { describe, it, expect, vi } from "vitest";
import { bootLive, fakeDb } from "./helpers/liveBoot.js";

const CONFIG = {
  businessId: "biz-1",
  businessName: "Acme Dental",
  greeting: "Thanks for calling Acme Dental.",
  mainPhone: "+15551234567",
  timezone: "America/Chicago",
  businessHours: {},
  locale: null,
  liveVoice: null,
  allowedTasks: ["general_question", "take_message"],
  capabilities: {},
};

/** Capture the structured log lines the session writes while `run` happens. */
async function stdoutLines(run) {
  const lines = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    if (typeof chunk === "string") lines.push(...chunk.split("\n").filter(Boolean));
    return true;
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

describe("finish(): inbound is byte-identical (Task 20's outbound hook never runs)", () => {
  it("makes no outbound post-call calls, and still emits exactly one live_call_summary", async () => {
    const finishAttemptSession = vi.fn(async () => {});
    const postCall = {
      tryClaim: vi.fn(async () => false),
      tryClaimByAttempt: vi.fn(async () => false),
    };
    const database = { ...fakeDb(CONFIG, "biz-1"), finishAttemptSession };

    const { hangUp } = await bootLive({ config: CONFIG, database, postCall });

    const events = await stdoutLines(async () => {
      await hangUp();
      await new Promise((r) => setTimeout(r, 25));
    });

    expect(finishAttemptSession).not.toHaveBeenCalled();
    expect(postCall.tryClaim).not.toHaveBeenCalled();
    expect(postCall.tryClaimByAttempt).not.toHaveBeenCalled();

    const summaries = events.filter((e) => e.event === "live_call_summary");
    expect(summaries).toHaveLength(1);
    // The summary's own shape is untouched: no outbound-only key leaked onto
    // an inbound call's record.
    expect(summaries[0]).not.toHaveProperty("silent");
    expect(summaries[0]).not.toHaveProperty("outboundCall");
    // Task 21 (spec §14): direction gets an explicit VALUE on inbound too --
    // the one key this change adds to every call. attempt_id/campaign_id
    // stay ABSENT (Ruling: undefined, which JSON.stringify drops) rather
    // than null, so the inbound record equals today's shape plus exactly
    // that one key, not three.
    expect(summaries[0].direction).toBe("inbound");
    expect(summaries[0]).not.toHaveProperty("attempt_id");
    expect(summaries[0]).not.toHaveProperty("campaign_id");
  });

  it("no outbound_finish_postcall_failed (or any Task 20 event) is ever logged for an inbound call", async () => {
    const database = fakeDb(CONFIG, "biz-1");
    const { hangUp } = await bootLive({ config: CONFIG, database });
    const events = await stdoutLines(async () => {
      await hangUp();
      await new Promise((r) => setTimeout(r, 25));
    });
    const outboundEvents = events.filter((e) => typeof e.event === "string" && e.event.startsWith("outbound_"));
    expect(outboundEvents).toEqual([]);
  });
});

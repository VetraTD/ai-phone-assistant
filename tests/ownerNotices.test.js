import { describe, it, expect, vi } from "vitest";
import { flushOwnerNotices } from "../lib/ownerNotices.js";

// The owner's email for a call's saved messages, sent from the status callback.
// Everything is injected, so these run without a database, a clock or a mailer.

const BIZ = "biz-1";
const SID = "CA00000000000000000000000000000001";

function row(id, callId, over = {}) {
  return {
    id,
    call_id: callId,
    request_type: "message",
    caller_name: "Name",
    callback_number: "+15550000000",
    message: "hello",
    preferred_time: null,
    details: null,
    created_at: new Date(2026, 10, 7, 10, 0, Number(String(id).replace(/\D/g, "")) || 0),
    caller_number: "+15551112222",
    twilio_call_sid: SID,
    ...over,
  };
}

function setup({ pending = [], outcome = "sent" } = {}) {
  let queue = [...pending];
  const order = [];
  const db = {
    withTenantSafe: vi.fn(async (_b, fn, opts = {}) => {
      try {
        return await fn();
      } catch {
        return opts.fallback ?? null;
      }
    }),
    claimOwnerNotices: vi.fn(async () => {
      order.push("claim");
      const out = queue;
      queue = [];
      return out;
    }),
    releaseOwnerNotices: vi.fn(async ({ ids }) => ids.length),
  };
  const notifications = {
    notifyCallRequests: vi.fn(async () => (typeof outcome === "function" ? outcome() : outcome)),
  };
  const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const captureException = vi.fn();
  const bump = vi.fn();
  const sleep = vi.fn(async () => {
    order.push("sleep");
  });
  const args = { db, notifications, log, captureException, bump, sleep, businessId: BIZ, callSid: SID };
  return { args, db, notifications, log, captureException, bump, sleep, order };
}

describe("flushOwnerNotices", () => {
  it("waits settleMs before claiming", async () => {
    const t = setup({ pending: [row("r1", "c1")] });
    await flushOwnerNotices({ ...t.args, settleMs: 1234 });
    expect(t.sleep).toHaveBeenCalledWith(1234);
    expect(t.order).toEqual(["sleep", "claim"]);
  });

  it("groups rows by call and sends one email per call", async () => {
    const t = setup({ pending: [row("r1", "c1"), row("r2", "c2"), row("r3", "c1")] });
    const out = await flushOwnerNotices(t.args);
    expect(out).toEqual({ sent: 2, failed: 0, off: 0 });
    const calls = t.notifications.notifyCallRequests.mock.calls.map(([a]) => a);
    expect(calls).toHaveLength(2);
    const byCall = Object.fromEntries(calls.map((a) => [a.rows[0].call_id, a.rows.map((r) => r.id)]));
    expect(byCall).toEqual({ c1: ["r1", "r3"], c2: ["r2"] });
    for (const a of calls) expect(a.businessId).toBe(BIZ);
    expect(t.bump).toHaveBeenCalledWith("owner_notice_checked");
    expect(t.bump.mock.calls.filter(([n]) => n === "owner_notice_sent")).toHaveLength(2);
  });

  it("a lead with answers and a message with none give two emails, each with only its own rows", async () => {
    const lead = row("r1", "c1", { request_type: "lead", details: { answers: [{ q: "Q", a: "A" }] } });
    const msg = row("r2", "c2", { request_type: "message", details: null });
    const t = setup({ pending: [lead, msg] });
    await flushOwnerNotices(t.args);
    const calls = t.notifications.notifyCallRequests.mock.calls.map(([a]) => a);
    expect(calls).toHaveLength(2);
    expect(calls[0].rows).toEqual([lead]);
    expect(calls[1].rows).toEqual([msg]);
  });

  it("a stale row from an earlier call, returned by the claim, is sent in its own group", async () => {
    const stale = row("r1", "c-old", { twilio_call_sid: "CAold" });
    const mine = row("r2", "c-now");
    const t = setup({ pending: [stale, mine] });
    const out = await flushOwnerNotices(t.args);
    expect(out.sent).toBe(2);
    const groups = t.notifications.notifyCallRequests.mock.calls.map(([a]) => a.rows.map((r) => r.id));
    expect(groups).toEqual([["r1"], ["r2"]]);
  });

  it("sends the groups concurrently", async () => {
    const t = setup({ pending: [row("r1", "c1"), row("r2", "c2")] });
    let inFlight = 0;
    let peak = 0;
    t.notifications.notifyCallRequests.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return "sent";
    });
    await flushOwnerNotices(t.args);
    expect(peak).toBe(2);
  });

  it("a second flush sends nothing", async () => {
    const t = setup({ pending: [row("r1", "c1")] });
    await flushOwnerNotices(t.args);
    const again = await flushOwnerNotices(t.args);
    expect(again).toEqual({ sent: 0, failed: 0, off: 0 });
    expect(t.notifications.notifyCallRequests).toHaveBeenCalledTimes(1);
  });

  it("failed releases exactly those ids and logs owner_notice_unsent with counts only", async () => {
    const t = setup({ pending: [row("r1", "c1"), row("r2", "c2"), row("r3", "c1")] });
    t.notifications.notifyCallRequests.mockImplementation(async ({ rows }) =>
      rows[0].call_id === "c1" ? "failed" : "sent"
    );
    const out = await flushOwnerNotices(t.args);
    expect(out).toEqual({ sent: 1, failed: 1, off: 0 });
    expect(t.db.releaseOwnerNotices).toHaveBeenCalledTimes(1);
    expect(t.db.releaseOwnerNotices).toHaveBeenCalledWith({ businessId: BIZ, ids: ["r1", "r3"] });
    expect(t.bump).toHaveBeenCalledWith("owner_notice_unsent");
    expect(t.bump.mock.calls.filter(([n]) => n === "owner_notice_sent")).toHaveLength(1);
    expect(t.log.error).toHaveBeenCalledTimes(1);
    const [event, fields] = t.log.error.mock.calls[0];
    expect(event).toBe("owner_notice_unsent");
    expect(fields).toEqual({ callSid: SID, businessId: BIZ, calls: 1, rows: 2, released: 2 });
  });

  it("off releases nothing and logs no error", async () => {
    const t = setup({ pending: [row("r1", "c1")], outcome: "off" });
    const out = await flushOwnerNotices(t.args);
    expect(out).toEqual({ sent: 0, failed: 0, off: 1 });
    expect(t.db.releaseOwnerNotices).not.toHaveBeenCalled();
    expect(t.log.error).not.toHaveBeenCalled();
    expect(t.bump).not.toHaveBeenCalledWith("owner_notice_sent");
  });

  it("a throwing db still resolves, and the report carries ids only", async () => {
    const t = setup();
    t.db.withTenantSafe.mockRejectedValue(new Error("boom to a@b.com"));
    const out = await flushOwnerNotices(t.args);
    expect(out).toEqual({ sent: 0, failed: 0, off: 0 });
    expect(t.captureException).toHaveBeenCalledTimes(1);
    expect(t.captureException.mock.calls[0][1]).toEqual({ callSid: SID, businessId: BIZ });
  });

  it("a release that fails is logged with counts and does not throw", async () => {
    const t = setup({ pending: [row("r1", "c1")], outcome: "failed" });
    t.db.releaseOwnerNotices.mockRejectedValue(new Error("down"));
    const out = await flushOwnerNotices(t.args);
    expect(out.failed).toBe(1);
    expect(t.log.error).toHaveBeenCalled();
    for (const [, fields] of t.log.error.mock.calls) {
      expect(JSON.stringify(fields)).not.toMatch(/down|hello|Name/);
    }
  });

  it("no pending rows bumps owner_notice_checked and sends nothing", async () => {
    const t = setup();
    const out = await flushOwnerNotices(t.args);
    expect(out).toEqual({ sent: 0, failed: 0, off: 0 });
    expect(t.bump).toHaveBeenCalledWith("owner_notice_checked");
    expect(t.notifications.notifyCallRequests).not.toHaveBeenCalled();
  });

  it("no businessId returns zeros with no wait and no claim", async () => {
    const t = setup({ pending: [row("r1", "c1")] });
    const out = await flushOwnerNotices({ ...t.args, businessId: null });
    expect(out).toEqual({ sent: 0, failed: 0, off: 0 });
    expect(t.sleep).not.toHaveBeenCalled();
    expect(t.db.claimOwnerNotices).not.toHaveBeenCalled();
  });
});

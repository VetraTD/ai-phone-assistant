import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import { flushOwnerNotices } from "../lib/ownerNotices.js";
import { getLatencyStats } from "../lib/voice/metrics.js";
import { resetPg, sql, params, setDbEnv, restoreDbEnv } from "./helpers/pgMock.js";

// The owner's email for a call's saved messages, sent from the status callback.
// Everything is injected, so these run without a database, a clock or a mailer.
//
// `pg` is mocked for the one block at the end that reads the claim's SQL; the
// flush tests above it never touch services/db.js.
vi.mock("pg", async () => (await import("./helpers/pgMock.js")).pgModuleMock());

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
    completeOwnerNotices: vi.fn(async ({ ids }) => ids.length),
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

// A claim is a lease (migration 060): the row stays pending until the flush
// completes it, so an instance that dies after the claim leaves the email to
// the next call instead of losing it.
describe("flushOwnerNotices completes what it settled", () => {
  it("sent completes exactly each group's ids", async () => {
    const t = setup({ pending: [row("r1", "c1"), row("r2", "c2"), row("r3", "c1")] });
    await flushOwnerNotices(t.args);
    const completed = t.db.completeOwnerNotices.mock.calls.map(([a]) => a);
    expect(completed).toHaveLength(2);
    expect(completed).toEqual(
      expect.arrayContaining([
        { businessId: BIZ, ids: ["r1", "r3"] },
        { businessId: BIZ, ids: ["r2"] },
      ])
    );
    expect(t.db.releaseOwnerNotices).not.toHaveBeenCalled();
    expect(t.log.error).not.toHaveBeenCalled();
  });

  it("off completes, so an 'off' business does not re-claim the same rows on every call", async () => {
    const t = setup({ pending: [row("r1", "c1")], outcome: "off" });
    await flushOwnerNotices(t.args);
    expect(t.db.completeOwnerNotices).toHaveBeenCalledTimes(1);
    expect(t.db.completeOwnerNotices).toHaveBeenCalledWith({ businessId: BIZ, ids: ["r1"] });
    expect(t.db.releaseOwnerNotices).not.toHaveBeenCalled();
  });

  it("failed releases and does not complete", async () => {
    const t = setup({ pending: [row("r1", "c1")], outcome: "failed" });
    await flushOwnerNotices(t.args);
    expect(t.db.releaseOwnerNotices).toHaveBeenCalledWith({ businessId: BIZ, ids: ["r1"] });
    expect(t.db.completeOwnerNotices).not.toHaveBeenCalled();
  });

  it("a throwing send releases and does not complete", async () => {
    const t = setup({ pending: [row("r1", "c1")] });
    t.notifications.notifyCallRequests.mockRejectedValue(new Error("smtp down"));
    const out = await flushOwnerNotices(t.args);
    expect(out).toEqual({ sent: 0, failed: 1, off: 0 });
    expect(t.db.releaseOwnerNotices).toHaveBeenCalledWith({ businessId: BIZ, ids: ["r1"] });
    expect(t.db.completeOwnerNotices).not.toHaveBeenCalled();
  });

  it("the completes run inside the tenant's scope", async () => {
    const t = setup({ pending: [row("r1", "c1")] });
    await flushOwnerNotices(t.args);
    const scoped = t.db.withTenantSafe.mock.calls.map(([b, , opts]) => [b, opts?.operation]);
    expect(scoped).toContainEqual([BIZ, "completeOwnerNotices"]);
  });

  it("a throwing complete does not break the flush or the other groups, and is logged with counts only", async () => {
    const t = setup({ pending: [row("r1", "c1"), row("r2", "c2"), row("r3", "c1")] });
    t.db.completeOwnerNotices.mockImplementation(async ({ ids }) => {
      if (ids.includes("r1")) throw new Error("down for hello Name");
      return ids.length;
    });
    const out = await flushOwnerNotices(t.args);
    expect(out).toEqual({ sent: 2, failed: 0, off: 0 });
    expect(t.notifications.notifyCallRequests).toHaveBeenCalledTimes(2);
    expect(t.db.completeOwnerNotices).toHaveBeenCalledTimes(2);
    expect(t.db.releaseOwnerNotices).not.toHaveBeenCalled();
    expect(t.log.error).toHaveBeenCalledTimes(1);
    const [event, fields] = t.log.error.mock.calls[0];
    expect(event).toBe("owner_notice_uncompleted");
    expect(fields).toEqual({ callSid: SID, businessId: BIZ, calls: 1, rows: 2, completed: 0 });
  });

  it("a complete that changes no row (unscoped, or the scope failed) is logged as uncompleted", async () => {
    const t = setup({ pending: [row("r1", "c1")] });
    t.db.completeOwnerNotices.mockResolvedValue(0);
    const out = await flushOwnerNotices(t.args);
    expect(out.sent).toBe(1);
    expect(t.log.error).toHaveBeenCalledWith("owner_notice_uncompleted", {
      callSid: SID,
      businessId: BIZ,
      calls: 1,
      rows: 1,
      completed: 0,
    });
  });

  it("a row taken from an expired lease is logged and counted, and the flag never reaches the email", async () => {
    const t = setup({
      pending: [row("r1", "c1", { reclaimed: true }), row("r2", "c1", { reclaimed: false }), row("r3", "c2", { reclaimed: true })],
    });
    await flushOwnerNotices(t.args);
    expect(t.bump.mock.calls.filter(([n]) => n === "owner_notice_reclaimed")).toHaveLength(1);
    expect(t.log.error).toHaveBeenCalledTimes(1);
    expect(t.log.error).toHaveBeenCalledWith("owner_notice_reclaimed", {
      callSid: SID,
      businessId: BIZ,
      rows: 2,
      severity: "warn",
    });
    for (const [{ rows }] of t.notifications.notifyCallRequests.mock.calls) {
      for (const r of rows) expect(r).not.toHaveProperty("reclaimed");
    }
  });

  it("no reclaimed row: no reclaimed log and no bump", async () => {
    const t = setup({ pending: [row("r1", "c1", { reclaimed: false })] });
    await flushOwnerNotices(t.args);
    expect(t.bump).not.toHaveBeenCalledWith("owner_notice_reclaimed");
    expect(t.log.error).not.toHaveBeenCalled();
  });

  it("every counter the flush bumps is registered (bumpCounter drops an unknown name)", () => {
    const src = fs.readFileSync(new URL("../lib/ownerNotices.js", import.meta.url), "utf8");
    const bumped = [...src.matchAll(/\bbump\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
    expect(bumped).toContain("owner_notice_reclaimed");
    const registered = new Set(Object.keys(getLatencyStats().turnTaking));
    for (const name of bumped) expect(registered.has(name), name).toBe(true);
  });
});

// What a pg mock can answer honestly: the shape of the claim. Its semantics
// (the lease holds, expires, and survives a lock wait) are proven against real
// Postgres in tests/db/customerRequestDetails.test.js, which the sabotage
// matrix cannot run.
describe("claimOwnerNotices SQL", () => {
  beforeEach(() => {
    vi.resetModules();
    resetPg();
    setDbEnv();
  });
  afterEach(() => restoreDbEnv());

  it("stamps a lease, leaves the row pending, and tests the lease on the UPDATE's own row", async () => {
    const { claimOwnerNotices } = await import("../services/db.js");
    await claimOwnerNotices({ businessId: "b1", callSid: "CA1" });

    const text = sql(0);
    const update = text.slice(text.indexOf("UPDATE customer_requests cr"));
    expect(update).toContain("SET owner_notice_claimed_at = now()");
    expect(text).not.toMatch(/owner_notice_pending\s*=\s*false/);
    // The lease predicate must sit on the UPDATE's target alias, where Postgres
    // re-checks it against the newest row version after a lock wait, not only
    // inside the CTE's snapshot.
    const where = update.slice(update.indexOf(" WHERE "), update.indexOf(" RETURNING "));
    expect(where).toContain("cr.owner_notice_pending");
    expect(where).toContain(
      "(cr.owner_notice_claimed_at IS NULL OR cr.owner_notice_claimed_at < now() - make_interval(secs => $3))"
    );
    // Two minutes: more than one flush's worst case (2 s settle + 10 s send cap).
    expect(params(0)).toEqual(["b1", "CA1", 120]);
  });
});

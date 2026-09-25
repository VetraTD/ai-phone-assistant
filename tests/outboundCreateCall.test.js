// tests/outboundCreateCall.test.js
/**
 * services/db.js `createCall` gains an optional 5th argument for outbound
 * (spec §6.2 / §9.2): `{direction, campaignId, campaignVersion, outreachId,
 * attemptId, contactId}`. Every existing caller passes four arguments, and for
 * them the statement and its parameters must be BYTE-IDENTICAL to what they
 * were before this task -- asserted against a verbatim copy of the old SQL.
 *
 * The shape of the statements only (the pg mock). That the outbound row lands
 * with its link columns under RLS is asserted against real Postgres in
 * tests/db/outboundCallContext.test.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pg, resetPg, allSql, params, setDbEnv, restoreDbEnv } from "./helpers/pgMock.js";

vi.mock("pg", async () => (await import("./helpers/pgMock.js")).pgModuleMock());
vi.mock("../lib/sentry.js", () => ({ captureException: vi.fn() }));

/** The statement createCall issued before Task 14, copied verbatim (whitespace included). */
const PRE_TASK_14_SQL = `INSERT INTO calls (business_id, twilio_call_sid, caller_number, twilio_number)
     VALUES ($1, $2, $3, $4) RETURNING id`;

beforeEach(() => {
  vi.resetModules();
  resetPg();
  setDbEnv();
});

afterEach(() => {
  restoreDbEnv();
});

describe("createCall: the four-argument call is unchanged", () => {
  it("issues byte-identical SQL and exactly the same four parameters", async () => {
    pg.respond = () => ({ rows: [{ id: "call-uuid-1" }] });
    const { createCall } = await import("../services/db.js");

    await expect(createCall("biz-1", "CA123", "+15551110000", "+15552220000")).resolves.toBe("call-uuid-1");

    // The RAW text, not allSql()'s whitespace-collapsed copy: byte-identical.
    expect(pg.queries.map((q) => q.text)).toEqual([PRE_TASK_14_SQL]);
    expect(params()).toEqual(["biz-1", "CA123", "+15551110000", "+15552220000"]);
  });

  it("an explicit undefined 5th argument is the four-argument call", async () => {
    pg.respond = () => ({ rows: [{ id: "call-uuid-1" }] });
    const { createCall } = await import("../services/db.js");
    await createCall("biz-1", "CA123", "+1", "+2", undefined);
    expect(pg.queries.map((q) => q.text)).toEqual([PRE_TASK_14_SQL]);
    expect(params()).toEqual(["biz-1", "CA123", "+1", "+2"]);
  });
});

describe("createCall: the outbound link", () => {
  it("writes direction and the five link columns alongside the four originals", async () => {
    pg.respond = () => ({ rows: [{ id: "call-uuid-2" }] });
    const { createCall } = await import("../services/db.js");

    await expect(
      createCall("biz-1", "CAout", "+447700900123", "+441372656055", {
        direction: "outbound",
        campaignId: "camp-1",
        campaignVersion: 3,
        outreachId: "out-1",
        attemptId: "att-1",
        contactId: "contact-1",
      })
    ).resolves.toBe("call-uuid-2");

    const [sql] = allSql();
    expect(sql).toMatch(/INSERT INTO calls \(business_id, twilio_call_sid, caller_number, twilio_number, direction, campaign_id, campaign_version, outreach_id, attempt_id, contact_id\)/);
    expect(params()).toEqual(["biz-1", "CAout", "+447700900123", "+441372656055", "outbound", "camp-1", 3, "out-1", "att-1", "contact-1"]);
  });

  it("returns null on error rather than throwing, like the four-argument call", async () => {
    pg.respond = () => new Error("boom");
    const { createCall } = await import("../services/db.js");
    await expect(createCall("biz-1", "CAout", "+1", "+2", { direction: "outbound" })).resolves.toBeNull();
  });
});

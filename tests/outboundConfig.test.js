import { describe, it, expect } from "vitest";
import { outboundEnv } from "../lib/outbound/config.js";

describe("outboundEnv", () => {
  it("is OFF with the spec defaults when nothing is set", () => {
    const e = outboundEnv({});
    expect(e).toMatchObject({ enabled: false, maxConcurrent: 8, inboundReserve: 2, tasksQueue: null, tasksSa: null });
    expect([...e.allowlist]).toEqual([]);
  });
  it("only the literal 'true' switches it on", () => {
    expect(outboundEnv({ OUTBOUND_ENABLED: "1" }).enabled).toBe(false);
    expect(outboundEnv({ OUTBOUND_ENABLED: "true" }).enabled).toBe(true);
  });
  it("parses the allowlist as E.164 only and drops anything else", () => {
    const e = outboundEnv({ OUTBOUND_TEST_ALLOWLIST: " +14699338887, +447700900123 ,garbage,07700" });
    expect([...e.allowlist].sort()).toEqual(["+14699338887", "+447700900123"]);
  });
  // Checkpoint 2a, M7: a dropped entry was silent, so "07700..." (no +44)
  // quietly blocked the operator's own test handset. Count them.
  it("reports how many non-empty entries it dropped (a trailing comma is not one)", () => {
    expect(outboundEnv({ OUTBOUND_TEST_ALLOWLIST: " +14699338887, +447700900123 ,garbage,07700" }).allowlistDropped).toBe(2);
    expect(outboundEnv({ OUTBOUND_TEST_ALLOWLIST: "+447700900123," }).allowlistDropped).toBe(0);
    expect(outboundEnv({}).allowlistDropped).toBe(0);
  });
  it("refuses a reserve that would leave no outbound line, clamping to a working value", () => {
    expect(outboundEnv({ OUTBOUND_MAX_CONCURRENT: "3", OUTBOUND_INBOUND_RESERVE: "5" }).inboundReserve).toBe(2);
  });
});

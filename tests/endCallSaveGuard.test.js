// LVX192: end_call is refused once while the caller has said things since the
// last save. Calls the real shared gate with the wires Live passes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeToolCall } from "../services/tools.js";
import { clearStats, getLatencyStats } from "../lib/voice/metrics.js";

const OPEN = { open: "09:00", close: "18:00", closed: false };
const CONFIG = {
  businessName: "Hammersleys",
  greeting: "Thanks for calling.",
  mainPhone: "+442038935047",
  timezone: "Europe/London",
  businessHours: { mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN, sun: OPEN },
  locale: "en-GB",
  allowedTasks: ["take_message"],
  afterHoursPolicy: "take_message",
  capabilities: { messages: { enabled: true } },
};

const counters = () => getLatencyStats().turnTaking;
const call = (ctx) => executeToolCall({ id: "e1", name: "end_call", args: {} }, ctx);

const base = {
  businessId: "biz-1",
  config: CONFIG,
  step: "confirm",
  callerTurnCount: 5,
  lastCallerText: "cash please",
  askedAnythingElse: true,
  anythingElseRefusalSpent: true,
  unsavedCallerTurns: 2,
  messagesSaved: 1,
  promisedWithoutSave: false,
  saveGuardSpent: false,
};

beforeEach(() => clearStats());
afterEach(() => clearStats());

describe("LVX192 save guard at the shared gate", () => {
  it("refuses when a message was saved and the caller said more since", async () => {
    const r = await call(base);
    expect(r.functionResponse.response.success).toBe(false);
    expect(r.functionResponse.response.message).toContain("record_customer_request");
    expect(r.functionResponse.response.message).toContain("Do not say goodbye on this turn.");
    expect(r.stateEffects.endCallRefusal).toBe("unsaved");
    expect(r.stateEffects.toolResult).toEqual({
      name: "end_call",
      success: false,
      message: "Just a moment.",
      callerSafe: true,
    });
    expect(counters().end_call_save_guard_ran).toBe(1);
    expect(counters().end_call_refused_unsaved).toBe(1);
  });

  it("does not spend the no_ask latch", async () => {
    const r = await call(base);
    expect(r.stateEffects.endCallNoAskRefusal).toBeUndefined();
  });

  it("passes when nothing is unsaved, and counts the check", async () => {
    const r = await call({ ...base, unsavedCallerTurns: 0 });
    expect(r.functionResponse.response.success).toBe(true);
    expect(counters().end_call_save_guard_ran).toBe(1);
    expect(counters().end_call_refused_unsaved || 0).toBe(0);
  });

  it("passes once the guard is spent for this save", async () => {
    const r = await call({ ...base, saveGuardSpent: true });
    expect(r.functionResponse.response.success).toBe(true);
    expect(counters().end_call_refused_unsaved || 0).toBe(0);
  });

  it("refuses with nothing saved when a save was promised", async () => {
    const r = await call({ ...base, messagesSaved: 0, promisedWithoutSave: true, unsavedCallerTurns: 1 });
    expect(r.stateEffects.endCallRefusal).toBe("unsaved");
  });

  it("passes with nothing saved and no promise", async () => {
    const r = await call({ ...base, messagesSaved: 0, promisedWithoutSave: false });
    expect(r.functionResponse.response.success).toBe(true);
  });

  it("no gate without the wire (the cascade)", async () => {
    const ctx = { ...base };
    delete ctx.unsavedCallerTurns;
    delete ctx.messagesSaved;
    delete ctx.promisedWithoutSave;
    delete ctx.saveGuardSpent;
    const r = await call(ctx);
    expect(r.functionResponse.response.success).toBe(true);
    expect(counters().end_call_save_guard_ran || 0).toBe(0);
    expect(counters().end_call_refused_unsaved || 0).toBe(0);
  });

  it("skipped on outbound", async () => {
    const r = await call({ ...base, outboundCall: { config: {}, contact: {}, campaign: {} } });
    expect(r.functionResponse.response.success).toBe(true);
    expect(counters().end_call_save_guard_ran || 0).toBe(0);
  });

  it("skipped when the messages capability is disabled", async () => {
    const config = { ...CONFIG, capabilities: { messages: { enabled: false } } };
    const r = await call({ ...base, config });
    expect(r.functionResponse.response.success).toBe(true);
    expect(counters().end_call_save_guard_ran || 0).toBe(0);
  });

  it("unsaved beats no_ask when both apply", async () => {
    const r = await call({ ...base, askedAnythingElse: false, anythingElseRefusalSpent: false });
    expect(r.stateEffects.endCallRefusal).toBe("unsaved");
    expect(counters().end_call_refused_no_ask || 0).toBe(0);
  });

  it("no_ask still applies when nothing is unsaved", async () => {
    const r = await call({
      ...base,
      unsavedCallerTurns: 0,
      askedAnythingElse: false,
      anythingElseRefusalSpent: false,
    });
    expect(r.stateEffects.endCallRefusal).toBe("no_ask");
  });
});

/**
 * Caller-experience Task 4: the spelling gate follows the business's spelling
 * setting and the caller's type, for MESSAGES only.
 *
 * The standard-tier prompt no longer asks anyone to spell up front (spellUpFront
 * "no"), but the code still refused an unspelled message save, so a caller who
 * was never asked was refused for it. The gate now stands down for a message
 * where the setting does not ask. Bookings, quotes and the healthcare tier keep
 * the refusal as it was.
 *
 * Also here: the Live spelling nudge (the second place a spelling ask came from)
 * follows the same rule, and every spelling ask is counted into the intake block.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeToolCall, messagesSpellingRequired } from "../services/tools.js";
import { loadConfig } from "../services/db.js";
import { intakeTypeFor } from "../lib/capabilities/intakeSettings.js";
import { bootLive } from "./helpers/liveBoot.js";
import { clearStats, getLatencyStats } from "../lib/voice/metrics.js";

const WEEKLY = {
  monday: { open: "09:00", close: "17:00" },
  tuesday: { open: "09:00", close: "17:00" },
  wednesday: { open: "09:00", close: "17:00" },
  thursday: { open: "09:00", close: "17:00" },
  friday: { open: "09:00", close: "17:00" },
};

function config({ messages = {}, tier, appointments = false } = {}) {
  return loadConfig({
    id: "b1",
    name: "Testwork Services",
    timezone: "America/Chicago",
    business_hours: WEEKLY,
    ...(tier ? { compliance_tier: tier } : {}),
    allowed_tasks: ["take_message", "book_appointment"],
    business_capabilities: [
      { capability_id: "messages", enabled: true, config: messages },
      ...(appointments ? [{ capability_id: "appointments", enabled: true, adapter: "internal", adapter_config: {}, config: {} }] : []),
    ],
  });
}

const save = (extra = {}) => ({
  id: "m1",
  name: "record_customer_request",
  args: { request_type: "message", caller_name: "Marcus Bell", callback_number: "2145550123", message: "about the invoice", ...extra },
});
const ctxFor = (cfg, extra = {}) => ({
  config: cfg,
  capabilityState: {},
  callerPhone: "+15551234567",
  spellingSettled: false,
  ...extra,
});
const refusedForSpelling = (r) => r.stateEffects?.writeGateRefusal === "spelling";

describe("messagesSpellingRequired", () => {
  const c = (messages) => config({ messages });
  it("follows the setting and the type", () => {
    expect(messagesSpellingRequired({ config: c({}), callerType: "new_enquiry" })).toBe(false);
    expect(messagesSpellingRequired({ config: c({ spellUpFront: "everyone" }), callerType: "personal" })).toBe(true);
    expect(messagesSpellingRequired({ config: c({ spellUpFront: "leads" }), callerType: "new_enquiry" })).toBe(true);
    expect(messagesSpellingRequired({ config: c({ spellUpFront: "leads" }), callerType: "existing_customer" })).toBe(true);
    expect(messagesSpellingRequired({ config: c({ spellUpFront: "leads" }), callerType: "personal" })).toBe(false);
    // Never reported: read as a new enquiry.
    expect(messagesSpellingRequired({ config: c({ spellUpFront: "leads" }), callerType: null })).toBe(true);
    expect(messagesSpellingRequired({ config: c({ spellUpFront: "no" }), callerType: "new_enquiry" })).toBe(false);
  });
  it("the healthcare tier ignores the setting: the gate decides as before", () => {
    expect(messagesSpellingRequired({ config: config({ tier: "hipaa" }), callerType: "personal" })).toBe(true);
  });
});

describe("intakeTypeFor", () => {
  it("a valid type on the save, else a valid one on the call, else null", () => {
    expect(intakeTypeFor({ caller_type: "personal" }, { callerType: "new_enquiry" })).toBe("personal");
    expect(intakeTypeFor({}, { callerType: "supplier" })).toBe("supplier");
    expect(intakeTypeFor({ caller_type: "martian" }, { callerType: "supplier" })).toBe("supplier");
    expect(intakeTypeFor({ caller_type: "martian" }, {})).toBeNull();
    expect(intakeTypeFor(undefined, undefined)).toBeNull();
  });
});

describe("the spelling gate on a message save", () => {
  it("default settings: an unspelled name is NOT refused for spelling", async () => {
    const r = await executeToolCall(save(), ctxFor(config()));
    expect(refusedForSpelling(r)).toBe(false);
    expect(r.functionResponse.response.success).toBe(true);
  });

  it('spellUpFront "everyone": refused as today', async () => {
    const r = await executeToolCall(save(), ctxFor(config({ messages: { spellUpFront: "everyone" } })));
    expect(refusedForSpelling(r)).toBe(true);
    expect(r.functionResponse.response.success).toBe(false);
  });

  it('"leads": refused for a new_enquiry, not for a personal call', async () => {
    const cfg = config({ messages: { spellUpFront: "leads" } });
    const lead = await executeToolCall(save(), ctxFor(cfg, { callerType: "new_enquiry" }));
    expect(refusedForSpelling(lead)).toBe(true);
    const personal = await executeToolCall(save(), ctxFor(cfg, { callerType: "personal" }));
    expect(refusedForSpelling(personal)).toBe(false);
  });

  it('"leads": the save\'s own caller_type wins over the call\'s', async () => {
    const cfg = config({ messages: { spellUpFront: "leads" } });
    const r = await executeToolCall(save({ caller_type: "new_enquiry" }), ctxFor(cfg, { callerType: "personal" }));
    expect(refusedForSpelling(r)).toBe(true);
  });

  it('"leads": a type never reported is read as a new enquiry', async () => {
    const r = await executeToolCall(save(), ctxFor(config({ messages: { spellUpFront: "leads" } })));
    expect(refusedForSpelling(r)).toBe(true);
  });

  it("a hipaa config is refused as today, whatever the setting", async () => {
    const r = await executeToolCall(save(), ctxFor(config({ tier: "hipaa", messages: { spellUpFront: "no" } }), { callerType: "personal" }));
    expect(refusedForSpelling(r)).toBe(true);
  });

  it("an appointments booking with the default setting is refused exactly as today", async () => {
    const r = await executeToolCall(
      { id: "b1", name: "book_appointment", args: { client_name: "Marcus Bell", scheduled_at: "2099-01-05T10:00:00" } },
      ctxFor(config({ appointments: true }), { callerType: "personal" })
    );
    expect(refusedForSpelling(r)).toBe(true);
    expect(r.functionResponse.response.message).toMatch(/get the spelling/);
  });
});

// ---------------------------------------------------------------------------
// The Live spelling nudge: the other place a spelling ask came from.
// ---------------------------------------------------------------------------
const LIVE_CONFIG = (messages = {}) => ({
  businessName: "Testwork Services",
  greeting: "Thanks for calling Testwork.",
  mainPhone: "+18176011171",
  timezone: "America/Chicago",
  locale: "en-US",
  allowedTasks: ["general_question", "take_message", "callback_request", "book_appointment"],
  capabilities: { messages: { enabled: true, ...messages } },
});
const stat = (n) => getLatencyStats().turnTaking[n];

async function nameInIntentTurn(messages, intentArgs) {
  const s = await bootLive({ config: LIVE_CONFIG(messages), callSid: "CA_spell_nudge" });
  await s.callerSays("Hi, it's Jane Fitzgerald.");
  await s.callTool("set_call_intent", intentArgs);
  await s.assistantTurn("Lovely, thanks. What is it about?");
  await s.hangUp();
}

describe("the Live spelling nudge follows the setting", () => {
  beforeEach(() => clearStats());

  it("a take_message turn that hears the name in the same turn: no nudge with default settings", async () => {
    await nameInIntentTurn({}, { intent: "take_message", caller_type: "new_enquiry" });
    expect(stat("live_spelling_ask_nudged") ?? 0).toBe(0);
  });

  it('the same with spellUpFront "everyone": still nudges', async () => {
    await nameInIntentTurn({ spellUpFront: "everyone" }, { intent: "take_message", caller_type: "personal" });
    expect(stat("live_spelling_ask_nudged")).toBe(1);
  });

  it("a booking intent still nudges, with default settings", async () => {
    await nameInIntentTurn({}, { intent: "book_appointment" });
    expect(stat("live_spelling_ask_nudged")).toBe(1);
  });
});

describe("intake.spell_asks counts every spelling ask on an inbound call", () => {
  it("one ask in an assistant turn is one in the summary block", async () => {
    const lines = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      if (typeof chunk === "string") lines.push(...chunk.split("\n"));
      return true;
    });
    try {
      const s = await bootLive({ config: LIVE_CONFIG(), callSid: "CA_spell_count" });
      await s.assistantTurn("Could you spell your full name for me?");
      await s.callerSays("Sure.");
      await s.hangUp();
    } finally {
      spy.mockRestore();
    }
    const summary = lines.filter((l) => l.includes('"event":"live_call_summary"')).map((l) => JSON.parse(l))[0];
    expect(summary.intake.spell_asks).toBe(1);
  });
});

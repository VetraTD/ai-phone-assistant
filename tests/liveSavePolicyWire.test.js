// ---------------------------------------------------------------------------
// Round A1 "say it once" — the two wires the booking save rule reads, proven
// with BOTH ends real: lib/voice/live/index.js turnState() produces them, the
// runner copies them, services/tools.js reads them. tests/liveToolContext.test.js
// proves only the copy; a stub there cannot show the producer exists
// (a-test-proves-a-wire-only-if-both-ends-are-real).
// ---------------------------------------------------------------------------
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootLive } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";
import { composeReadBack } from "../lib/voice/savePolicy.js";

const OPEN = { open: "09:00", close: "18:00", closed: false };
const CONFIG = {
  businessName: "Digile Media",
  greeting: "Thanks for calling Digile Media.",
  mainPhone: "+18176011171",
  timezone: "America/Chicago",
  businessHours: {
    mon: OPEN,
    tue: OPEN,
    wed: OPEN,
    thu: OPEN,
    fri: OPEN,
    sat: { open: null, close: null, closed: true },
    sun: { open: null, close: null, closed: true },
  },
  locale: "en-US",
  allowedTasks: ["book_appointment", "check_appointment"],
  afterHoursPolicy: "take_message",
  capabilities: { appointments: { enabled: true, adapter: "internal", availability: { length: 30, capacity: 1 } } },
};
const SLOT = "2026-09-18T14:00:00";
const ARGS = { client_name: "Jon Dodla", scheduled_at: SLOT, notes: "strategy call" };

beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
});
afterAll(() => vi.useRealTimers());

let prior;
beforeEach(() => {
  clearStats();
  prior = process.env.VOICE_SPELL_POLICY;
  process.env.VOICE_SPELL_POLICY = "off";
  return () => {
    if (prior === undefined) delete process.env.VOICE_SPELL_POLICY;
    else process.env.VOICE_SPELL_POLICY = prior;
  };
});

describe("A1 wires, end to end through a real Live session", () => {
  it("a read-back spoken in the turn in progress saves the booking (inTurnReplyText)", async () => {
    const s = await bootLive({ config: CONFIG, callSid: "CA_a1_inturn" });
    await s.callTool("check_appointment_availability", { requested_at: SLOT });
    await s.callerSays("Friday at two works.");
    // The model speaks first and calls the tool in the same turn.
    await s.assistantSays(composeReadBack({ toolName: "book_appointment", args: ARGS, config: CONFIG }));
    const [r] = await s.callTool("book_appointment", ARGS);
    expect(r.response.success).toBe(true);
    expect(s.store.scheduled()).toHaveLength(1);
  });

  it("with nothing read back, the handed sentence spells a surname the caller spelled (callerSpelled)", async () => {
    const s = await bootLive({ config: CONFIG, callSid: "CA_a1_spelled" });
    await s.callTool("check_appointment_availability", { requested_at: SLOT });
    await s.callerSays("It's Jon, D O D L A.");
    await s.assistantTurn("Thanks, Jon. Friday at two is open.");
    await s.callerSays("Great, book it.");
    const [r] = await s.callTool("book_appointment", ARGS);
    expect(r.response.success).toBe(false);
    expect(r.response.message).toContain("for Jon, D-O-D-L-A, booking that now.");
    expect(s.store.scheduled()).toHaveLength(0);
  });
});

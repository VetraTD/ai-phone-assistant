// ---------------------------------------------------------------------------
// The after-call message on exits that hand the caller to somebody else (I2 / B18)
// and on appointment calls (I3 / B19), with the real tool runner (bootLive).
//
// Counter, not row: bootLive's capability deps are fakes; what is asserted is
// that the owed write ran (message_saved_after_call) or stood down.
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { bootLive, fakeTwilioClient } from "./helpers/liveBoot.js";
import { clearStats, getLatencyStats } from "../lib/voice/metrics.js";

const OPEN = { open: "09:00", close: "18:00", closed: false };
const CONFIG = {
  businessName: "Digile Media",
  greeting: "Thanks for calling Digile Media.",
  mainPhone: "+18176011171",
  timezone: "America/Chicago",
  businessHours: { mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN },
  locale: "en-US",
  allowedTasks: ["book_appointment", "check_appointment", "take_message", "transfer_human"],
  transferPhoneNumber: "+441111222333",
  transferPolicy: "always",
  capabilities: {
    messages: { enabled: true },
    appointments: { enabled: true, adapter: "internal", availability: { length: 30, capacity: 1 } },
  },
};
const ENV = { BASE_URL: "https://voice.example.test" };
const WORDS = "Hi, I want a website built for my plumbing business.";
const INTENT = { intent: "general_question", caller_type: "new_enquiry", reason_given: true };
const c = () => getLatencyStats().turnTaking;

function fakeScheduler() {
  return { setTimer: (fn, ms) => ({ fn, ms, unref: vi.fn() }), clearTimer: () => {} };
}

describe("the after-call message on hand-off exits and appointment calls", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
    clearStats();
  });
  afterEach(() => vi.useRealTimers());

  async function boot(over = {}) {
    const sch = fakeScheduler();
    const marks = [];
    const s = await bootLive({
      config: CONFIG,
      env: ENV,
      setTimer: sch.setTimer,
      clearTimer: sch.clearTimer,
      twilioClient: fakeTwilioClient(),
      ...over,
    });
    s.ws.send = (raw) => {
      const m = JSON.parse(raw);
      if (m.event === "mark") marks.push(m.mark.name);
    };
    return { s, marks };
  }

  it("control: a lead who simply hangs up is written", async () => {
    const { s } = await boot();
    await s.callTool("set_call_intent", INTENT);
    await s.callerSays(WORDS);
    await s.hangUp();
    expect(c().message_saved_after_call).toBe(1);
  });

  it("I2: the stream stops while the transfer redirect is still awaited -> nothing", async () => {
    // The redirect never answers: transferStartedThisCall is still false at finish.
    const hanging = { calls: () => ({ update: () => new Promise(() => {}) }) };
    const { s, marks } = await boot({ twilioClient: hanging });
    await s.callTool("set_call_intent", INTENT);
    await s.callerSays(WORDS);
    await s.callTool("request_transfer", { reason: "billing" });
    await s.assistantTurn("Putting you through now.");
    expect(marks).toContain("live-exit-transfer");
    s.ws.deliver({ event: "mark", mark: { name: "live-exit-transfer" }, streamSid: "MZ1" });
    await s.settle();
    await s.hangUp();
    expect(c().message_saved_after_call ?? 0).toBe(0);
  });

  it("I2: a polite failure (voicemail hand-off) -> nothing", async () => {
    const { s } = await boot();
    await s.callTool("set_call_intent", INTENT);
    await s.callerSays(WORDS);
    s.live.close({ code: 1011, reason: "internal error" });
    await s.settle();
    await s.settle();
    expect(c().message_saved_after_call ?? 0).toBe(0);
  });

  it("I3: an existing client looks up their appointment, then hangs up -> nothing", async () => {
    const { s } = await boot();
    await s.callTool("get_caller_appointments_from_db", {});
    await s.callTool("set_call_intent", { ...INTENT, caller_type: "existing_customer" });
    await s.callerSays("Lovely, thanks, bye.");
    await s.hangUp();
    expect(c().message_saved_after_call ?? 0).toBe(0);
  });

  it("I3: an availability check, then 'I'll think about it' -> nothing", async () => {
    const { s } = await boot();
    await s.callTool("check_appointment_availability", { requested_at: "2026-09-18T15:30:00" });
    await s.callTool("set_call_intent", INTENT);
    await s.callerSays("Okay, I'll think about it.");
    await s.hangUp();
    expect(c().message_saved_after_call ?? 0).toBe(0);
  });

  it("I3: a lookup AND take_message reported -> written", async () => {
    const { s } = await boot();
    await s.callTool("get_caller_appointments_from_db", {});
    await s.callTool("set_call_intent", { intent: "take_message", caller_type: "existing_customer" });
    await s.callerSays("Can you ask him to call me about the invoice.");
    await s.hangUp();
    expect(c().message_saved_after_call).toBe(1);
  });
});

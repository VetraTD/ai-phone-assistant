// ---------------------------------------------------------------------------
// Round A1 "say it once" — the save policy (owner, 2026-10-13).
//
// "Save unless it HEARS a no" replaces "save only once it hears a clear yes":
//
//   message / quote request  no read-back gate; saved when the model calls it
//   booking / reschedule     one read-back (the previous turn OR the turn in
//                            progress), then saved unless the answer is a no,
//                            a question or a change; silence/garble = save
//   cancel                   UNCHANGED -- confirm once, ask again if unreadable
//   everything else          unchanged
//
// LVX177 measured why: 124 refusals over 67 saving calls, 73% on saves the
// caller wanted, and in 12 of 15 never-saved episodes the model claimed "done"
// anyway. These tests are Live-only by construction (callerSaidThisCall is
// non-null): the cascade never sets lastCallerText and is untouched.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateAppointment = vi.fn();
const mockUpdateAppointmentStatus = vi.fn();
const mockUpdateAppointment = vi.fn();
const mockGetAppointmentById = vi.fn();

vi.mock("../services/db.js", () => ({
  createAppointment: (...a) => mockCreateAppointment(...a),
  createAppointmentIfAvailable: async (p) => {
    const id = await mockCreateAppointment(p);
    return id ? { id } : { full: true };
  },
  countScheduledOverlapping: async () => 0,
  listScheduledBetween: async () => [],
  listAppointmentsByCaller: async () => [],
  updateAppointmentStatus: (...a) => mockUpdateAppointmentStatus(...a),
  updateAppointment: (...a) => mockUpdateAppointment(...a),
  getAppointmentById: (...a) => mockGetAppointmentById(...a),
}));
vi.mock("../services/integrations.js", () => ({ executeIntegration: vi.fn() }));
vi.mock("../lib/sentry.js", () => ({ captureException: vi.fn() }));

import { executeToolCall } from "../services/tools.js";
import { decideSave, saveRuleFor, composeReadBack } from "../lib/voice/savePolicy.js";
import { getStrings } from "../lib/voice/strings.js";
import { clearStats } from "../lib/voice/metrics.js";

const EN = getStrings({});
const DAY = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const SLOT = `${DAY}T10:00:00`;
const OTHER_SLOT = `${new Date(Date.now() + 31 * 86_400_000).toISOString().slice(0, 10)}T15:00:00`;
// What the composed read-back says for SLOT, so a fixture that reads it back
// names the slot exactly as the engine would.
const SAID = composeReadBack({ toolName: "book_appointment", args: { client_name: "Marcus Bell", scheduled_at: SLOT }, config: {}, callerSpelled: false });
const CANCEL_READ_BACK = `Just to confirm, you'd like to cancel your appointment on ${SAID.split(" for ")[0]}?`;

const live = (over = {}) => ({
  businessId: "biz-1",
  callerPhone: "+15551234567",
  callId: "call-1",
  integrations: [],
  capabilityState: {},
  config: {},
  spellingSettled: true,
  callerTurnCount: 4,
  callerSaidThisCall: "I'd like to book something",
  lastCallerText: "",
  lastReplyText: "",
  inTurnReplyText: "",
  ...over,
});

const book = (c, args = {}, id = "fc1") =>
  executeToolCall(
    { id, name: "book_appointment", args: { client_name: "Marcus Bell", scheduled_at: SLOT, notes: "consult", ...args } },
    c
  );
const cancel = (c) => executeToolCall({ id: "fc9", name: "cancel_appointment_db", args: { appointment_id: "a1" } }, c);
const message = (c) =>
  executeToolCall({ id: "m1", name: "record_customer_request", args: { request_type: "message" } }, c);

beforeEach(() => {
  clearStats();
  mockCreateAppointment.mockReset().mockResolvedValue("appt-1");
  mockUpdateAppointmentStatus.mockReset().mockResolvedValue(true);
  mockUpdateAppointment.mockReset().mockResolvedValue(true);
  mockGetAppointmentById.mockReset().mockResolvedValue({
    id: "a1",
    client_phone: "+15551234567",
    client_name: "Marcus Bell",
    scheduled_at: SLOT,
    status: "scheduled",
  });
});

describe("saveRuleFor — which rule a tool is on", () => {
  it.each([
    ["record_customer_request", "message"],
    ["record_quote_request", "message"],
    ["book_appointment", "booking"],
    ["reschedule_appointment_db", "booking"],
    ["cancel_appointment_db", "cancel"],
    ["correct_appointment_name", "strict"],
    ["add_appointment_note", "strict"],
    ["end_call", "strict"],
  ])("%s -> %s", (tool, rule) => {
    expect(saveRuleFor(tool)).toBe(rule);
  });
});

describe("decideSave — the pure decision", () => {
  const base = {
    toolName: "book_appointment",
    onLive: true,
    lastChance: false,
    engineRetry: false,
    writeSlot: SLOT,
    lastReplyText: "",
    inTurnReplyText: "",
    lastCallerText: "",
    callerRestatedSlot: false,
    strings: EN,
  };

  it("never applies off Live, to the end-of-call sweep, or to the engine's own retry", () => {
    expect(decideSave({ ...base, onLive: false }).applies).toBe(false);
    expect(decideSave({ ...base, toolName: "record_customer_request", lastChance: true }).applies).toBe(false);
    expect(decideSave({ ...base, engineRetry: true, lastReplyText: SAID }).applies).toBe(false);
  });

  it("never applies to a cancel or a strict tool", () => {
    expect(decideSave({ ...base, toolName: "cancel_appointment_db", lastReplyText: CANCEL_READ_BACK }).applies).toBe(false);
    expect(decideSave({ ...base, toolName: "correct_appointment_name" }).applies).toBe(false);
  });

  it("a message needs no read-back and no yes", () => {
    const d = decideSave({ ...base, toolName: "record_customer_request", writeSlot: null, lastCallerText: "umm" });
    expect(d).toMatchObject({ applies: true, rule: "message", readBackStanding: true, agreed: true });
  });

  it.each(["da, ja, das", "", "[inaudible]", "...", "Yes", "I love it."])(
    "a booking read back on the previous turn saves on %j",
    (said) => {
      const d = decideSave({ ...base, lastReplyText: SAID, lastCallerText: said });
      expect(d).toMatchObject({ applies: true, readBackSource: "previous", agreed: true, objection: false });
    }
  );

  // T5b (owner, 2026-10-13, reversing S1's ruling): a read-back followed by NO
  // voiced sound is held -- a person checks the caller is still there. The
  // "" case above is now the VOICED-but-untranscribed one; these are the split.
  it("a previous-turn read-back with NO sound since is held, awaiting the answer", () => {
    const d = decideSave({ ...base, lastReplyText: SAID, lastCallerText: "", callerVoicedSinceReply: false });
    expect(d).toMatchObject({
      applies: true,
      readBackStanding: true,
      readBackSource: "previous",
      agreed: false,
      objection: false,
      awaitingAnswer: true,
    });
  });

  it("the same with a sound the transcript lost saves", () => {
    const d = decideSave({ ...base, lastReplyText: SAID, lastCallerText: "", callerVoicedSinceReply: true });
    expect(d).toMatchObject({ readBackSource: "previous", agreed: true, awaitingAnswer: false });
  });

  it("silence does not hold an in-turn read-back, a message, or touch a cancel", () => {
    expect(decideSave({ ...base, inTurnReplyText: SAID, callerVoicedSinceReply: false })).toMatchObject({
      readBackSource: "in_turn",
      agreed: true,
    });
    expect(
      decideSave({ ...base, toolName: "record_customer_request", writeSlot: null, callerVoicedSinceReply: false })
    ).toMatchObject({ rule: "message", agreed: true });
    expect(
      decideSave({ ...base, toolName: "cancel_appointment_db", lastReplyText: CANCEL_READ_BACK, callerVoicedSinceReply: false })
        .applies
    ).toBe(false);
  });

  it("an absent wire (null) is not read as silence", () => {
    const d = decideSave({ ...base, lastReplyText: SAID, lastCallerText: "", callerVoicedSinceReply: null });
    expect(d).toMatchObject({ agreed: true, awaitingAnswer: false });
  });

  it.each(["No.", "What time was that?", "Make it four.", "Um.", "Can we do Friday instead?"])(
    "a booking read back on the previous turn is held on %j",
    (said) => {
      const d = decideSave({ ...base, lastReplyText: SAID, lastCallerText: said });
      expect(d).toMatchObject({ readBackSource: "previous", readBackStanding: true, agreed: false, objection: true });
    }
  );

  it("a read-back in the turn in progress saves -- nobody has answered it yet", () => {
    const d = decideSave({ ...base, inTurnReplyText: SAID, lastCallerText: "Could I do the 10 o'clock?" });
    expect(d).toMatchObject({ readBackSource: "in_turn", agreed: true });
  });

  it("a read-back of a DIFFERENT slot is no read-back at all", () => {
    const d = decideSave({ ...base, writeSlot: OTHER_SLOT, lastReplyText: SAID, lastCallerText: "yes" });
    expect(d).toMatchObject({ readBackStanding: false, agreed: false });
    const e = decideSave({ ...base, writeSlot: OTHER_SLOT, inTurnReplyText: SAID });
    expect(e).toMatchObject({ readBackStanding: false, agreed: false });
  });

  it("an offer that is not a read-back of anything does not count", () => {
    const d = decideSave({ ...base, lastReplyText: "Can I get your full name?", lastCallerText: "yes" });
    expect(d.readBackStanding).toBe(false);
  });
});

describe("composeReadBack — the one sentence the model is handed", () => {
  it("names the slot and the caller, and ends with what it is doing", () => {
    expect(SAID).toMatch(/ at 10:00 AM for Marcus Bell, booking that now\.$/);
    expect(EN.readBackStatementRe.test(SAID)).toBe(true);
    expect(EN.completionClaimRe.test(SAID)).toBe(false);
  });

  it("spells the surname letter by letter when the caller spelled it (LVX172)", () => {
    const s = composeReadBack({
      toolName: "book_appointment",
      args: { client_name: "Jon Dodla", scheduled_at: SLOT },
      config: {},
      callerSpelled: true,
    });
    expect(s).toMatch(/ for Jon, D-O-D-L-A, booking that now\.$/);
    expect(EN.spelledLettersRe.test(s)).toBe(true);
  });

  it("does not spell a name the caller never spelled", () => {
    const s = composeReadBack({ toolName: "book_appointment", args: { client_name: "Jon Dodla", scheduled_at: SLOT }, config: {} });
    expect(s).toMatch(/ for Jon Dodla, booking that now\.$/);
  });

  it("reads a reschedule as a move", () => {
    const s = composeReadBack({ toolName: "reschedule_appointment_db", args: { new_scheduled_at: SLOT }, config: {} });
    expect(s).toMatch(/^Moving your appointment to .* at 10:00 AM, moving it now\.$/);
    expect(EN.readBackStatementRe.test(s)).toBe(true);
  });
});

describe("messages and quote requests are not gated (owner: no read-back gate)", () => {
  it("saves with nothing read back and a hesitation for an answer", async () => {
    const { functionResponse } = await message(live({ lastCallerText: "umm" }));
    expect(functionResponse.response.success).toBe(true);
  });

  it("saves on a silent turn with no agreement anywhere on the call", async () => {
    const { functionResponse } = await message(live({ lastCallerText: "" }));
    expect(functionResponse.response.success).toBe(true);
  });

  it("saves on a turn that did not transcribe", async () => {
    const { functionResponse } = await message(live({ lastCallerText: "에레는" }));
    expect(functionResponse.response.success).toBe(true);
  });
});

describe("bookings: one read-back, then saved unless the caller objects", () => {
  it.each(["da, ja, das", "", "[inaudible]", "에레는"])(
    "saves after a previous-turn read-back answered %j",
    async (said) => {
      const { functionResponse } = await book(live({ lastReplyText: SAID, lastCallerText: said }));
      expect(functionResponse.response.success).toBe(true);
      expect(mockCreateAppointment).toHaveBeenCalledTimes(1);
    }
  );

  it.each(["No.", "What time was that?", "Make it four.", "Um."])(
    "holds after a previous-turn read-back answered %j",
    async (said) => {
      const { functionResponse } = await book(live({ lastReplyText: SAID, lastCallerText: said }));
      expect(functionResponse.response.success).toBe(false);
      expect(mockCreateAppointment).not.toHaveBeenCalled();
    }
  );

  // T5b: "" above stands for a sound the transcript lost (the wire absent reads
  // as before). Made explicit, and split from a read-back met by no sound.
  it("saves after a previous-turn read-back met by a sound the transcript lost", async () => {
    const { functionResponse } = await book(
      live({ lastReplyText: SAID, lastCallerText: "", callerVoicedSinceReply: true })
    );
    expect(functionResponse.response.success).toBe(true);
  });

  it("holds after a previous-turn read-back met by NO sound, and says to wait -- not that they objected", async () => {
    const { functionResponse, stateEffects } = await book(
      live({ lastReplyText: SAID, lastCallerText: "", callerVoicedSinceReply: false })
    );
    expect(functionResponse.response.success).toBe(false);
    expect(mockCreateAppointment).not.toHaveBeenCalled();
    expect(functionResponse.response.message).not.toMatch(/did not agree/i);
    expect(stateEffects.toolResult.message).not.toMatch(/what would you like to change/i);
    // Never a second yes (owner: rung 2 never asks for one; read back ONCE).
    // The silent-turn gate's own wording ("Ask them once, plainly, whether to
    // go ahead") is exactly that, so an awaiting booking gets the wait wording.
    expect(functionResponse.response.message).not.toMatch(/whether to go ahead/i);
    expect(functionResponse.response.message).toMatch(/WAIT/);
    expect(stateEffects.toolResult.message).not.toMatch(/go ahead/i);
    expect(stateEffects.toolResult.message).toBe("Hello? Are you still there?");
  });

  it("holds when the caller's last words came BEFORE the read-back and nothing since", async () => {
    const { functionResponse } = await book(
      live({ lastReplyText: SAID, lastCallerText: "Friday at ten works.", callerVoicedSinceReply: false })
    );
    expect(functionResponse.response.success).toBe(false);
    expect(functionResponse.response.message).toMatch(/WAIT/);
    expect(functionResponse.response.message).not.toMatch(/did not agree/i);
    expect(mockCreateAppointment).not.toHaveBeenCalled();
  });

  it("an objection is answered, not re-confirmed", async () => {
    const { functionResponse } = await book(live({ lastReplyText: SAID, lastCallerText: "What time was that?" }));
    expect(functionResponse.response.message).toMatch(/did not agree/);
    expect(functionResponse.response.message).toMatch(/do not ask them to confirm a second time/i);
  });

  it("saves when the read-back is in the turn being spoken right now", async () => {
    const { functionResponse } = await book(
      live({ inTurnReplyText: SAID, lastCallerText: "Can I come in at ten that day?" })
    );
    expect(functionResponse.response.success).toBe(true);
  });

  it("with nothing read back, refuses once and hands the model the sentence to say", async () => {
    const { functionResponse, stateEffects } = await book(live({ lastCallerText: "Ten works, book it" }));
    expect(functionResponse.response.success).toBe(false);
    expect(functionResponse.response.gated).toBe(true);
    expect(functionResponse.response.message).toContain(SAID);
    expect(stateEffects.toolResult.message).toBe(SAID);
    expect(mockCreateAppointment).not.toHaveBeenCalled();
  });

  it("the handed sentence spells the surname when the caller spelled it", async () => {
    const { functionResponse } = await book(
      live({ lastCallerText: "Ten works", callerSpelled: true }),
      { client_name: "Jon Dodla" }
    );
    expect(functionResponse.response.message).toContain("for Jon, D-O-D-L-A, booking that now.");
  });

  it("the model saying that sentence and calling again saves", async () => {
    const first = await book(live({ lastCallerText: "Ten works, book it" }));
    const said = first.stateEffects.toolResult.message;
    const { functionResponse } = await book(
      live({ lastCallerText: "Ten works, book it", inTurnReplyText: said, capabilityState: first.stateEffects.capabilityState })
    );
    expect(functionResponse.response.success).toBe(true);
  });

  it("a reschedule read back as a statement saves on a silent answer", async () => {
    const said = composeReadBack({ toolName: "reschedule_appointment_db", args: { new_scheduled_at: OTHER_SLOT }, config: {} });
    const { functionResponse } = await executeToolCall(
      { id: "r1", name: "reschedule_appointment_db", args: { appointment_id: "a1", new_scheduled_at: OTHER_SLOT } },
      live({ lastReplyText: said, lastCallerText: "" })
    );
    expect(functionResponse.response.success).toBe(true);
  });

  it("the engine's own retry keeps today's rule (code never acts on a looser yes)", async () => {
    const { functionResponse } = await book(
      live({ lastReplyText: "Just to confirm, shall I book that for you?", lastCallerText: "에레는" }),
      {},
      "retry_book_appointment"
    );
    expect(functionResponse.response.success).toBe(false);
    expect(mockCreateAppointment).not.toHaveBeenCalled();
  });

  // T8 (sabotage row engine-retry-stays-strict). The case above cannot tell the
  // two rules apart -- its read-back names no slot, so A1 refuses it too. This
  // one can: the SAME read-back of this slot and the same mangled answer save
  // when the model calls, and are held when the engine retries.
  it("the same answer that saves the model's call is held on the engine's retry", async () => {
    const ctx = () => live({ lastReplyText: SAID, lastCallerText: "da, ja, das" });
    const retried = await book(ctx(), {}, "retry_book_appointment");
    expect(retried.functionResponse.response.success).toBe(false);
    expect(mockCreateAppointment).not.toHaveBeenCalled();
    const model = await book(ctx(), {}, "fc_model");
    expect(model.functionResponse.response.success).toBe(true);
  });
});

// Round A1, T6: write-gate refusals were process counters and log lines only,
// so "how many times was THIS caller held" had no per-call answer. Each gate
// now tags its refusal; lib/voice/live/index.js counts the tags per call.
describe("writeGateRefusal — which gate held the write (T6)", () => {
  it("silent turn (gate a): consent", async () => {
    const { stateEffects } = await book(live({ lastReplyText: SAID, lastCallerText: "", callerVoicedSinceReply: false }));
    expect(stateEffects.writeGateRefusal).toBe("consent");
  });

  it("bare hesitation (gate b): hesitation", async () => {
    const { stateEffects } = await book(live({ lastReplyText: SAID, lastCallerText: "Um." }));
    expect(stateEffects.writeGateRefusal).toBe("hesitation");
  });

  it("unusable transcript (gate c): unusable", async () => {
    const { stateEffects } = await cancel(live({ lastReplyText: CANCEL_READ_BACK, lastCallerText: "에레는" }));
    expect(stateEffects.writeGateRefusal).toBe("unusable");
  });

  it("no read-back standing (gate d): write_order", async () => {
    const { stateEffects } = await book(live({ lastReplyText: "Thanks, Marcus.", lastCallerText: "Book it please." }));
    expect(stateEffects.writeGateRefusal).toBe("write_order");
  });

  it("a save carries no tag", async () => {
    const { functionResponse, stateEffects } = await book(live({ lastReplyText: SAID, lastCallerText: "Yes." }));
    expect(functionResponse.response.success).toBe(true);
    expect(stateEffects.writeGateRefusal).toBeUndefined();
  });
});

describe("CANCELS STAY STRICT (owner: unchanged) -- fails if anyone loosens them", () => {
  it.each([
    ["a loose yes", "I love it."],
    ["a mangled yes", "da, ja, das"],
    ["a turn that did not transcribe", "에레는"],
  ])("refuses a cancel answered with %s", async (_label, said) => {
    const { functionResponse } = await cancel(live({ lastReplyText: CANCEL_READ_BACK, lastCallerText: said }));
    expect(functionResponse.response.success).toBe(false);
    expect(mockUpdateAppointmentStatus).not.toHaveBeenCalled();
  });

  it("refuses a cancel on a silent turn with no agreement on the call", async () => {
    const { functionResponse } = await cancel(live({ lastReplyText: CANCEL_READ_BACK, lastCallerText: "" }));
    expect(functionResponse.response.success).toBe(false);
    expect(mockUpdateAppointmentStatus).not.toHaveBeenCalled();
  });

  it("refuses a cancel whose only read-back is in the turn being spoken", async () => {
    const { functionResponse } = await cancel(
      live({ inTurnReplyText: CANCEL_READ_BACK, lastCallerText: "I need to cancel my appointment." })
    );
    expect(functionResponse.response.success).toBe(false);
    expect(mockUpdateAppointmentStatus).not.toHaveBeenCalled();
  });

  it.each(["Ja.", "Yes, please."])("still cancels on a clear yes: %j", async (said) => {
    const { functionResponse } = await cancel(live({ lastReplyText: CANCEL_READ_BACK, lastCallerText: said }));
    expect(functionResponse.response.success).toBe(true);
  });
});

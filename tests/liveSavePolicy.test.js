// ---------------------------------------------------------------------------
// Round A1 "say it once" — the save policy (owner, 2026-10-13).
//
// "Save unless it HEARS a no" replaces "save only once it hears a clear yes":
//
//   message / quote request  no read-back gate; saved when the model calls it
//   booking / reschedule     ONE question read-back of this slot in the
//                            previous turn, then saved on any sound that is not
//                            a no, a question or a change; garble = save,
//                            silence = held. A read-back in the turn being
//                            spoken, or a statement ("…booking that now"),
//                            only ever holds (LVX179, owner 2026-10-16).
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
// The day and time alone, as the engine says them ("Friday, … at 10:00 AM").
const WHEN = SAID.replace(/^So that's /, "").split(" for ")[0];
const CANCEL_READ_BACK = `Just to confirm, you'd like to cancel your appointment on ${WHEN}?`;
// The S2 same-breath STATEMENT form, which LVX179 retired as a confirmation.
const STATEMENT = `${WHEN} for Marcus Bell, booking that now.`;

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

  it("silence holds an in-turn read-back; it does not hold a message or touch a cancel", () => {
    expect(decideSave({ ...base, inTurnReplyText: SAID, callerVoicedSinceReply: false })).toMatchObject({
      readBackSource: "in_turn",
      agreed: false,
      awaitingAnswer: true,
    });
    expect(
      decideSave({ ...base, toolName: "record_customer_request", writeSlot: null, callerVoicedSinceReply: false })
    ).toMatchObject({ rule: "message", agreed: true });
    expect(
      decideSave({ ...base, toolName: "cancel_appointment_db", lastReplyText: CANCEL_READ_BACK, callerVoicedSinceReply: false })
        .applies
    ).toBe(false);
  });

  // Final review I2 + LVX179. A read-back that ASKS, in the same breath as the
  // tool call, has asked for an answer; saving before it comes is the CA6b662e
  // / LVX95 shape. Held, awaiting the answer -- and it stands next turn.
  it("an in-turn read-back that asks a question awaits the answer", () => {
    const asked = `Just to confirm, ${WHEN} for Marcus Bell. Shall I go ahead and book that?`;
    const d = decideSave({ ...base, inTurnReplyText: asked });
    expect(d).toMatchObject({ readBackSource: "in_turn", readBackStanding: true, agreed: false, awaitingAnswer: true });
  });

  // LVX179 (call b CA70682e): the same-breath statement booked 9 AM, a time
  // nobody chose. A statement tells the caller; it does not ask them.
  it("an in-turn STATEMENT read-back never saves: held, and the caller still has to be asked", () => {
    const d = decideSave({ ...base, inTurnReplyText: STATEMENT, callerVoicedSinceReply: true, lastCallerText: "umm" });
    expect(d).toMatchObject({ readBackSource: "in_turn_statement", readBackStanding: false, agreed: false, awaitingAnswer: false });
  });

  it("a previous-turn STATEMENT read-back is not the question, whatever the caller said", () => {
    const d = decideSave({ ...base, lastReplyText: STATEMENT, lastCallerText: "Okay.", callerVoicedSinceReply: true });
    expect(d).toMatchObject({ readBackSource: "previous_statement", readBackStanding: false, agreed: false });
  });

  it("a question answered in the previous turn saves even if the model says the statement as it calls", () => {
    const d = decideSave({ ...base, lastReplyText: SAID, lastCallerText: "Yes.", callerVoicedSinceReply: true, inTurnReplyText: STATEMENT });
    expect(d).toMatchObject({ readBackSource: "previous", agreed: true });
  });

  it("'booking that now. Anything else?' asks nothing about the booking", () => {
    const d = decideSave({ ...base, lastReplyText: `${STATEMENT} Is there anything else?`, lastCallerText: "No.", callerVoicedSinceReply: true });
    expect(d).toMatchObject({ readBackSource: "previous_statement", agreed: false });
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

  it("a read-back in the turn in progress never saves -- nobody has answered it yet", () => {
    const d = decideSave({ ...base, inTurnReplyText: SAID, lastCallerText: "Could I do the 10 o'clock?" });
    expect(d).toMatchObject({ readBackSource: "in_turn", agreed: false, awaitingAnswer: true });
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

describe("composeReadBack — the ONE question the model is handed (LVX179)", () => {
  it("names the slot and the caller, and ASKS", () => {
    expect(SAID).toMatch(/^So that's .* at 10:00 AM for Marcus Bell, is that right\?$/);
    expect(EN.confirmReadBackRe.test(SAID)).toBe(true);
    expect(EN.readBackStatementRe.test(SAID)).toBe(false);
    expect(EN.completionClaimRe.test(SAID)).toBe(false);
  });

  it("spells every name letter by letter when the caller spelled it (LVX172, LVX179)", () => {
    const s = composeReadBack({
      toolName: "book_appointment",
      args: { client_name: "Jon Dodla", scheduled_at: SLOT },
      config: {},
      callerSpelled: true,
    });
    expect(s).toMatch(/ for Jon, J-O-N, Dodla, D-O-D-L-A, is that right\?$/);
    expect(EN.spelledLettersRe.test(s)).toBe(true);
  });

  it("does not spell a name the caller never spelled", () => {
    const s = composeReadBack({ toolName: "book_appointment", args: { client_name: "Jon Dodla", scheduled_at: SLOT }, config: {} });
    expect(s).toMatch(/ for Jon Dodla, is that right\?$/);
  });

  it("reads a reschedule as a move", () => {
    const s = composeReadBack({ toolName: "reschedule_appointment_db", args: { new_scheduled_at: SLOT }, config: {} });
    expect(s).toMatch(/^So that's moving your appointment to .* at 10:00 AM, is that right\?$/);
    expect(EN.confirmReadBackRe.test(s)).toBe(true);
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

describe("bookings: ONE question, then saved on anything but a no (LVX179)", () => {
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

  // Final review I4: a yes that carries a change is a change. isAffirmative
  // alone used to pass the write-order gate and book the OLD slot.
  it.each(["Yeah, make it four.", "Sure, can we make it 4 though", "Yeah, what time was that again?"])(
    "holds a yes that carries a change or a question: %j",
    async (said) => {
      const { functionResponse } = await book(live({ lastReplyText: SAID, lastCallerText: said }));
      expect(functionResponse.response.success).toBe(false);
      // HELD, not failed: retryPendingWrite and the claim guard branch on it.
      expect(functionResponse.response.gated).toBe(true);
      expect(mockCreateAppointment).not.toHaveBeenCalled();
    }
  );

  // Round A1 part 4, F-C (CAdefce6ab): the model said its OWN read-back with a
  // bare hour -- "Wednesday at 10 for Priya Raman, …" -- and the gate could not
  // read it, so it handed sentence S on top: the caller heard the read-back
  // twice. Anchored to the slot's weekday, the model's own QUESTION counts.
  it("saves on the model's own question that names the weekday and a bare hour", async () => {
    const weekday = new Date(`${DAY}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    const { functionResponse } = await book(
      live({ lastReplyText: `${weekday} at 10 for Marcus Bell, is that right?`, lastCallerText: "Yes.", callerVoicedSinceReply: true })
    );
    expect(functionResponse.response.success).toBe(true);
    expect(mockCreateAppointment).toHaveBeenCalledTimes(1);
  });

  // LVX179 (call b CA70682e): the same shape said as a statement in the same
  // breath as the call booked 9 AM, a time nobody chose. Now held.
  it("holds a same-breath STATEMENT read-back, however well it names the slot", async () => {
    const weekday = new Date(`${DAY}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    const { functionResponse } = await book(
      live({ inTurnReplyText: `${weekday} at 10 for Marcus Bell, booking that now.`, lastCallerText: "Ten works." })
    );
    expect(functionResponse.response.success).toBe(false);
    expect(functionResponse.response.message).toContain(SAID);
    expect(functionResponse.response.message).toMatch(/You told the caller you were booking it/);
    expect(mockCreateAppointment).not.toHaveBeenCalled();
  });

  it("holds a booking whose read-back is a question asked in the same breath", async () => {
    const asked = `Just to confirm, ${WHEN} for Marcus Bell. Shall I go ahead and book that?`;
    const { functionResponse } = await book(live({ inTurnReplyText: asked, lastCallerText: "Ten works." }));
    expect(functionResponse.response.success).toBe(false);
    expect(functionResponse.response.message).toMatch(/WAIT/);
    expect(functionResponse.response.message).not.toMatch(/whether to go ahead/i);
    expect(mockCreateAppointment).not.toHaveBeenCalled();
  });

  it("a held awaiting booking is stashed, so the caller's yes can re-issue it", async () => {
    const { stateEffects } = await book(
      live({ lastReplyText: SAID, lastCallerText: "", callerVoicedSinceReply: false })
    );
    const packs = Object.values(stateEffects.capabilityState || {});
    expect(packs.some((p) => p?.pendingWrite?.name === "book_appointment")).toBe(true);
  });

  it("an objection is answered, not re-confirmed", async () => {
    const { functionResponse } = await book(live({ lastReplyText: SAID, lastCallerText: "What time was that?" }));
    expect(functionResponse.response.message).toMatch(/did not agree/);
    expect(functionResponse.response.message).not.toContain(SAID);
  });

  it("holds when the question is in the turn being spoken right now -- nobody has answered it", async () => {
    const { functionResponse } = await book(
      live({ inTurnReplyText: SAID, lastCallerText: "Can I come in at ten that day?" })
    );
    expect(functionResponse.response.success).toBe(false);
    expect(functionResponse.response.message).toMatch(/WAIT/);
    expect(mockCreateAppointment).not.toHaveBeenCalled();
  });

  it("with nothing read back, refuses once and hands the model the sentence to say", async () => {
    const { functionResponse, stateEffects } = await book(live({ lastCallerText: "Ten works, book it" }));
    expect(functionResponse.response.success).toBe(false);
    expect(functionResponse.response.gated).toBe(true);
    expect(functionResponse.response.message).toContain(SAID);
    expect(stateEffects.toolResult.message).toBe(SAID);
    expect(mockCreateAppointment).not.toHaveBeenCalled();
  });

  it("the handed question spells every name when the caller spelled it", async () => {
    const { functionResponse } = await book(
      live({ lastCallerText: "Ten works", callerSpelled: true }),
      { client_name: "Jon Dodla" }
    );
    expect(functionResponse.response.message).toContain("for Jon, J-O-N, Dodla, D-O-D-L-A, is that right?");
  });

  // F2 (owner, A1 part 3, CAff059ed): the letters were lost on the line, the
  // model was handed "...booking that now", said it, and only THEN was asked
  // to spell. When both gates would hold, the spelling question goes first.
  it("with nothing read back and the spelling still needed, asks for the spelling first -- no 'booking that now'", async () => {
    const { functionResponse, stateEffects } = await book(
      live({ spellingSettled: false, lastCallerText: "Marcus Bell, ten works" })
    );
    expect(functionResponse.response.gated).toBe(true);
    expect(functionResponse.response.message).toMatch(/FULL name/);
    expect(functionResponse.response.message).not.toMatch(/booking that now/);
    expect(stateEffects.writeGateRefusal).toBe("spelling");
    expect(mockCreateAppointment).not.toHaveBeenCalled();
  });

  it("once spelled, the next attempt is handed the one sentence, letters inside it", async () => {
    const { functionResponse, stateEffects } = await book(
      live({ spellingSettled: true, callerSpelled: true, lastCallerText: "B, E, L, L" })
    );
    expect(stateEffects.writeGateRefusal).toBe("write_order");
    expect(functionResponse.response.message).toContain("for Marcus, M-A-R-C-U-S, Bell, B-E-L-L, is that right?");
  });

  it("the model asking that question holds until the caller answers, then saves", async () => {
    const first = await book(live({ lastCallerText: "Ten works, book it" }));
    const said = first.stateEffects.toolResult.message;
    // Asked and called in one breath: nobody has answered yet.
    const second = await book(
      live({ lastCallerText: "Ten works, book it", inTurnReplyText: said, capabilityState: first.stateEffects.capabilityState })
    );
    expect(second.functionResponse.response.success).toBe(false);
    expect(mockCreateAppointment).not.toHaveBeenCalled();
    // The caller answers it -- with anything but a no.
    const { functionResponse } = await book(
      live({ lastReplyText: said, lastCallerText: "Yeah.", callerVoicedSinceReply: true, capabilityState: second.stateEffects.capabilityState })
    );
    expect(functionResponse.response.success).toBe(true);
    expect(mockCreateAppointment).toHaveBeenCalledTimes(1);
  });

  it("a reschedule asked about once saves on an answer the transcript lost", async () => {
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
  // LVX179: SAID is now a question, which the old rule also recognises, and
  // the old rule's own O3 leniency then accepts "da, ja, das". The case that
  // still separates them: a sound with no words yet (the transcript lags 5-10 s
  // on Live). The model heard it and called; code has nothing to go on.
  it("the same answer that saves the model's call is held on the engine's retry", async () => {
    const ctx = () => live({ lastReplyText: SAID, lastCallerText: "", callerVoicedSinceReply: true });
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

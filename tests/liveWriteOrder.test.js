// ---------------------------------------------------------------------------
// LVX95 — the confirmation was spoken AFTER the write, and nothing required it
// to come first.
//
// Call be9bd6, 2026-09-09, the first Live call able to cancel anything. Sixty
// seconds, and the caller asked to cancel all three of their appointments:
//
//   04:52:54  get_caller_appointments_from_db   ok
//   04:53:13  cancel_appointment_db   success=true
//   04:53:13  cancel_appointment_db   success=true
//   04:53:13  cancel_appointment_db   success=true
//   04:53:27  "Of course. Just to confirm, you'd like to cancel all three of
//              your upcoming appointments? ..."
//   04:53:33  end_call
//
// Every claim on that call was TRUE. Three tools ran, three rows changed,
// tool_duration.success was true on all three. The defect is ORDERING: the
// three writes committed fourteen seconds before the confirmation question was
// asked, and the model went to end_call six seconds after asking, without
// waiting for an answer that could not have changed anything.
//
// WHY confirmBeforeWrite DOES NOT FIX IT. That requirement exists and defaults
// off, and turning it on leaves enforcement as a tool ARGUMENT the model sets
// about itself (lib/capabilities/requirements.js:402). Nothing verifies that a
// read-back happened, that the caller answered, or that the answer was yes. It
// is an honour system, and this call is the evidence about the honour: a model
// that will narrate a confirmation after the fact is a model that will set the
// flag before it.
//
// So both halves are read off the call instead:
//   - the assistant's PREVIOUS completed turn put the action to the caller
//   - the caller's answer parses as agreement
// Neither can be produced by choosing a tool argument.
//
// These tests are the certification. Remove the gate and the refusal cases go
// red; the control cases go red if it is made too broad, and the ceiling case
// goes red if the escape hatch is removed -- which would turn a phrasing list
// into a livelock.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateAppointment = vi.fn();
const mockUpdateAppointmentStatus = vi.fn();
const mockGetAppointmentById = vi.fn();
const mockListAppointmentsByCaller = vi.fn();

vi.mock("../services/db.js", () => ({
  createAppointment: (...a) => mockCreateAppointment(...a),
  createAppointmentIfAvailable: async (p) => {
    const id = await mockCreateAppointment(p);
    return id ? { id } : { full: true };
  },
  countScheduledOverlapping: async () => 0,
  listScheduledBetween: async () => [],
  listAppointmentsByCaller: (...a) => mockListAppointmentsByCaller(...a),
  updateAppointmentStatus: (...a) => mockUpdateAppointmentStatus(...a),
  updateAppointment: async () => false,
  getAppointmentById: (...a) => mockGetAppointmentById(...a),
}));
vi.mock("../services/integrations.js", () => ({ executeIntegration: vi.fn() }));
vi.mock("../lib/sentry.js", () => ({ captureException: vi.fn() }));

import { executeToolCall } from "../services/tools.js";
import { clearStats, getLatencyStats } from "../lib/voice/metrics.js";

const FUTURE_SLOT = `${new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)}T10:00:00`;
const READ_BACK = "Just to confirm, shall I go ahead and book that for you?";
const FUTURE_SLOT_ISO = new Date(Date.now() + 30 * 86_400_000).toISOString();

const ctx = ({ said = "Yes", replied = READ_BACK, capabilityState = {}, config = {}, turn = 4 } = {}) => ({
  businessId: "biz-1",
  callerPhone: "+15551234567",
  callId: "call-1",
  integrations: [],
  capabilityState,
  config,
  // Settled, so nothing below can be the spelling gate.
  spellingSettled: true,
  // The budget is spent per CALLER TURN, so anything driving more than one
  // attempt has to move this or the second refusal silently costs nothing.
  callerTurnCount: turn,
  lastCallerText: said,
  lastReplyText: replied,
});

const book = (c) =>
  executeToolCall(
    {
      id: "fc1",
      name: "book_appointment",
      args: { client_name: "Marcus Bell", scheduled_at: FUTURE_SLOT, notes: "consultation" },
    },
    c
  );

const counters = () => getLatencyStats().turnTaking;

beforeEach(() => {
  clearStats();
  vi.clearAllMocks();
  mockCreateAppointment.mockResolvedValue("appt-1");
  mockListAppointmentsByCaller.mockResolvedValue([]);
});

describe("LVX95 — a write needs a read-back that happened and a yes that was heard", () => {
  it("refuses a write when the previous turn never put it to the caller", async () => {
    // The shape of be9bd6: the assistant listed the appointments, the caller
    // said what they wanted, and the write went out on the same turn the
    // request was understood.
    const { functionResponse, stateEffects } = await book(
      ctx({ said: "Cancel all three of them", replied: "You have three appointments coming up." })
    );

    expect(functionResponse.response.success).toBe(false);
    expect(mockCreateAppointment).not.toHaveBeenCalled();
    expect(counters().write_order_refused).toBe(1);
    expect(counters().write_confirm_readback_missing).toBe(1);
    // Silent, like the spelling gate's: nothing ran, so the session must not
    // narrate work that was declined.
    expect(stateEffects.toolCallEvent.silent).toBe(true);
    expect(stateEffects.toolResult.callerSafe).toBe(true);
  });

  it("refuses when the read-back was made and the caller changed something", async () => {
    // "Yes, but..." is the case a bare yes/no test misses, and it is the one
    // that matters: the caller is agreeing to a DIFFERENT thing from the one
    // that was read back.
    const { functionResponse } = await book(ctx({ said: "Yes, but make it Thursday instead" }));

    expect(functionResponse.response.success).toBe(false);
    expect(mockCreateAppointment).not.toHaveBeenCalled();
    expect(counters().write_confirm_readback_prev_turn).toBe(1);
    expect(counters().write_order_refused).toBe(1);
  });

  it("allows the write when both halves are there", async () => {
    const { functionResponse } = await book(ctx({ said: "Yes, that's right" }));

    expect(functionResponse.response.success).toBe(true);
    expect(mockCreateAppointment).toHaveBeenCalled();
    expect(counters().write_order_refused).toBeFalsy();
    expect(counters().write_confirm_readback_prev_turn).toBe(1);
  });

  it('accepts "Okay" as the yes, because that is how people agree on a phone', async () => {
    // The opposite rule from the hang-up gate, and deliberately so. That gate
    // follows "is there anything else?", where a vague "okay" is not a no, so
    // it uses stripFillers -- whose list swallows "Okay" on purpose. This one
    // follows "shall I go ahead?", where refusing on "Okay" would be its own
    // defect (services/tools.js records exactly that argument).
    for (const said of ["Okay", "Okay.", "Sure", "Yep", "Mm-hmm", "Go ahead", "Please do"]) {
      clearStats();
      vi.clearAllMocks();
      mockCreateAppointment.mockResolvedValue("appt-1");
      const { functionResponse } = await book(ctx({ said }));
      expect(functionResponse.response.success, said).toBe(true);
    }
  });

  it("covers a cancellation regardless of tenant configuration", async () => {
    // The owner's decision, 2026-09-09: a cancellation is not recoverable by
    // the caller, so it is gated on every tenant whether or not they have a
    // business_capabilities row. Brightwork Studio had none, which is why
    // confirmBeforeWrite was off and nothing stopped be9bd6.
    mockGetAppointmentById.mockResolvedValue({
      id: "a1",
      client_phone: "+15551234567",
      scheduled_at: FUTURE_SLOT,
      status: "scheduled",
    });

    const { functionResponse } = await executeToolCall(
      { id: "fc2", name: "cancel_appointment_db", args: { appointment_id: "a1" } },
      ctx({ said: "Cancel all three", replied: "You have three appointments coming up." })
    );

    expect(functionResponse.response.success).toBe(false);
    expect(mockUpdateAppointmentStatus).not.toHaveBeenCalled();
    expect(counters().write_order_refused).toBe(1);
  });

  it("works in Spanish, or it protects only English callers", async () => {
    const { functionResponse } = await book(
      ctx({
        config: { languagesSpoken: ["es"] },
        replied: "Para confirmar, ¿procedo con la cita del martes?",
        said: "Sí, está bien",
      })
    );

    expect(functionResponse.response.success).toBe(true);
    expect(counters().write_confirm_readback_prev_turn).toBe(1);
  });
});

describe("LVX95 — the three bounds, each of which is load-bearing", () => {
  it("releases the write after two attempts at the SAME proposal", async () => {
    // WITHOUT THIS the gate is a livelock. If the model re-reads a proposal in
    // words confirmReadBackRe cannot see, or the caller's "yes" is lost in
    // transcription -- and 2026-09-09 proved a caller turn can vanish from the
    // transcript entirely -- the write would be refused forever.
    //
    // Driven through real refusals rather than seeded state, because the budget
    // is keyed to the proposal now and a hand-written key would be testing the
    // fixture rather than the gate.
    const unchanged = { said: "Cancel all three", replied: READ_BACK };

    const first = await book(ctx(unchanged));
    expect(first.functionResponse.response.success).toBe(false);
    const afterFirst = first.stateEffects.capabilityState;

    const second = await book(ctx({ ...unchanged, capabilityState: afterFirst, turn: 5 }));
    expect(second.functionResponse.response.success).toBe(false);
    const afterSecond = second.stateEffects.capabilityState;

    clearStats();
    const third = await book(ctx({ ...unchanged, capabilityState: afterSecond, turn: 6 }));

    expect(third.functionResponse.response.success).toBe(true);
    expect(counters().write_order_gate_ceiling).toBe(1);
    expect(counters().write_order_refused).toBeFalsy();
    // Still counted as a situation. The ceiling changes what we DO, never what
    // we know.
    expect(counters().write_order_would_refuse).toBe(1);
  });

  it("gives a CHANGED proposal a fresh budget", async () => {
    // The correction of 2026-09-09, and the call that forced it. Two refusals
    // were spent on a caller who was still changing their mind:
    //
    //   A: "...you're booking a second appointment? Who is it for?"
    //   C: "You can use the same name. I actually do Nitin Dodla."   refused
    //   A: "You're booking another for Nithin Dodla... Shall I confirm?"
    //   C: "Yeah, actually, could you change the name to <...>?"      refused
    //
    // Both refusals were CORRECT -- read-back recognised, no agreement given.
    // They then burned the whole budget, and the write that followed landed on
    // a turn whose only content was the caller spelling a name.
    //
    // There is no livelock when the caller is the one moving: every new
    // read-back is a new question, and they can end it at any time by agreeing.
    const first = await book(
      ctx({ said: "Actually make it Thursday", replied: "Just to confirm, shall I book Tuesday?" })
    );
    const second = await book(
      ctx({
        said: "No, sorry, Friday",
        replied: "Just to confirm, shall I book Thursday?",
        capabilityState: first.stateEffects.capabilityState,
        turn: 5,
      })
    );

    clearStats();
    const third = await book(
      ctx({
        said: "Hmm, what about Monday",
        replied: "Just to confirm, shall I book Friday?",
        capabilityState: second.stateEffects.capabilityState,
        turn: 6,
      })
    );

    // Third refusal in a row, and NOT released: each was a different question.
    expect(third.functionResponse.response.success).toBe(false);
    expect(counters().write_order_refused).toBe(1);
    expect(counters().write_order_gate_ceiling).toBeFalsy();
    expect(mockCreateAppointment).not.toHaveBeenCalled();
  });

  it("spends a refusal only on a NEW caller turn", async () => {
    // Per caller TURN, not per tool round. services/gemini.js rebuilds ctx from
    // merged capabilityState after every round, so a model calling the same
    // tool three times inside one turn would otherwise burn the whole budget
    // without the caller ever being asked anything.
    const sameTurn = { appointments: { writeOrderRefusals: 1, writeOrderRefusedTurn: 4 } };
    const { stateEffects } = await book(
      ctx({
        said: "Cancel all three",
        replied: "You have three appointments coming up.",
        capabilityState: sameTurn,
      })
    );

    expect(stateEffects.capabilityState.appointments.writeOrderRefusals).toBeUndefined();
  });

  it("counts but does not refuse when the switch is off", async () => {
    // Every guard on this path has an off switch, and the measurement has to
    // survive it: a gate turned off that also stops reporting leaves nobody
    // able to say whether turning it back on is safe.
    const prev = process.env.LIVE_WRITE_ORDER_GATE;
    process.env.LIVE_WRITE_ORDER_GATE = "off";
    try {
      const { functionResponse } = await book(
        ctx({ said: "Cancel all three", replied: "You have three appointments coming up." })
      );

      expect(functionResponse.response.success).toBe(true);
      expect(counters().write_order_would_refuse).toBe(1);
      expect(counters().write_order_refused).toBeFalsy();
      expect(counters().write_confirm_readback_missing).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.LIVE_WRITE_ORDER_GATE;
      else process.env.LIVE_WRITE_ORDER_GATE = prev;
    }
  });

  it("leaves the cascade byte-identical — it never sets lastCallerText", async () => {
    const c = ctx({ said: "Cancel all three", replied: "You have three appointments coming up." });
    delete c.lastCallerText;

    const { functionResponse } = await book(c);

    expect(functionResponse.response.success).toBe(true);
    expect(counters().write_order_would_refuse).toBeFalsy();
    expect(counters().write_confirm_readback_missing).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// TWO GATES, ALTERNATING, AND NEITHER ONE EVER EXHAUSTS.
//
// Call CA9e3788, 2026-09-10. Four book_appointment attempts, all refused, no
// row, and the caller was told "that's all set":
//
//   19:13:25  book -> write-order refused
//   19:13:52  book -> spelling gate refused
//   19:14:43  book -> write-order refused
//   19:14:51  book -> spelling gate refused      ...then the model gave up.
//
// WRITE_ORDER_MAX_REFUSALS is 2 and spellMissCap() is 2, so on paper both are
// bounded. But each gate only SAW two of the four attempts, so each counted to
// two while the caller sat through four. Every gate here has an escape hatch
// keyed to its own refusals, and nothing was counting the thing the caller
// actually experiences: attempts at this write.
//
// LVX104's lesson one level up. An escape hatch has a population, and this
// population spans two gates that cannot see each other.
//
// THE KEY IS THE PROPOSAL WITHOUT THE NAME. A spelling correction changes
// client_name on every retry -- that is the whole point of the exchange -- so a
// fingerprint including the name would reset the budget on each correction and
// rebuild the exact livelock this closes. A different TIME is a new proposal
// and does reset it, which is what LVX104 requires.
// ---------------------------------------------------------------------------
describe("the shared attempt budget — refusals across gates, counted together", () => {
  // Production merges capabilityState per capability (lib/capabilities/effects.js
  // mergeCapabilityState), it does not replace it. Two different gates write
  // different fields on the same pack, so a test that replaced would lose one
  // gate's bookkeeping and prove nothing.
  const merge = (prior, patch) => {
    const out = { ...prior };
    for (const [cap, value] of Object.entries(patch || {})) {
      out[cap] = { ...(out[cap] || {}), ...value };
    }
    return out;
  };

  const attempt = ({ capabilityState, turn, said, settled, name = "Marcus Bell", when = FUTURE_SLOT }) =>
    executeToolCall(
      { id: "fc1", name: "book_appointment", args: { client_name: name, scheduled_at: when, notes: "consultation" } },
      {
        businessId: "biz-1",
        callerPhone: "+15551234567",
        callId: "call-1",
        integrations: [],
        capabilityState,
        config: {},
        spellingSettled: settled,
        callerTurnCount: turn,
        lastCallerText: said,
        lastReplyText: READ_BACK,
      }
    );

  // The sequence alternates on purpose. Three refusals from ONE gate would trip
  // that gate's own ceiling of two first, which is correct and is not what this
  // is about -- the shared budget exists only for the case where no single gate
  // ever sees enough refusals to act.
  const alternateToCeiling = async (nameFor = () => "Marcus Bell") => {
    let cs = {};
    // spelling refuses: the caller agreed, so write-order is satisfied.
    const a = await attempt({ capabilityState: cs, turn: 4, said: "Yes", settled: false, name: nameFor(0) });
    expect(a.functionResponse.response.success).toBe(false);
    cs = merge(cs, a.stateEffects.capabilityState);

    // write-order refuses: no agreement this time.
    const b = await attempt({ capabilityState: cs, turn: 5, said: "No, hang on", settled: true, name: nameFor(1) });
    expect(b.functionResponse.response.success).toBe(false);
    cs = merge(cs, b.stateEffects.capabilityState);

    // spelling again. Shared count is now three; neither gate is at its own two.
    const c = await attempt({ capabilityState: cs, turn: 6, said: "Yes", settled: false, name: nameFor(2) });
    expect(c.functionResponse.response.success).toBe(false);
    return merge(cs, c.stateEffects.capabilityState);
  };

  it("releases the write once the ATTEMPT budget is spent, whichever gates refused", async () => {
    const cs = await alternateToCeiling();

    clearStats();
    // The write-order gate would refuse again on its own count, which is one of
    // its permitted two. The shared budget is the only thing that ends this.
    const d = await attempt({ capabilityState: cs, turn: 7, said: "No, hang on", settled: true });

    expect(d.functionResponse.response.success).toBe(true);
    expect(counters().write_attempt_budget_released).toBe(1);
    expect(mockCreateAppointment).toHaveBeenCalled();
  });

  it("does NOT reset when only the NAME changes — that is the spelling exchange", async () => {
    // The call that forced this. The caller spells, the model retries with a
    // different client_name, and if that counted as a new proposal the budget
    // would restart on every correction and never run out.
    const names = ["Venkat Yalavarupu", "Venkat Ayalavarupu", "Venkat Yalavarapu"];
    const cs = await alternateToCeiling((i) => names[i]);

    clearStats();
    const released = await attempt({
      capabilityState: cs,
      turn: 7,
      said: "No, hang on",
      settled: true,
      name: "Venkat Yalavarapu",
    });
    expect(released.functionResponse.response.success).toBe(true);
    expect(counters().write_attempt_budget_released).toBe(1);
  });

  it("DOES reset when the caller proposes a different time", async () => {
    // LVX104, preserved. A caller changing their mind is the opposite of a
    // livelock: there is no trap, because they can end it by agreeing.
    const cs = await alternateToCeiling();

    clearStats();
    const other = `${new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10)}T14:00:00`;
    const fresh = await attempt({
      capabilityState: cs,
      turn: 7,
      said: "No, hang on",
      settled: true,
      when: other,
    });
    // Still refused, and refused for the RIGHT reason: a new proposal gets a
    // new budget rather than inheriting a spent one.
    expect(fresh.functionResponse.response.success).toBe(false);
    expect(counters().write_attempt_budget_released).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// A CHANGE TOOL WITH NOTHING TO CHANGE IS NOT A CONSENT PROBLEM.
//
// Call CA0c8ce7, 2026-09-10. At 20:18:58 the assistant said "Perfect, I have
// you down for 9 AM tomorrow" with nothing booked -- caught, correctly, as a
// claim with no action behind it. But the model now believed the appointment
// existed, so when the name came out wrong it reached for
// correct_appointment_name instead of book_appointment. TWICE, on a row that
// did not exist.
//
// The write-order gate refused both, and its refusal says "read the details
// back and ask whether to go ahead" -- advice for a write that could happen.
// The model dutifully re-asked, was refused again, and then told the caller
// "I'm not sure why it's not updating" and offered a callback. Two and a half
// minutes to reach a booking that then worked first time.
//
// The pack already has the right words for this ("no upcoming appointments on
// record ... there is nothing to change"). It just never got to say them,
// because a gate about CONSENT ran ahead of the tool that knows the operation
// is impossible. Order of refusals is the fix, not new refusal text.
// ---------------------------------------------------------------------------
describe("a change tool with no appointment to change", () => {
  const correct = (over = {}) =>
    executeToolCall(
      { id: "fc1", name: "correct_appointment_name", args: { client_name: "Venkat Ilovarpu" } },
      {
        businessId: "biz-1",
        callerPhone: "+15551234567",
        callId: "call-1",
        integrations: [],
        capabilityState: {},
        config: {},
        spellingSettled: true,
        callerTurnCount: 4,
        // The caller has nothing booked. This is the state the call was in.
        callerContext: { callCount: 1, upcomingAppointments: [] },
        lastCallerText: "No, that's still wrong",
        lastReplyText: "May I go ahead and confirm the appointment under that name?",
        ...over,
      }
    );

  it("says there is nothing to change, not 'shall I go ahead'", async () => {
    const { functionResponse } = await correct();
    const message = String(functionResponse.response.message || "");

    expect(functionResponse.response.success).toBe(false);
    // The useful reason.
    expect(message).toMatch(/nothing to change|no upcoming appointments/i);
    // NOT the consent refusal, which sends the model back to ask for a
    // go-ahead on an operation that cannot succeed however many times it asks.
    expect(message).not.toMatch(/shall i go ahead/i);
  });

  it("does not spend a write-order refusal on it", async () => {
    // The budget is for writes that could land. Spending it here is what let
    // three refusals stack up on one caller.
    clearStats();
    await correct();
    expect(counters().write_order_refused).toBeFalsy();
  });

  it("still gates a change tool that DOES have a target", async () => {
    // The guard must not become a way around the write-order gate. With a real
    // appointment to act on, consent is required exactly as before.
    clearStats();
    const { functionResponse } = await correct({
      callerContext: {
        callCount: 1,
        upcomingAppointments: [
          { id: "appt-1", client_name: "Venkat", scheduled_at: FUTURE_SLOT_ISO },
        ],
      },
    });
    expect(functionResponse.response.success).toBe(false);
    expect(counters().write_order_refused).toBe(1);
  });
});

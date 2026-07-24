/**
 * Text-session harness tests.
 *
 * runLlmTurn is mocked with scripted async generators (same approach as
 * tests/session.test.js) so these exercise the harness's own wiring — reducer
 * application, effect dispatch through the real packs, tool-trace surfacing, and
 * the extras it hands the brain — with no real Gemini call. The fake capability
 * deps are exercised directly against the contracts services/supabase.js defines.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/voice/llmTurn.js", () => ({ runLlmTurn: vi.fn() }));

import { runLlmTurn } from "../lib/voice/llmTurn.js";
import { createTextSession } from "../lib/harness/textSession.js";
import { makeFakeDeps, makeFakeEffectsDeps } from "../lib/harness/fakeDeps.js";

/** Scripted async generator emulating runLlmTurn's event stream. */
function scriptTurn(events) {
  return async function* () {
    for (const ev of events) yield ev;
  };
}

/** A `done` event carrying a reply with sane defaults. */
function doneEvent(reply) {
  return {
    type: "done",
    reply: { text: "", toolResults: [], toolCallEvents: [], capabilityEffects: [], capabilityState: {}, ...reply },
  };
}

const CONFIG = { businessName: "Acme Dental", timezone: "America/Chicago" };

beforeEach(() => {
  runLlmTurn.mockReset();
});

function newSession(overrides = {}) {
  const fakes = makeFakeDeps();
  const effects = makeFakeEffectsDeps();
  const session = createTextSession({
    config: CONFIG,
    extras: { businessId: "biz-1", ...(overrides.extras || {}) },
    fakes: { deps: fakes.deps, store: fakes.store, effects },
    ...overrides.session,
  });
  return { session, fakes, effects };
}

describe("createTextSession — sendTurn", () => {
  it("concatenates deltas and returns the collected text + reply", async () => {
    runLlmTurn.mockImplementation(
      scriptTurn([
        { type: "delta", text: "Hi " },
        { type: "delta", text: "there" },
        doneEvent({ text: "Hi there" }),
      ])
    );
    const { session } = newSession();
    const out = await session.sendTurn("hello");

    expect(out.text).toBe("Hi there");
    expect(out.reply.text).toBe("Hi there");
    expect(out.state).toEqual({ step: "identify_intent", intent: null });
  });

  it("applies the reducer: history grows with user + model turns", async () => {
    runLlmTurn.mockImplementation(scriptTurn([doneEvent({ text: "Sure." })]));
    const { session } = newSession();
    await session.sendTurn("book me in");

    const history = session.getState().history;
    expect(history).toEqual([
      { role: "user", parts: [{ text: "book me in" }] },
      { role: "model", parts: [{ text: "Sure." }] },
    ]);
  });

  it("transitions intent + step on intentArgs (identify_intent -> gather_details)", async () => {
    runLlmTurn.mockImplementation(
      scriptTurn([doneEvent({ text: "What day?", intentArgs: { intent: "book_appointment" } })])
    );
    const { session } = newSession();
    const out = await session.sendTurn("I want an appointment");

    expect(out.state).toEqual({ step: "gather_details", intent: "book_appointment" });
    expect(session.getState().step).toBe("gather_details");
  });

  it("pushes a system note + records notification when a capability effect fires", async () => {
    runLlmTurn.mockImplementation(
      scriptTurn([
        doneEvent({
          text: "You're booked.",
          capabilityEffects: [
            {
              capability: "appointments",
              type: "booked",
              data: { scheduled_at: "2026-08-01T10:00:00Z", client_name: "Jane" },
            },
          ],
        }),
      ])
    );
    const { session, effects } = newSession();
    const out = await session.sendTurn("book Jane for Aug 1 at 10");

    // Effect moved the step and left a system note the model will see next turn.
    expect(session.getState().step).toBe("confirm");
    const noteEntry = session.getState().history.find(
      (h) => h.role === "user" && h.parts[0].text.startsWith("[system note")
    );
    expect(noteEntry).toBeTruthy();
    expect(out.notes.some((n) => n.includes("book_appointment succeeded"))).toBe(true);

    // The booked effect notified the owner and texted the caller — recorded, not sent.
    const kinds = effects.captured.notifications.map((n) => n.name);
    expect(kinds).toContain("notifyAppointmentBooked");
    expect(kinds).toContain("sendCallerSms");
  });

  it("surfaces the ordered {name, args} tool trace and toolResults", async () => {
    runLlmTurn.mockImplementation(
      scriptTurn([
        doneEvent({
          text: "Done.",
          toolResults: [{ name: "book_appointment_db", success: true, message: "ok" }],
          toolCallEvents: [{ name: "book_appointment_db", args: { date: "2026-08-01", time: "10:00" } }],
        }),
      ])
    );
    const { session } = newSession();
    const out = await session.sendTurn("book it");

    expect(out.toolCalls).toEqual([
      { name: "book_appointment_db", args: { date: "2026-08-01", time: "10:00" } },
    ]);
    expect(out.toolResults).toEqual([{ name: "book_appointment_db", success: true, message: "ok" }]);
    expect(session.transcript.at(-1)).toMatchObject({ role: "model", toolCalls: out.toolCalls });
  });

  it("hands runLlmTurn the fake capability deps and modelOverrides via extras", async () => {
    runLlmTurn.mockImplementation(scriptTurn([doneEvent({ text: "ok" })]));
    const fakes = makeFakeDeps();
    const session = createTextSession({
      config: CONFIG,
      extras: { businessId: "biz-1", knowledge: [] },
      modelOverrides: { temperature: 0.1 },
      fakes: { deps: fakes.deps, store: fakes.store, effects: makeFakeEffectsDeps() },
    });
    await session.sendTurn("hi");

    const passedExtras = runLlmTurn.mock.calls[0][0].extras;
    expect(passedExtras.capabilityDeps).toBe(fakes.deps);
    expect(passedExtras.modelOverrides).toEqual({ temperature: 0.1 });
    // step/intent/history threaded from harness state
    expect(runLlmTurn.mock.calls[0][0].step).toBe("identify_intent");
  });

  it("counts slow events and reports timings without mutating state", async () => {
    runLlmTurn.mockImplementation(
      scriptTurn([{ type: "slow" }, { type: "delta", text: "hi" }, doneEvent({ text: "hi" })])
    );
    const { session } = newSession();
    const out = await session.sendTurn("hello");
    expect(out.timings.slowCount).toBe(1);
    expect(typeof out.timings.totalMs).toBe("number");
  });

  it("leaves state untouched when a turn yields no done reply", async () => {
    runLlmTurn.mockImplementation(scriptTurn([{ type: "delta", text: "partial" }]));
    const { session } = newSession();
    const out = await session.sendTurn("hello");
    expect(out.reply).toBeNull();
    expect(out.text).toBe("partial");
    // history did not grow with a model turn
    expect(session.getState().history).toEqual([]);
  });
});

describe("makeFakeDeps — capability data surface", () => {
  it("createAppointmentIfAvailable books when free and reports {full:true} on a seeded conflict", async () => {
    const { deps, store } = makeFakeDeps({
      slotCapacity: 1,
      seedAppointments: [
        { business_id: "biz-1", scheduled_at: "2026-08-01T10:00:00Z", client_name: "Existing", client_phone: "+15551112222" },
      ],
    });

    // Overlapping the seeded 10:00 slot (30-min length) => full.
    const conflict = await deps.createAppointmentIfAvailable({
      businessId: "biz-1",
      scheduledAt: "2026-08-01T10:15:00Z",
      lengthMinutes: 30,
      capacity: 1,
    });
    expect(conflict).toEqual({ full: true });

    // A non-overlapping slot books and returns an id.
    const ok = await deps.createAppointmentIfAvailable({
      businessId: "biz-1",
      scheduledAt: "2026-08-01T11:00:00Z",
      lengthMinutes: 30,
      capacity: 1,
    });
    expect(ok.id).toBeTruthy();
    expect(store.scheduled()).toHaveLength(2);

    // Different tenant never conflicts with biz-1's rows.
    const otherTenant = await deps.createAppointmentIfAvailable({
      businessId: "biz-2",
      scheduledAt: "2026-08-01T10:00:00Z",
      lengthMinutes: 30,
      capacity: 1,
    });
    expect(otherTenant.id).toBeTruthy();
  });

  it("listAppointmentsByCaller filters by tenant, phone (last 10) and name, scheduled only", async () => {
    const { deps } = makeFakeDeps({
      seedAppointments: [
        { id: "a1", business_id: "biz-1", scheduled_at: "2026-08-02T09:00:00Z", client_name: "Jane Doe", client_phone: "+1 (555) 111-2222" },
        { id: "a2", business_id: "biz-1", scheduled_at: "2026-08-01T09:00:00Z", client_name: "John Smith", client_phone: "5559998888" },
        { id: "a3", business_id: "biz-1", scheduled_at: "2026-08-03T09:00:00Z", client_name: "Jane Roe", client_phone: "5551112222", status: "cancelled" },
        { id: "a4", business_id: "biz-2", scheduled_at: "2026-08-01T09:00:00Z", client_name: "Jane Doe", client_phone: "5551112222" },
      ],
    });

    const byPhone = await deps.listAppointmentsByCaller("biz-1", { clientPhone: "555-111-2222" });
    expect(byPhone.map((r) => r.id)).toEqual(["a1"]); // a3 cancelled, a4 other tenant

    const byName = await deps.listAppointmentsByCaller("biz-1", { clientName: "jane" });
    expect(byName.map((r) => r.id)).toEqual(["a1"]); // sorted, a3 cancelled excluded

    const all = await deps.listAppointmentsByCaller("biz-1");
    expect(all.map((r) => r.id)).toEqual(["a2", "a1"]); // scheduled only, sorted by time
  });

  it("cancel/reschedule mutate rows and the store call log records every call", async () => {
    const { deps, store } = makeFakeDeps({
      seedAppointments: [{ id: "a1", business_id: "biz-1", scheduled_at: "2026-08-01T09:00:00Z" }],
    });

    expect(await deps.updateAppointmentStatus("a1", "cancelled", "biz-1")).toBe(true);
    expect(await deps.getAppointmentById("a1", "biz-1")).toMatchObject({ status: "cancelled" });
    // wrong tenant is refused
    expect(await deps.updateAppointmentStatus("a1", "cancelled", "biz-2")).toBe(false);

    const names = store.calls.map((c) => c.name);
    expect(names).toContain("updateAppointmentStatus");
    expect(names).toContain("getAppointmentById");
    expect(store.calls[0]).toMatchObject({ name: "updateAppointmentStatus", args: { appointmentId: "a1", businessId: "biz-1" } });
  });

  it("executeIntegration records the call and returns a canned success by default", async () => {
    const { deps, store } = makeFakeDeps();
    const res = await deps.executeIntegration({ provider: "webhook", name: "x" }, { tool: "t", arguments: {} });
    expect(res).toEqual({ success: true, message: "", data: {} });
    expect(store.calls.at(-1)).toMatchObject({ name: "executeIntegration" });
  });
});

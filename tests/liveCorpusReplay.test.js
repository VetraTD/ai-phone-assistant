// ---------------------------------------------------------------------------
// FOURTEEN REAL CALLS, REPLAYED THROUGH THE REAL GATE.
//
// Three fixes to the Live write-consent gate shipped on 2026-09-16, each on a
// single phone call, each with a consequence nobody predicted, and the full
// suite was green every time. It could not have been otherwise: not one test in
// this repository had ever seen a sentence a model actually said on a call.
//
// So the calls of 2026-09-16/17 are fixtures, built by
// scripts/corpus/build-fixtures.mjs from raw Cloud Logging pulls, and every
// write attempt in them is replayed against the real gate before anything
// deploys.
//
// WHAT AN ATTEMPT'S `expect` MEANS. It is what SHOULD happen, not what did.
// Of the twenty attempts recorded BEFORE the fixes, twelve were refused and
// seven of those refusals were wrong and cost a booking. The ten recorded AFTER
// them all did the right thing on the day, so they are regression fixtures
// rather than a to-do list. A green run means the gate does the right thing on
// all thirty, not that it reproduces the log.
//
// WHAT THIS CANNOT WITNESS, stated so a green run is not read as more than it
// is:
//   - the vendor race. The fixture supplies both the caller transcript and its
//     timing, so the real 702 ms input-transcription lag is whatever this file
//     says it is.
//   - the hammering loop. That is a property of MAX_TOOL_ROUNDS and the model's
//     turnComplete cadence, and this file calls tools directly rather than
//     letting a model decide to.
//   - anything about audio, barge-in or latency.
// ---------------------------------------------------------------------------

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { bootLive, counters } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";

const FIXTURE_DIR = path.join("tests", "fixtures", "liveCalls");
const FIXTURES = fs
  .readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), "utf8")));

// The corpus tenant, shaped like the real one. NOT the byte-locked
// promptSnapshot fixture: that closes Friday at 16:00 and three of the corpus
// times are 16:30, so every one of them would be refused by
// validateBookingTime for a reason that has nothing to do with consent.
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
  capabilities: {
    appointments: {
      enabled: true,
      adapter: "internal",
      availability: { length: 30, capacity: 1 },
    },
  },
};

// The calls happened on 2026-09-16/17 and every appointment in them is on
// Friday 2026-09-18, so the clock sits just before the calls themselves.
const FROZEN_NOW = new Date("2026-09-16T12:00:00Z");

const SEED_ID = "appt-seed-1";
const CLIENT = "Marcus Bell";
// Used when an attempt's target could not be derived -- a write aimed at a time
// no read-back ever named. Every such attempt expects a refusal, so the value
// only has to be legal.
const FALLBACK_SLOT = "2026-09-18T14:00:00";

beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(FROZEN_NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

let priorSpellPolicy;
beforeEach(() => {
  clearStats();
  // THE SPELLING GATE IS OFF, and the reason is worth stating rather than
  // inheriting. It is a separate gate with its own tests (LVX72, LVX123) and it
  // holds a first booking whose name has not been spelled. Leaving it armed
  // would make half of these attempts pass or fail for a reason that has
  // nothing to do with consent -- and on CA239046 it is exactly what held the
  // first write while both halves of consent were present. That attempt's
  // fixture entry says so.
  priorSpellPolicy = process.env.VOICE_SPELL_POLICY;
  process.env.VOICE_SPELL_POLICY = "off";
});
afterEach(() => {
  if (priorSpellPolicy === undefined) delete process.env.VOICE_SPELL_POLICY;
  else process.env.VOICE_SPELL_POLICY = priorSpellPolicy;
});

function argsFor(attempt) {
  const slot = attempt.target || FALLBACK_SLOT;
  switch (attempt.tool) {
    case "book_appointment":
      return { client_name: CLIENT, scheduled_at: slot, notes: "strategy call" };
    case "cancel_appointment_db":
      return { appointment_id: SEED_ID };
    case "reschedule_appointment_db":
      return { appointment_id: SEED_ID, new_scheduled_at: slot };
    default:
      return {};
  }
}

/**
 * Replay one call and return what the gate did with every write attempt.
 *
 * The turn loop mirrors production's ordering exactly, and that ordering is the
 * whole reason this has to run through a real session rather than a hand-built
 * ctx: `lastAgreement` is recorded in applyTurn, at turnComplete, from the
 * caller text of the turn that is ENDING and the assistant text of the turn
 * BEFORE it. Nothing but the real reducer gets that right.
 */
async function replay(fixture) {
  const cancels = fixture.attempts.filter((a) => a.tool === "cancel_appointment_db");
  const seedAt = cancels.find((a) => a.target)?.target || "2026-09-18T16:30:00";

  const s = await bootLive({
    config: CONFIG,
    callSid: fixture.callSid,
    seedAppointments: [
      {
        id: SEED_ID,
        business_id: "biz-1",
        client_name: CLIENT,
        client_phone: "+15551234567",
        scheduled_at: seedAt,
        status: "scheduled",
      },
    ],
  });

  // Every distinct time any turn offered, so the guards' verified-slot set is
  // populated the way it was on the call. Without this a booking is
  // slot_unverified and the availability guard, not the consent gate, decides.
  const offered = [
    ...new Set(fixture.attempts.flatMap((a) => a.target_candidates || []).concat(fixture.attempts.map((a) => a.target).filter(Boolean))),
  ];
  for (const at of offered) await s.callTool("check_appointment_availability", { requested_at: at });

  const results = [];
  for (const turn of fixture.turns) {
    if (turn.caller) await s.callerSays(turn.caller);
    await s.assistantTurn(turn.assistant);

    const window = fixture.attempts.filter((a) => a.standing_turn === turn.i);
    if (!window.length) continue;

    // EACH DISTINCT CALLER TURN ONCE, not once per attempt and not once per
    // window.
    //
    // Once per attempt is wrong because turnUserText ACCUMULATES: saying "Yes."
    // five times builds "Yes. Yes. Yes. Yes. Yes.", which is not a thing any
    // caller said.
    //
    // Once per window was the fix for that and it is wrong too, for a case the
    // corpus did not contain until CAd97855. Attempts 5 and 6 there share turn
    // 19 and do NOT share a caller turn: the first is a retry fired into
    // silence, and the second follows "Yeah, that works. Yes." -- the answer
    // that finally authorised the booking. Under the window rule only the first
    // attempt's text is ever spoken, so the second is refused for want of an
    // agreement the caller actually gave, and the fixture goes red describing a
    // gate defect that is not there.
    //
    // Saying each DISTINCT text once has both properties, and it is a no-op for
    // every window whose attempts share one caller turn -- which is all fifteen
    // of the fixtures written before this one.
    let lastSaid = null;
    for (const attempt of window) {
      if (attempt.caller_text && attempt.caller_text !== lastSaid) {
        await s.callerSays(attempt.caller_text);
        lastSaid = attempt.caller_text;
      }
      const [response] = await s.callTool(attempt.tool, argsFor(attempt));
      results.push({ attempt, response });
    }
  }
  return { s, results };
}

describe("the real calls, replayed through the real gate", () => {
  // A CANARY, not a formality. These numbers only move when someone adds a
  // call to the corpus and regenerates, and a silent drop -- a fixture that
  // stopped being written because its expectations went missing -- would
  // otherwise shrink the suite without failing it.
  it("has a fixture for every call in the corpus", () => {
    expect(FIXTURES).toHaveLength(31);
    expect(FIXTURES.flatMap((f) => f.attempts)).toHaveLength(90);
  });

  for (const fixture of FIXTURES) {
    describe(`${fixture.callSid} — ${fixture.note.slice(0, 70)}`, () => {
      if (!fixture.attempts.length) {
        it("attempted no writes, and must still attempt none", async () => {
          const { results } = await replay(fixture);
          expect(results).toHaveLength(0);
        });
        return;
      }

      it("reaches every write attempt it recorded", async () => {
        const { results } = await replay(fixture);
        expect(results).toHaveLength(fixture.attempts.length);
        // A response of undefined means the tool never ran -- a broken replay
        // reporting as a refusal, which is the failure mode that would make
        // this whole file lie in the safe-looking direction.
        for (const { attempt, response } of results) {
          expect(response, `${attempt.at} ${attempt.tool} produced no functionResponse`).toBeTruthy();
        }
      });

      for (const [i, attempt] of fixture.attempts.entries()) {
        const verb = attempt.expect === "write" ? "writes" : "refuses";
        it(`attempt ${i} (${attempt.tool}) ${verb} — ${attempt.why.slice(0, 90)}`, async () => {
          const { results } = await replay(fixture);
          const got = results[i];
          expect(got?.response, "the tool never ran").toBeTruthy();
          expect(
            got.response.response?.success === true,
            `expected ${attempt.expect}, got success=${got.response.response?.success} ` +
              `message=${JSON.stringify(got.response.response?.message)?.slice(0, 160)}`
          ).toBe(attempt.expect === "write");
        });
      }

      it("leaves the diary with exactly the rows it should", async () => {
        const { s } = await replay(fixture);
        const wantsBooking = fixture.attempts.some(
          (a) => a.tool === "book_appointment" && a.expect === "write"
        );
        const wantsCancel = fixture.attempts.some(
          (a) => a.tool === "cancel_appointment_db" && a.expect === "write"
        );
        const rows = s.store.scheduled();
        const booked = rows.filter((r) => r.id !== SEED_ID);

        // ONE row, however many attempts were made. Five identical writes must
        // be four duplicate suppressions and one booking, which is the only
        // thing standing between the hammering loop and five appointments.
        expect(booked).toHaveLength(wantsBooking ? 1 : 0);
        expect(rows.some((r) => r.id === SEED_ID)).toBe(!wantsCancel);
      });
    });
  }
});

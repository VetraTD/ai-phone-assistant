/**
 * "One moment." — when the engine may say it, and when saying it is noise.
 *
 * Reported from a live call: the assistant said "one moment" before a lot of
 * responses that came back inside two seconds. Two separate causes, and the
 * threshold was the smaller one.
 *
 * The larger one: the `slow` branch checked ONLY whether text had been produced,
 * while the `toolCall` branch beside it checked three things — that no hold line
 * had already played, and that the MODEL had not already said its own "one
 * moment". The booking prompt explicitly instructs the model to say exactly
 * that before an availability check ("say something like 'one moment while I
 * check that' and call check_appointment_availability"), so on every booking the
 * model said it and the engine then said it again.
 *
 * These two paths now share one predicate, so they cannot drift apart again.
 */

import { describe, it, expect } from "vitest";
import { shouldPlayHoldLine } from "../lib/voice/session.js";
import { getStrings } from "../lib/voice/strings.js";

const promiseRe = getStrings({}).promiseRe;

describe("shouldPlayHoldLine", () => {
  it("plays when the turn has produced nothing at all", () => {
    expect(
      shouldPlayHoldLine({ audioPlaying: false, holdLinePlayed: false, spokenThisTurn: "", promiseRe }),
    ).toBe(true);
  });

  it("stays quiet while the caller is actually HEARING something", () => {
    expect(
      shouldPlayHoldLine({ audioPlaying: true, holdLinePlayed: false, spokenThisTurn: "", promiseRe }),
    ).toBe(false);
  });

  it("speaks once the model's own words have FINISHED and it is still working", () => {
    // The case this whole predicate exists for, and the one it used to refuse.
    // It opened with `if (producedText) return false` — any text at all this
    // turn and the line was dead. Under VOICE_INTENT_MARKER the model writes a
    // sentence alongside its tool call on nearly every turn, so it never fired,
    // including on a reschedule that says "just to confirm..." and then grinds
    // for three seconds. Reported from a live call: "it is not running for
    // important tool calls either".
    expect(
      shouldPlayHoldLine({
        audioPlaying: false,
        holdLinePlayed: false,
        spokenThisTurn: "Thank you. Just to confirm, you want to move it to Friday?",
        promiseRe,
      }),
    ).toBe(true);
  });

  it("still defers to the model's OWN promise, which is the precise version of that check", () => {
    // Unreachable behind the producedText veto for as long as it existed.
    expect(
      shouldPlayHoldLine({
        audioPlaying: false,
        holdLinePlayed: false,
        spokenThisTurn: "One moment while I check that for you.",
        promiseRe,
      }),
    ).toBe(false);
  });

  it("stays quiet if a hold line already played this turn", () => {
    // The failure this fixes: the tool path plays a hold line and sets the
    // flag, then `slow` fires and plays a SECOND one, because the slow branch
    // never looked at the flag.
    expect(
      shouldPlayHoldLine({ audioPlaying: false, holdLinePlayed: true, spokenThisTurn: "", promiseRe }),
    ).toBe(false);
  });

  it("stays quiet when the model already promised in its own words", () => {
    // Straight from capabilities/appointments.js step 3 — the assistant is
    // TOLD to say this, so the engine repeating it is guaranteed, not rare.
    expect(
      shouldPlayHoldLine({
        audioPlaying: false,
        holdLinePlayed: false,
        spokenThisTurn: "One moment while I check that.",
        promiseRe,
      }),
    ).toBe(false);
  });

  it("recognises the other promise phrasings the model uses", () => {
    for (const said of ["Let me check that for you.", "I'll look that up.", "Give me one second."]) {
      expect(
        shouldPlayHoldLine({ audioPlaying: false, holdLinePlayed: false, spokenThisTurn: said, promiseRe }),
      ).toBe(false);
    }
  });

  it("still plays when the model said something that is not a promise", () => {
    expect(
      shouldPlayHoldLine({
        audioPlaying: false,
        holdLinePlayed: false,
        spokenThisTurn: "Of course.",
        promiseRe,
      }),
    ).toBe(true);
  });

  it("plays when no promise pattern is available at all", () => {
    // A locale with no promiseRe must not silently suppress every hold line.
    expect(
      shouldPlayHoldLine({
        audioPlaying: false,
        holdLinePlayed: false,
        spokenThisTurn: "anything",
        promiseRe: undefined,
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hold-line variety, 2026-08-30.
//
// A booking hits a tool round on most turns. The same sentence three times
// running is how a caller notices they are talking to a machine, so each kind
// carries several and they cycle within a call.
// ---------------------------------------------------------------------------
describe("holdLineFor — cycling the variants", () => {
  it("gives a different line on consecutive tool rounds", async () => {
    const { getStrings, holdLineFor } = await import("../lib/voice/strings.js");
    const S = getStrings("en");
    const heard = [0, 1, 2].map((n) => holdLineFor(S, "holdAvailability", n));
    expect(new Set(heard).size).toBe(3);
    expect(heard.every((t) => typeof t === "string" && t.length > 0)).toBe(true);
  });

  it("wraps rather than running out on a long call", async () => {
    const { getStrings, holdLineFor } = await import("../lib/voice/strings.js");
    const S = getStrings("en");
    expect(holdLineFor(S, "holdAvailability", 3)).toBe(holdLineFor(S, "holdAvailability", 0));
    expect(holdLineFor(S, "holdBook", 99)).toBeTruthy();
  });

  it("still handles the single-string kinds", async () => {
    // filler and stillWorking were never lists and must keep working.
    const { getStrings, holdLineFor } = await import("../lib/voice/strings.js");
    const S = getStrings("en");
    expect(holdLineFor(S, "filler", 7)).toBe("One moment.");
    expect(holdLineFor(S, "stillWorking", 2)).toBeTruthy();
  });

  it("localizes — a Spanish call cycles Spanish lines", async () => {
    const { getStrings, holdLineFor } = await import("../lib/voice/strings.js");
    const S = getStrings("es");
    const heard = [0, 1, 2].map((n) => holdLineFor(S, "holdLookup", n));
    expect(new Set(heard).size).toBe(3);
    expect(heard.join(" ")).not.toMatch(/let me|looking/i);
  });

  it("returns empty for a kind that does not exist, rather than throwing", async () => {
    const { getStrings, holdLineFor } = await import("../lib/voice/strings.js");
    expect(holdLineFor(getStrings("en"), "nonsense", 0)).toBe("");
    expect(holdLineFor(null, "filler", 0)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Per-action lines, 2026-08-30.
//
// Three coarse buckets was not enough: "holdWrite" covered booking, cancelling,
// rescheduling, taking a message AND recording a quote, so cancelling an
// appointment was announced as "just getting that sorted for you". A caller
// heard the mismatch and said so.
// ---------------------------------------------------------------------------
describe("holdKindForTool — the line matches the action", () => {
  it("does not describe a cancellation as a booking, or either as a lookup", async () => {
    const { holdKindForTool } = await import("../lib/voice/strings.js");
    const kinds = ["book_appointment", "cancel_appointment_db", "reschedule_appointment_db"].map(
      holdKindForTool
    );
    expect(new Set(kinds).size).toBe(3);
  });

  it("maps every real tool name to a kind that has a line, in both locales", async () => {
    const { holdKindForTool, holdLineFor, getStrings } = await import("../lib/voice/strings.js");
    const TOOLS = [
      "check_appointment_availability", "get_available_slots",
      "get_caller_appointments", "get_caller_appointments_from_db",
      "book_appointment", "book_appointment_in_ehr",
      "cancel_appointment", "cancel_appointment_db",
      "reschedule_appointment", "reschedule_appointment_db",
      "record_customer_request", "record_quote_request",
    ];
    for (const locale of ["en", "es"]) {
      const S = getStrings(locale);
      for (const t of TOOLS) {
        const line = holdLineFor(S, holdKindForTool(t), 0);
        expect(line, `${locale}/${t} has no line`).toBeTruthy();
      }
    }
  });

  it("falls back to the generic filler for a business's own webhook tool", async () => {
    // Guessing what someone else's integration does would be worse than
    // saying nothing specific.
    const { holdKindForTool } = await import("../lib/voice/strings.js");
    expect(holdKindForTool("sync_to_partner_crm")).toBe("filler");
    expect(holdKindForTool("")).toBe("filler");
    expect(holdKindForTool(undefined)).toBe("filler");
  });

  it("warms exactly the kinds the tool map can produce", async () => {
    // HOLD_KINDS is derived from the map, so a capability added later cannot
    // ship a line that was never pre-rendered.
    const { HOLD_KINDS, holdKindForTool } = await import("../lib/voice/strings.js");
    for (const t of ["book_appointment", "cancel_appointment_db", "record_quote_request"]) {
      expect(HOLD_KINDS).toContain(holdKindForTool(t));
    }
  });
});

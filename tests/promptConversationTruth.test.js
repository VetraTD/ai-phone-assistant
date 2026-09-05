// ---------------------------------------------------------------------------
// The prompt lines that close the conversation-side defects of 2026-09-03.
//
// Every one of these is also covered by tests/__snapshots__/prompts/, and that
// is not enough on its own: a snapshot proves the prompt CHANGED, and `-u`
// makes any change look intentional. These assertions name the sentence and the
// defect it closes, so deleting one fails a test that says why it existed.
//
// Six calls on a local rig wrote zero bad rows and said seven false things.
// Each block below is one of them.
// ---------------------------------------------------------------------------
import { describe, it, expect, afterEach, vi } from "vitest";
import { buildStaticSystemPrefix, buildDynamicTail } from "../services/gemini.js";

const BRIGHTWORK_HOURS = {
  mon: { open: "08:00", close: "17:00", closed: false },
  tue: { open: "08:00", close: "17:00", closed: false },
  wed: { open: "08:00", close: "17:00", closed: false },
  thu: { open: "08:00", close: "17:00", closed: false },
  fri: { open: "08:00", close: "16:00", closed: false },
  sat: { open: "09:00", close: "13:00", closed: false },
  sun: { open: null, close: null, closed: true },
};

const brightwork = (over = {}) => ({
  businessName: "Brightwork Family Dental",
  timezone: "America/Chicago",
  businessHours: BRIGHTWORK_HOURS,
  allowedTasks: ["book_appointment", "check_appointment", "cancel_reschedule"],
  generalInfo:
    "Brightwork Family Dental is a general and family dental practice. We handle check-ups, cleanings, fillings, crowns and emergency toothache appointments.",
  customInstructions: null,
  languagesSpoken: ["en"],
  afterHoursPolicy: "take_message",
  capabilities: { appointments: { enabled: true, adapter: "internal" } },
  ...over,
});

describe('the "anything else" tic — we stop ORDERING it', () => {
  // THE FINDING THAT REORDERED THIS WORK, 2026-09-05.
  //
  // The tic closed 3-4 of every 10 turns across nine calls and read as the
  // loudest remaining "this is not a person" signal. It was treated as model
  // drift for weeks, on the reasoning that seven prompt instructions already say
  // "one question at a time" and an eighth would weaken the other seven.
  //
  // That reasoning was right about STACKED QUESTIONS and wrong about this. The
  // tic is not a rule the model ignores; it is a rule the model FOLLOWS. The
  // tool contract carried, on every call: 'you MUST first ask the caller
  // something like "Is there anything else I can help you with?"'. A mandate,
  // with the sentence written out for it.
  //
  // So there was never an eighth instruction to add. There was a mandate to
  // delete -- which is the shape LVX34 and LVX71 both used successfully, and the
  // opposite of the phrasing treadmill.
  //
  // Verified against the real UK demo tenant before the change: exactly one of
  // our instructions produced this, and the other two matches in that prompt
  // were the tenant's own text -- one an ordinary idiom ("before you ask
  // anything else"), one a correct once-at-the-end instruction. Neither is ours
  // to edit.

  it("no longer hands the model the sentence to say", () => {
    const prefix = buildStaticSystemPrefix(brightwork(), {});
    // The script itself. This is what the model was reading out, near enough
    // verbatim, three or four times a call.
    expect(prefix).not.toContain("Is there anything else I can help you with?");
    expect(prefix).not.toMatch(/MUST first ask/i);
  });

  it("still forbids ending the call before the caller is finished", () => {
    // LOAD-BEARING HALF ONE, and the reason this is a rewrite rather than a
    // deletion. Removing the mandate outright would leave nothing standing
    // between the model and LVX35 -- closing the call the moment anything
    // succeeds. The requirement survives; only the script for satisfying it is
    // gone.
    const prefix = buildStaticSystemPrefix(brightwork(), {});
    expect(prefix).toMatch(/do not call end_call until/i);
  });

  it("still says the goodbye must share the turn with end_call", () => {
    // LOAD-BEARING HALF TWO, and it is a mechanical fact rather than a
    // preference: the call ends the instant the tool runs, so a goodbye planned
    // for afterwards is never heard by anyone.
    const prefix = buildStaticSystemPrefix(brightwork(), {});
    expect(prefix).toContain("IN THE SAME RESPONSE as end_call");
    expect(prefix).toMatch(/never heard/i);
  });

  it("names the case that actually produced the tic", () => {
    // Turn 4 of call 6: the caller said "Okay" and the whole turn was "Is there
    // anything else I can help you with?" -- asked after a plain factual answer,
    // with nothing to close. The replacement says when NOT to ask, because
    // "ask once at the end" without that is what the model was already doing.
    const prefix = buildStaticSystemPrefix(brightwork(), {});
    expect(prefix).toMatch(/ordinary answer|every turn|filling a turn/i);
  });
});

describe("LVX55 — the whole week is in the prompt, not just today", () => {
  it("states Friday's earlier close and Saturday's hours in the STATIC prefix", () => {
    const prefix = buildStaticSystemPrefix(brightwork(), {});
    // The tenant was told 5 PM on a Friday that shuts at 4, and told the
    // practice was shut on a Saturday it trades.
    expect(prefix).toContain("Friday: 8:00 AM – 4:00 PM");
    expect(prefix).toContain("Saturday: 9:00 AM – 1:00 PM");
  });

  it("keeps the week OUT of the per-turn tail", () => {
    // Static, not tail: the week is business-stable, so it stays cacheable and
    // — on the Live path, where the prompt is frozen at connect — cannot go
    // stale mid-call. The tail still carries today's window and Status:.
    const tail = buildDynamicTail("identify_intent", null, brightwork(), {});
    expect(tail).not.toContain("Saturday: 9:00 AM – 1:00 PM");
  });

  it("says nothing about a week for an always-open tenant", () => {
    // Digile Media is configured 00:00-23:59 every day and legitimately offers
    // midnight appointments. A null schedule must not become an invented one.
    const prefix = buildStaticSystemPrefix(brightwork({ businessHours: null }), {});
    expect(prefix).not.toContain("Opening hours:");
  });
});

describe("LVX66 / LVX59 — facts about the business have named sources", () => {
  const prefix = () => buildStaticSystemPrefix(brightwork(), {});

  it("names where a fact may come from", () => {
    // "Never invent facts" was already here and was not enough: it never said
    // WHERE a fact may come from.
    expect(prefix()).toContain(
      "must come from BUSINESS INFO, KNOWLEDGE BASE, CUSTOM BUSINESS RULES, or a tool's response on this call"
    );
  });

  it("forbids the words that make an invention sound checked", () => {
    // The exact sentence: "I've confirmed we accept Blue Cross Blue Shield."
    expect(prefix()).toContain(
      "Never say you have confirmed, checked, verified, or looked something up unless a tool actually returned it on this call"
    );
  });

  it("names insurers and payment methods specifically", () => {
    expect(prefix()).toContain("which insurers or payment methods it takes");
  });

  it("limits what may be said about a stored appointment", () => {
    // The row's notes read "dental appointment"; it said "I see that
    // appointment is for a checkup and cleaning."
    expect(prefix()).toContain("use only what the record holds");
  });

  it("carries the sourcing rule even when the knowledge table is EMPTY", () => {
    // This is the whole point. The only anti-fabrication sentence in the prompt
    // used to live inside === KNOWLEDGE BASE ===, which renders only when the
    // table has rows — so for a tenant with none, like Brightwork, the model was
    // never told not to invent. The insurance answer happened in a prompt that
    // did not contain the instruction.
    const withNoKnowledge = buildStaticSystemPrefix(brightwork(), { knowledge: [] });
    expect(withNoKnowledge).not.toContain("=== KNOWLEDGE BASE ===");
    expect(withNoKnowledge).toContain("If it is not there, you do not know it");
  });
});

describe("LVX63 — an off-domain request is declined, not reinterpreted", () => {
  it("distinguishes 'cannot do that here' from 'not what this line is for'", () => {
    // "Yeah, can I book an Uber?" -> "I understand you want to book an
    // appointment." It declines a treatment the practice does not offer
    // perfectly well; it had nothing for a request from another domain.
    expect(buildStaticSystemPrefix(brightwork(), {})).toContain(
      "not this business's line of work at all"
    );
  });
});

describe("LVX54 / LVX64 — the system is not a character", () => {
  const prefix = () => buildStaticSystemPrefix(brightwork(), {});

  it("gives a form of address for a caller with no name yet", () => {
    // Verbatim, turn 7: "user? Did you still want to book that appointment..."
    expect(prefix()).toContain("do not address them by any stand-in");
  });

  it("forbids describing internals as actors with needs", () => {
    // Verbatim: "the calendar needs to know what service you're looking for".
    expect(prefix()).toContain("Never describe the systems behind you as people");
  });

  it("does NOT try to catch these with the outbound leak word list", () => {
    // sanitizeOutbound and internal_term_leaks key on implementation VOCABULARY.
    // "calendar" is what a receptionist says — "let me check the calendar" — and
    // a leak guard with a hair trigger is LVX21, which delivered half a second
    // of audio in twenty-five. The fix is upstream, in the prompt, on purpose.
    expect(prefix()).toContain("what are you coming in for?");
  });
});

describe("LVX60 — the office being closed is said when it is relevant", () => {
  afterEach(() => vi.useRealTimers());

  it("no longer orders the announcement unconditionally", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T02:00:00Z")); // Thu 21:00 Chicago, shut
    const tail = buildDynamicTail("identify_intent", null, brightwork(), {});
    expect(tail).toContain("=== AFTER-HOURS BEHAVIOR ===");
    // Every branch used to open with this, which is why the unprompted "I also
    // want to let you know that our office is currently closed" was the prompt
    // working as written rather than a lapse.
    expect(tail).not.toContain("Inform the caller the office is closed.");
    expect(tail).toContain("Never volunteer it as an aside while answering something else");
  });
});

describe("LVX62 — 'the letters win' keeps the rule and drops the false reason", () => {
  const prefix = () => buildStaticSystemPrefix(brightwork(), {});

  it("no longer claims letters cannot be misheard", () => {
    // The old justification -- "speech recognition ... does not mishear letters
    // the same way" -- is an assumption about a separate ASR stage. Here the
    // model IS the transcriber, and spelled letters were misheard twice in one
    // evening: D as V, and T as G.
    expect(prefix()).not.toContain("does not mishear letters");
  });

  it("still prefers the letters in the ordinary case", () => {
    // The original reasoning holds where letters and sound agree: a spoken
    // read-back cannot catch a letter error, because the candidates sound
    // alike. Reversing the rule would give that back.
    expect(prefix()).toContain("the letters normally win");
    expect(prefix()).toContain("rebuild the name from the letters");
  });

  it("gives a path for letters that are themselves suspect", () => {
    // Neither "overwrite silently" nor "ignore the spelling". On the call that
    // found this, following the old rule would have written "Nighin Dodla"; the
    // model disobeyed and was right, and that disobedience was load-bearing.
    expect(prefix()).toContain("say the letters back one at a time");
  });

  it("does not send the caller round the loop again", () => {
    // Being asked to spell it twice is the repetition the whole spelling
    // apparatus keeps having to be pulled back from.
    expect(prefix()).toContain("Never ask them to spell it a second time");
  });
});

describe("LVX61 — the server computes the relative day", () => {
  afterEach(() => vi.useRealTimers());

  const callerContext = {
    callCount: 2,
    lastCallSummary: null,
    upcomingAppointments: [
      { id: "a1", client_name: "Nithin Dodla", scheduled_at: "2026-09-04T20:00:00Z", notes: null },
    ],
  };

  it("writes 'tomorrow' beside an appointment the model called 'today'", () => {
    vi.useFakeTimers();
    // The instant of the defect: Thursday 3 September 2026, 21:37 Chicago.
    vi.setSystemTime(new Date("2026-09-04T02:37:00Z"));
    const tail = buildDynamicTail("identify_intent", null, brightwork(), { callerContext });
    expect(tail).toContain("— tomorrow");
    expect(tail).not.toContain("— today");
  });

  it("writes 'today' when it really is today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T14:00:00Z")); // Fri 09:00 Chicago
    const tail = buildDynamicTail("identify_intent", null, brightwork(), { callerContext });
    expect(tail).toContain("— today");
  });

  it("gives no relative word further out, and says what to do instead", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T14:00:00Z")); // Tue, three days before
    const tail = buildDynamicTail("identify_intent", null, brightwork(), { callerContext });
    expect(tail).not.toContain("— today");
    expect(tail).not.toContain("— tomorrow");
    expect(tail).toContain("name the weekday and the date");
  });
});

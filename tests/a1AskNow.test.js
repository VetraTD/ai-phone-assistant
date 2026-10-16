// ---------------------------------------------------------------------------
// Round A1 part 4, F-A (owner, 2026-10-15): ASK NOW, NOT LATER.
//
// Part 3's calls b and d1: the spelling question and the "in addition?"
// question were both spoken AFTER the model's own "...booking that now". On
// Live the system instruction is built ONCE, at the greeting, so the step-
// scoped SPELLING NOT YET CONFIRMED block (gather_details only) never reached
// the model, and the static guardrail said "do not ask them to spell anything
// unless you are told to". The default in-addition rule told it to book a
// second appointment only "after you have told them about the existing one",
// so a caller who said "another appointment" (d1) was still asked.
//
// Owner rules: when the caller says something that needs checking, check it
// in the very next reply. A new name not spelled yet: ask then, before times
// and before any read-back. In addition: ask only when unclear (the words
// "another / also / as well / a second", or a booking for someone else, make
// it clear), and then ask straight away. Never "booking that now" while either
// is open. G2: name one or two bookings; three or more as a count + the next.
// ---------------------------------------------------------------------------
import { describe, it, expect, afterEach } from "vitest";
import { buildStaticSystemPrefix, buildDynamicTail, buildAllDeclarations } from "../services/gemini.js";
import { FIXTURES } from "./fixtures/businessConfigs.js";

const avail = FIXTURES["appointments-availability"];
const db = FIXTURES["appointments-db"];
const prefix = (f) => buildStaticSystemPrefix(f.config, f.extras);
const bookDecl = (f) => buildAllDeclarations(f.config, f.extras).find((d) => d.name === "book_appointment");
const DAY = 86_400_000;
const appt = (days, client_name = "Nithin Dodla") => ({
  id: `a${days}`,
  client_name,
  scheduled_at: new Date(Date.now() + days * DAY).toISOString(),
});
// The step Live builds its one system instruction at.
const liveTail = (f, upcomingAppointments, extra = {}) =>
  buildDynamicTail("greeting", null, f.config, {
    ...f.extras,
    callerContext: { callCount: 1, upcomingAppointments, ...extra },
  });

describe("part 4 F-A — the ask-now rule reaches the static prefix (what Live is built from)", () => {
  const saved = process.env.VOICE_SPELL_POLICY;
  afterEach(() => {
    if (saved === undefined) delete process.env.VOICE_SPELL_POLICY;
    else process.env.VOICE_SPELL_POLICY = saved;
  });

  it("states the general rule: check what needs checking in the very next reply", () => {
    expect(prefix(avail)).toMatch(/When the caller says something you need to check, check it in your very next reply/);
  });

  it("asks a new name's spelling straight away, before times and before any read-back", () => {
    expect(prefix(avail)).toMatch(
      /ask them to spell it in your very next reply — before you look up times and before any read-back/
    );
  });

  it("does not tell the model to ask for spellings when the spelling policy is off", () => {
    process.env.VOICE_SPELL_POLICY = "off";
    expect(prefix({ ...avail, config: { ...avail.config } })).not.toMatch(/ask them to spell it in your very next reply/);
  });

  it("never 'booking that now' while a question is still open", () => {
    expect(prefix(avail)).toMatch(/Never say "booking that now" while a question like that is still open/);
    expect(bookDecl(avail).description).toMatch(/never say "booking that now" while/i);
  });
});

describe("part 4 F-A — read-back examples carry a meridiem (the bare 'at 3' form the gate cannot read)", () => {
  it("the rule, the declaration and the flow steps say 'at 3 p.m.', never a bare hour", () => {
    const texts = [
      prefix(avail),
      bookDecl(avail).description,
      buildDynamicTail("gather_details", "book_appointment", avail.config, avail.extras),
      buildDynamicTail("gather_details", "book_appointment", db.config, db.extras),
    ];
    for (const t of texts) {
      expect(t).not.toMatch(/(?:Tuesday at 3|Thursday at 2) for /);
    }
    expect(texts[0]).toMatch(/Tuesday at 3 p\.m\. for Jon Doe, booking that now/);
  });
});

describe("part 4 F-A — in addition: ask only when unclear, and straight away (default policy)", () => {
  it("no ask when their words make it clear, or the booking is for someone else", () => {
    const t = liveTail(avail, [appt(4)]);
    expect(t).toMatch(/"another", "also", "as well", "a second one"/);
    expect(t).toMatch(/for someone else/);
    expect(t).toMatch(/do not ask — book it with in_addition_to_existing set to true/);
    // The old "only after you have told them about the existing one" is what
    // made d1 ask a caller who had said "another appointment".
    expect(t).not.toMatch(/after you have told them about the existing one/);
  });

  it("otherwise asks extra-or-move in the very next reply, before looking at times", () => {
    expect(liveTail(avail, [appt(4)])).toMatch(
      /ask in your very next reply, before you look at times, whether it is an extra one or a move/
    );
  });
});

describe("part 4 F-A — G2: how existing bookings are named", () => {
  it("one or two: named by day and time", () => {
    const t = liveTail(avail, [appt(4), appt(5)]);
    expect(t).toMatch(/name each one by its day and time/);
    expect(t).not.toMatch(/upcoming appointments; the next is/);
  });

  it("three or more: a count and the next one, in the sentence to say", () => {
    const t = liveTail(avail, [appt(6), appt(4), appt(5)]);
    expect(t).toMatch(/"You have 3 upcoming appointments; the next is [^"]+\."/);
  });

  it("no bookings: nothing about naming them", () => {
    const t = liveTail(avail, []);
    expect(t).not.toMatch(/upcoming appointments; the next is/);
    expect(t).not.toMatch(/name each one by its day and time/);
  });
});

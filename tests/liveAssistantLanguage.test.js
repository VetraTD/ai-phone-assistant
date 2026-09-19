// ---------------------------------------------------------------------------
// THE ASSISTANT ANSWERED AN ENGLISH CALLER IN SPANISH. THREE TIMES.
//
// CAd48d7b (2026-09-17, Spanish), CAfcd28789 (the same evening, reported as
// French), CAdc602f (Spanish again, 40 seconds, caller hung up). Every one was
// reported by a human, because nothing in this system watched what the
// assistant SAID.
//
// CAdc602f verbatim, on a session opened with language_code en-US,
// language_source tenant, output_language_pinned TRUE:
//
//   23:14:00  A: "Thanks for calling Digile Media..."
//   23:14:18  A: "I'm Digile Media's AI assistant. I can answer questions..."
//   23:14:31  A: "Sí, es completamente normal. ¿En qué puedo ayudarte hoy?"
//
// The pin governs the VOICE, not the words. lib/voice/live/client.js says so at
// its own declaration, and these calls are what that distinction costs.
//
// WHY live_caller_turn_non_english DID NOT FIRE, on any of them: it reads the
// CALLER's turn, and it excludes Spanish deliberately because a Spanish-speaking
// caller is legitimate rather than a fault. Both of those are correct. Together
// they leave the actual defect with no instrument at all.
//
// COUNT ONLY. Nothing is refused, no audio is cut, no reply is suppressed.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootLive, counters } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";
import { buildStaticSystemPrefix } from "../services/gemini.js";

const OPEN = { open: "09:00", close: "17:00", closed: false };
const baseConfig = (languagesSpoken) => ({
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
  ...(languagesSpoken ? { languagesSpoken } : {}),
  capabilities: {
    appointments: { enabled: true, adapter: "internal", availability: { length: 30, capacity: 1 } },
  },
});

/** CAdc602f's third turn, accents intact. */
const SPANISH = "Sí, es completamente normal. ¿En qué puedo ayudarte hoy?";
/**
 * The SAME turn as the structured log actually stores it.
 *
 * lib/logger.js writes non-ASCII as "?", so every fixture ever built from a log
 * pull carries this form. A detector that matches "sí" and "qué" would read
 * live traffic correctly and every log-derived fixture wrongly -- green where it
 * is blind, or blind where it is green. Both must work.
 */
const SPANISH_AS_LOGGED = "S?, es completamente normal. ?En qu? puedo ayudarte hoy?";
/** CAd48d7b's, the first of the three. */
const SPANISH_LVX133 =
  "Sí, hablo inglés; puedo cambiar de idioma si lo prefieres, o continuar en español. ¿Qué día y hora te gustaría agendar tu llamada?";

beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});
beforeEach(() => {
  clearStats();
});

describe("an English-only tenant answered in another language", () => {
  it("counts CAdc602f's actual turn", async () => {
    const s = await bootLive({ config: baseConfig(["en"]), callSid: "CA_lang_es" });
    await s.callerSays("Is that normal?");
    await s.assistantTurn(SPANISH);

    expect(counters().live_assistant_turn_non_english).toBe(1);
    // The denominator, without which a zero cannot be read.
    expect(counters().live_assistant_turn_language_checked).toBeGreaterThan(0);
  });

  it("counts it in the mangled form a log pull produces", async () => {
    const s = await bootLive({ config: baseConfig(["en"]), callSid: "CA_lang_mangled" });
    await s.assistantTurn(SPANISH_AS_LOGGED);
    expect(counters().live_assistant_turn_non_english).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // THE CASE THAT ACTUALLY PROVES THE ACCENT HANDLING, and it took a sabotage
  // row staying green to find it.
  //
  // The Spanish turns above survive without any accent handling at all, because
  // they carry unaccented markers too -- "es", "en", "puedo", "hoy". So they
  // cannot tell whether stripping works, and the first version of this file
  // claimed they did.
  //
  // Here every unaccented word -- prefere, ou, quinta, feira -- is a NON-marker.
  // The only marker in the sentence is "Você", and it only matches the stripped
  // "voce" if both sides are normalised. Break the stripping and this is the one
  // that goes red.
  // ---------------------------------------------------------------------------
  it("matches a marker that exists only in its accented form", async () => {
    const s = await bootLive({ config: baseConfig(["en"]), callSid: "CA_lang_accent" });
    await s.assistantTurn("Você prefere amanhã ou quinta feira");
    expect(counters().live_assistant_turn_non_english).toBe(1);
  });

  it("counts CAd48d7b's turn, the first of the three", async () => {
    const s = await bootLive({ config: baseConfig(["en"]), callSid: "CA_lang_lvx133" });
    await s.assistantTurn(SPANISH_LVX133);
    expect(counters().live_assistant_turn_non_english).toBe(1);
  });

  it("treats a missing languagesSpoken as English-only", async () => {
    // The tenant row's default. An absent field must not switch the check off.
    const s = await bootLive({ config: baseConfig(null), callSid: "CA_lang_default" });
    await s.assistantTurn(SPANISH);
    expect(counters().live_assistant_turn_non_english).toBe(1);
  });
});

describe("what must NOT be counted", () => {
  it("stays silent across ordinary English turns", async () => {
    const s = await bootLive({ config: baseConfig(["en"]), callSid: "CA_lang_en" });
    await s.assistantTurn(
      "Thanks for calling Digile Media. You're through to our AI receptionist — calls are recorded for quality. How can I help you today?"
    );
    await s.assistantTurn(
      "For tomorrow, Friday, September eighteenth, I have availability at nine AM, twelve thirty PM, or four thirty PM. Do any of those work for you?"
    );
    await s.assistantTurn("That is booked for Friday, September 18 at 3:00 PM under Marcus Bell.");

    expect(counters().live_assistant_turn_language_checked).toBeGreaterThan(0);
    expect(counters().live_assistant_turn_non_english).toBe(0);
  });

  it("does not flag an English sentence carrying a foreign proper noun", async () => {
    // "Your appointment is at La Quinta" is English. One English function word
    // settles it, which is why short Spanish articles are safe in the marker
    // set at all.
    const s = await bootLive({ config: baseConfig(["en"]), callSid: "CA_lang_noun" });
    await s.assistantTurn("Your appointment is at the La Quinta on Del Mar Boulevard at two o'clock.");
    expect(counters().live_assistant_turn_non_english).toBe(0);
  });

  it("leaves a MULTILINGUAL tenant alone, where Spanish is the product working", async () => {
    // services/gemini.js tells a tenant with more than one language to follow
    // the caller's language. Counting that as a fault would make this counter
    // fire hardest exactly where the behaviour is correct.
    const s = await bootLive({ config: baseConfig(["en", "es"]), callSid: "CA_lang_multi" });
    await s.assistantTurn(SPANISH);
    expect(counters().live_assistant_turn_non_english).toBe(0);
    expect(counters().live_assistant_turn_language_checked).toBe(0);
  });

  it("ignores a turn too short to judge", async () => {
    const s = await bootLive({ config: baseConfig(["en"]), callSid: "CA_lang_short" });
    await s.assistantTurn("Sí, claro.");
    expect(counters().live_assistant_turn_non_english).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// LVX149 — THE ENGLISH-ONLY TENANT WAS TOLD NOTHING ABOUT LANGUAGE.
//
// The identity section has carried two language branches for as long as it has
// existed: one for multilingual tenants and one for a single non-English
// language. Neither fires for languagesSpoken: ["en"] -- length 1, and it IS
// English -- so on the only tenant this project runs, the model was given no
// instruction about language anywhere in the prompt.
//
// It was not misbehaving when it drifted. Live transcription hands it the
// caller's turn already in another language:
//
//   CA5b7e359  caller "Ahm, no entiendo"     -> assistant answered in Spanish
//   CA58bb3640 caller "C'est tout bien"      -> assistant answered in French
//
// Both callers were speaking English. With nothing said about language, the
// reasonable response to a French sentence is a French sentence.
//
// These assert the PROMPT, not the counter. tests above cover the detector that
// notices a flip after the fact; this covers the one thing that might stop it
// happening.
// ---------------------------------------------------------------------------
describe("LVX149 — what an English-only tenant is told", () => {
  const prefixFor = (languagesSpoken) =>
    buildStaticSystemPrefix(baseConfig(languagesSpoken), {});

  it("tells an English-only tenant to answer in English", () => {
    const p = prefixFor(["en"]);
    expect(p).toMatch(/ALWAYS replies in English/);
    // And names the mis-hearing, because "reply in English" on its own competes
    // with a whole French sentence in the context and loses.
    expect(p).toMatch(/transcription mis-hearing an English speaker/);
  });

  it("treats a missing languagesSpoken the same way", () => {
    // services/db.js defaults the column, but a config assembled anywhere else
    // must not fall through into silence -- which is exactly how this defect
    // existed: by being the case no branch covered.
    const p = prefixFor(undefined);
    expect(p).toMatch(/ALWAYS replies in English/);
  });

  it("leaves a multilingual tenant on the mirroring rule", () => {
    const p = prefixFor(["en", "es"]);
    expect(p).toMatch(/ALWAYS reply in the language of the caller's most recent message/);
    expect(p).not.toMatch(/ALWAYS replies in English/);
  });

  it("leaves a single non-English tenant alone", () => {
    const p = prefixFor(["es"]);
    expect(p).toMatch(/Speak es by default/);
    expect(p).not.toMatch(/ALWAYS replies in English/);
  });
});

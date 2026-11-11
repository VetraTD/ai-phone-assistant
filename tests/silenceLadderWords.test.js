// ---------------------------------------------------------------------------
// Round A1, T5b — silence handled like a person (owner, 2026-10-13):
//   "If there is silence, shouldn't it behave like a normal receptionist … a
//    polite 'Hello?' or 'Are you there?' … then the second one being the
//    normal nudge and then it ending after that if nothing is there?"
//
// Rung 1 checks the caller is there. Rung 2 NEVER asks for a yes: the old
// confirm-step line "Just say yes to confirm, or let me know if anything needs
// to change." was a second confirmation, the exact thing round A1 removes.
// Rung 3 says goodbye like a person who has lost the line. Timings unchanged.
// Outbound lines are not touched.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { buildSilenceNudge, buildSilenceGoodbye } from "../lib/voice/session.js";
import { STEPS } from "../lib/callState.js";
import { getStrings, getOutboundStrings } from "../lib/voice/strings.js";

const EN = { mainPhone: "+18175803291" };
const ES = { mainPhone: "+18175803291", languagesSpoken: ["es"] };
const esConfig = ES;
const BOOKS = { ...EN, allowedTasks: ["take_message", "book_appointment"] };
const ES_BOOKS = { ...ES, allowedTasks: ["book_appointment"] };

// S4-F2 (call 13): the stage-2 check-in offered "book an appointment" on a line
// whose business takes no bookings. It offers a booking only where one exists.
describe("rung 2 at greeting / identify — offers a booking only where the business takes one", () => {
  const BOOK_EN = "I'm here to help — are you calling to book an appointment, leave a message, or something else?";
  const NO_BOOK_EN = "I'm here to help — are you calling to leave a message, or something else?";
  const NO_BOOK_ES = "Estoy aquí para ayudarle — ¿llama para dejar un mensaje, o algo más?";

  it("booking in allowedTasks keeps today's line, byte for byte", () => {
    for (const step of [STEPS.GREETING, STEPS.IDENTIFY_INTENT]) {
      expect(buildSilenceNudge(2, step, null, BOOKS)).toBe(BOOK_EN);
    }
    expect(buildSilenceNudge(2, STEPS.IDENTIFY_INTENT, null, ES_BOOKS)).toBe(
      "Estoy aquí para ayudarle — ¿llama para agendar una cita, dejar un mensaje, o algo más?"
    );
  });

  it("allowedTasks empty, missing or config null/undefined gets the no-booking line, without throwing", () => {
    for (const cfg of [{ ...EN, allowedTasks: [] }, EN, { ...EN, allowedTasks: ["take_message"] }, null, undefined]) {
      for (const step of [STEPS.GREETING, STEPS.IDENTIFY_INTENT]) {
        expect(buildSilenceNudge(2, step, null, cfg)).toBe(NO_BOOK_EN);
      }
    }
  });

  it("es twin", () => {
    expect(buildSilenceNudge(2, STEPS.IDENTIFY_INTENT, null, { ...ES, allowedTasks: [] })).toBe(NO_BOOK_ES);
    expect(buildSilenceNudge(2, STEPS.GREETING, null, ES)).toBe(NO_BOOK_ES);
  });

  it("stage 1 and the other steps do not change with the booking setting", () => {
    const none = { ...EN, allowedTasks: [] };
    expect(buildSilenceNudge(1, STEPS.IDENTIFY_INTENT, null, none)).toBe("Hello? Are you still there?");
    expect(buildSilenceNudge(2, STEPS.CONFIRM, null, none)).toBe(buildSilenceNudge(2, STEPS.CONFIRM, null, BOOKS));
    expect(buildSilenceNudge(2, STEPS.GATHER_DETAILS, "take_message", none)).toBe(
      buildSilenceNudge(2, STEPS.GATHER_DETAILS, "take_message", BOOKS)
    );
    expect(buildSilenceNudge(2, "ending", null, none)).toBe(buildSilenceNudge(2, "ending", null, BOOKS));
  });

  it("outbound is unchanged: nudgeOutbound1 first", () => {
    expect(buildSilenceNudge(2, STEPS.IDENTIFY_INTENT, null, { ...EN, allowedTasks: [] }, { config: {} })).toBe(
      getOutboundStrings({ ...EN, allowedTasks: [] }).nudgeOutbound1
    );
  });
});

const INBOUND_STEPS = [STEPS.GREETING, STEPS.IDENTIFY_INTENT, STEPS.GATHER_DETAILS, STEPS.CONFIRM, "ending"];

describe("rung 1 — 'Hello? Are you still there?'", () => {
  it("en, at every step", () => {
    for (const step of INBOUND_STEPS) {
      expect(buildSilenceNudge(1, step, null, EN)).toBe("Hello? Are you still there?");
    }
  });

  it("es", () => {
    expect(getStrings(esConfig).lang).toBe("es");
    expect(buildSilenceNudge(1, STEPS.CONFIRM, null, esConfig)).toBe("¿Hola? ¿Sigue ahí?");
  });
});

describe("rung 2 — never asks for a yes", () => {
  it("at the confirm step: still there, and it is ready whenever they are", () => {
    expect(buildSilenceNudge(2, STEPS.CONFIRM, "book_appointment", EN)).toBe(
      "Sorry, are you still there? I've got that ready for you whenever you are."
    );
  });

  it("the default step: take your time", () => {
    expect(buildSilenceNudge(2, "ending", null, EN)).toBe("Take your time, I'm here when you're ready.");
  });

  it("identify / gather lines are kept (they help a caller who is thinking)", () => {
    const S = getStrings(EN);
    expect(buildSilenceNudge(2, STEPS.IDENTIFY_INTENT, null, BOOKS)).toBe(S.nudgeIdentify);
    expect(buildSilenceNudge(2, STEPS.GATHER_DETAILS, "book_appointment", EN)).toBe(S.nudgeGatherBooking);
    expect(buildSilenceNudge(2, STEPS.GATHER_DETAILS, "take_message", EN)).toBe(S.nudgeGatherMessage);
  });

  it("no inbound ladder line, in either language, asks the caller to say yes", () => {
    for (const cfg of [EN, esConfig]) {
      for (const stage of [1, 2]) {
        for (const step of INBOUND_STEPS) {
          for (const intent of [null, "book_appointment", "take_message"]) {
            const line = buildSilenceNudge(stage, step, intent, cfg);
            expect(line).not.toMatch(/\bsay yes\b|\byes to confirm\b|\bdiga s[ií]\b/i);
          }
        }
      }
    }
  });

  it("es confirm and default lines", () => {
    expect(buildSilenceNudge(2, STEPS.CONFIRM, null, esConfig)).toBe(
      "Perdone, ¿sigue ahí? Lo tengo listo para cuando usted quiera."
    );
    expect(buildSilenceNudge(2, "ending", null, esConfig)).toBe("Tómese su tiempo, aquí estoy cuando esté listo.");
  });
});

describe("rung 3 — 'I think I've lost you', then the hang-up", () => {
  it("with the business's number", () => {
    expect(buildSilenceGoodbye(EN)).toBe(
      "I think I've lost you. Feel free to call us back at 817-580-3291. Bye for now."
    );
  });

  it("without a number", () => {
    expect(buildSilenceGoodbye({})).toBe("I think I've lost you. Feel free to call us back. Bye for now.");
  });

  it("es", () => {
    expect(buildSilenceGoodbye(esConfig)).toBe(
      "Creo que se cortó la llamada. Puede llamarnos de nuevo al 817-580-3291. Hasta luego."
    );
    expect(buildSilenceGoodbye({ ...esConfig, mainPhone: undefined })).toBe(
      "Creo que se cortó la llamada. Puede llamarnos de nuevo cuando quiera. Hasta luego."
    );
  });
});

describe("outbound is untouched", () => {
  it("still speaks its own lines", () => {
    const O = getOutboundStrings(EN);
    expect(buildSilenceNudge(1, STEPS.CONFIRM, null, EN, { config: {} })).toBe(O.nudgeOutbound1);
    expect(buildSilenceGoodbye(EN, { config: {} })).toBe(O.goodbyeOutbound);
    expect(O.nudgeOutbound1).toBe("Are you still there?");
    expect(O.goodbyeOutbound).toBe("It seems now isn't a good time. We'll try again another time. Goodbye.");
  });
});

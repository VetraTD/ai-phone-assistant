/**
 * STT-ADJACENT (baseline): an unusual name the model is likely to mishear or
 * misspell. A careful receptionist confirms the spelling before writing it into
 * a booking. This is expected to FAIL against the current brain — that's the
 * point: it's a baseline marker for a later STT/confirmation phase, not a
 * regression. Judge-only, since "did it confirm spelling" is a fuzzy judgement.
 */
import { nextWeekdayAt, spokenSlot } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const SLOT = nextWeekdayAt("tue", "16:00", { timezone: TZ });

export default {
  name: "name-spell-back",
  tags: ["stt"],
  fixture: "appointments-db",
  caller: {
    mode: "persona",
    persona:
      "You are Kaelyn Szymanski. Your name is unusual and easy to misspell. You pronounce it but do not spell it " +
      "unless asked. You are happy to spell it out if the receptionist asks.",
    goal:
      `Book an appointment for ${spokenSlot(SLOT, TZ)}. Give your name as Kaelyn Szymanski (say it, don't spell it ` +
      `unless asked). If the receptionist asks you to spell it, do so. Confirm the booking when read back.`,
    maxTurns: 8,
  },
  hard: [],
  judge: [
    "Before writing the caller's name into the booking, did the receptionist confirm the spelling of the unusual name (e.g. ask them to spell it or read it back letter by letter)?",
    "Was the name ultimately captured correctly as 'Kaelyn Szymanski'?",
  ],
};

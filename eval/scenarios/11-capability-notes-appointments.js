/**
 * FREETEXT: an operator note constrains booking policy — no new-patient visits
 * on Fridays, offer Monday instead. The receptionist must honour it: never book
 * a Friday for this new patient, and steer them to Monday.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, spokenSlot, argIsWeekday } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const FRIDAY = nextWeekdayAt("fri", "10:00", { timezone: TZ });

export default {
  name: "capability-notes-appointments",
  tags: ["freetext"],
  fixture: "appointments-availability",
  configPatch: {
    capabilities: {
      appointments: {
        enabled: true,
        adapter: "internal",
        availability: { length: 30, capacity: 1 },
        require: { identity: { builtin: ["name"] } },
        notes: "We never book new-patient visits on Fridays; offer Monday instead.",
      },
    },
  },
  caller: {
    mode: "persona",
    persona:
      "You are Sam Okafor, a NEW patient (say so if asked). Friendly, a little flexible on timing.",
    goal:
      `You want a new-patient visit and your first ask is ${spokenSlot(FRIDAY, TZ)}. If the receptionist says ` +
      `Friday isn't available for new patients and offers Monday, accept the Monday they propose and confirm.`,
    maxTurns: 8,
  },
  hard: [
    (ctx) =>
      A.toolNotCalledWith(
        ctx,
        "book_appointment",
        (args) => argIsWeekday(args.scheduled_at, "fri", TZ),
        "scheduled_at falls on a Friday"
      ),
  ],
  judge: [
    "Did the receptionist decline to book the new-patient visit on Friday?",
    "Did the receptionist offer Monday as the alternative, per the business's policy?",
  ],
};

/**
 * PERSONA: a chatty elderly caller who buries the real details inside stories.
 * The receptionist must patiently extract the correct booking args without
 * losing the buried facts, and without getting derailed.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, spokenSlot, slotMatches } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const SLOT = nextWeekdayAt("wed", "13:00", { timezone: TZ });

export default {
  name: "rambling-elderly",
  tags: ["persona"],
  fixture: "appointments-db",
  caller: {
    mode: "persona",
    persona:
      "You are Harold Finch, a warm, talkative older gentleman. You tell little stories about your grandkids and " +
      "the weather, and you tuck the important details INSIDE those stories (your name is Harold Finch; you mention " +
      "the day/time while reminiscing). You get there eventually and are perfectly cooperative.",
    goal:
      `Somewhere in your chatter, convey that you'd like to come in for a denture fitting on ` +
      `${spokenSlot(SLOT, TZ)}. Give your name as Harold Finch. Confirm the booking when the receptionist reads it back.`,
    maxTurns: 9,
  },
  hard: [
    (ctx) => A.toolSucceeded(ctx, "book_appointment"),
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "book_appointment",
        (args) => slotMatches(args.scheduled_at, SLOT, TZ),
        "scheduled_at = the slot buried in the story"
      ),
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "book_appointment",
        (args) => /harold\s+finch/i.test(args.client_name || ""),
        "client_name = Harold Finch"
      ),
  ],
  judge: [
    "Did the receptionist stay patient and warm with a rambling caller?",
    "Did the receptionist extract the correct details without losing any that were buried in the stories?",
  ],
};

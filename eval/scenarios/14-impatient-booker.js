/**
 * PERSONA: an impatient caller who wants to be booked fast. The receptionist
 * should still get correct booking args, and should get there efficiently
 * (≤ 6 turns) without a drawn-out interrogation.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, spokenSlot, slotMatches } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const SLOT = nextWeekdayAt("mon", "09:30", { timezone: TZ });

export default {
  name: "impatient-booker",
  tags: ["persona"],
  fixture: "appointments-db",
  caller: {
    mode: "persona",
    persona:
      "You are Tanya Brooks, in a hurry and a bit brusque. Short answers. You dislike being asked for things " +
      "you consider unnecessary, but you WILL answer direct questions to get booked.",
    goal:
      `Book an appointment for ${spokenSlot(SLOT, TZ)} under the name Tanya Brooks as quickly as possible. ` +
      `Answer only what's asked, confirm briefly, and end the call the moment it's booked.`,
    maxTurns: 8,
  },
  hard: [
    (ctx) => A.toolSucceeded(ctx, "book_appointment"),
    (ctx) => A.turnsAtMost(ctx, 6),
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "book_appointment",
        (args) => slotMatches(args.scheduled_at, SLOT, TZ),
        "scheduled_at = requested slot"
      ),
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "book_appointment",
        (args) => /tanya/i.test(args.client_name || ""),
        "client_name contains Tanya"
      ),
  ],
  judge: [
    "Did the receptionist book the appointment without asking for unnecessary information?",
    "Did the receptionist stay polite and efficient with an impatient caller?",
  ],
};

/**
 * PARTIAL ANSWERS — reported from a live test call by the owner of Digile
 * Media: "When the AI asks two questions at once, it appears to wait for the
 * caller to answer both before continuing. If the caller only answers one of
 * the questions, there can be quite a long silence before the AI responds."
 *
 * There are two separate defects behind that sentence and this scenario is
 * aimed at the second one:
 *
 *   1. The CAUSE — the booking step guidance stacked two questions into one
 *      bullet under a header reading "One question at a time". Fixed in
 *      capabilities/appointments.js.
 *   2. The RECOVERY — nothing told the model what to do when only half an
 *      answer came back. Fixed with a GUARDRAILS bullet in services/gemini.js.
 *
 * The caller here gives a DAY when asked when they want to come in, and leaves
 * the time out entirely — the shape that produced the silence. The
 * receptionist has to take the half it was given, acknowledge it, and ask for
 * the missing half separately, rather than stalling for the rest of an answer
 * that is never coming.
 *
 * Note what this scenario CANNOT do: now that the assistant asks one thing per
 * turn, it will rarely present a two-part question for the caller to half-
 * answer. The partial answer therefore has to come from the CALLER under-
 * answering a single question, which is the same recovery path and the more
 * common one on a real call anyway.
 *
 * Uses the availability fixture deliberately: the internal-calendar branch is
 * the one Digile Media actually runs, and it is the branch that had the bug.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, spokenSlot, slotMatches } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const SLOT = nextWeekdayAt("tue", "10:00", { timezone: TZ });

export default {
  name: "partial-answer",
  tags: ["regression", "turn-taking"],
  fixture: "appointments-availability",
  caller: {
    mode: "persona",
    persona:
      "You are Dana Whitfield. You give SHORT, incomplete answers and never volunteer anything you were not " +
      "just asked for. When you say what you want, you name only the DAY and leave the time out entirely. You " +
      "are polite and cooperative, and you DO accept a time that suits you when one is offered.",
    goal:
      `You want an appointment on Tuesday at ten in the morning. When you are first asked what you are calling ` +
      `about, say "I'd like to book an appointment for Tuesday" — name the DAY but NOT the time, and do not ` +
      `mention the time at all until you are asked about it specifically, at which point say "ten in the ` +
      `morning". Your name is Dana Whitfield. If a Tuesday 10 AM slot is offered, accept it; if a different ` +
      `time is offered, say you would prefer ten in the morning. Confirm the booking when it is read back.`,
    maxTurns: 12,
  },
  hard: [
    // The call has to actually complete. A stall is exactly the reported bug.
    (ctx) => A.toolSucceeded(ctx, "book_appointment"),
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "book_appointment",
        (args) => slotMatches(args.scheduled_at, SLOT, TZ),
        "scheduled_at = agreed slot",
      ),
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "book_appointment",
        (args) => /dana\s+whitfield/i.test(args.client_name || ""),
        "client_name = Dana Whitfield",
      ),
  ],
  judge: [
    "Did the receptionist ask only ONE question per turn, rather than stacking two questions into a single response (including in its very first turn)?",
    "When the caller gave only a day and no time, did the receptionist acknowledge the day it got and ask for the time separately, rather than re-asking the whole question or stalling?",
    "Did the receptionist avoid re-asking for anything the caller had already answered?",
  ],
};

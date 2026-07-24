/**
 * MEMORY / LONG CALL: the caller gives their name AND a distinctive care note
 * ("my dog Biscuit gets anxious — note it's for a nervous dog") in the very
 * first turn, then makes ~20 turns of innocuous small talk before finally
 * booking. When the booking is written, the turn-1 name must still be exactly
 * right and the nervous-dog note must ride along — the caller never repeats
 * either.
 *
 * This is the scenario that exercises Task 2.1 (turn-aware history trimming).
 * The call runs long enough that turn 1 falls OUTSIDE the old 40-ENTRY window:
 * at the booking turn the prior history is ~23 turns = ~46 entries, so the old
 * `history.slice(-40)` provably evicts turn 1 (and could split a user/model
 * pair, leaving the window on an orphan model entry). trimHistory keeps whole
 * turns and never drops the completed-action notes.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, spokenSlot, slotMatches } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const SLOT = nextWeekdayAt("wed", "14:00", { timezone: TZ });

const carriesNervousDog = (args) => {
  const blob = `${args.notes || ""} ${args.service_type || ""}`.toLowerCase();
  return /nervous|anxious|biscuit/.test(blob);
};

export default {
  name: "long-call-memory",
  tags: ["memory", "long"],
  fixture: "appointments-db",
  caller: {
    mode: "scripted",
    turns: [
      // Turn 1 — name + the distinctive fact that must survive to the booking.
      "Hi, this is Marcus Webb. Before anything else — my dog Biscuit gets really " +
        "anxious at the vet, so please make a note that this appointment is for a very nervous dog.",
      // Turns 2..21 — innocuous small talk / info questions (cheap one-liners).
      "No rush at all. How's your day going so far?",
      "Good to hear. What are your opening hours during the week?",
      "Okay. Are you open on Saturdays at all?",
      "Got it. Do you have parking at the clinic?",
      "Is the parking free or paid?",
      "Alright. Do you offer dental cleanings for dogs?",
      "How about nail trims — do you do those too?",
      "Perfect. Roughly how long does a routine checkup usually take?",
      "Do you take walk-ins, or is it appointment only?",
      "Understood. Do you have a vet who's especially good with anxious pets?",
      "That's reassuring. Is there a groomer on site as well?",
      "Okay. Do you sell any calming treats or supplements there?",
      "Good to know. Is the clinic wheelchair accessible? My mother sometimes comes along.",
      "Great. Do you send appointment reminders by text?",
      "Thanks. What's the best number to reach you if I have a question later?",
      "Okay. Do you handle emergencies after hours?",
      "Good. Are you accepting new patients right now?",
      "Is there anything I should bring to the first visit?",
      "Should Biscuit be fasting before a checkup?",
      // Turns 22..23 — book, using the slot; single explicit confirmation.
      `Alright, I'm ready to book now. Let's do a routine checkup for ${spokenSlot(SLOT, TZ)}, please.`,
      "Yes, that's the right time — please go ahead and book it.",
    ],
  },
  hard: [
    (ctx) => A.toolSucceeded(ctx, "book_appointment"),
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "book_appointment",
        (args) => /marcus\s+webb/i.test(args.client_name || ""),
        "client_name = Marcus Webb (from turn 1, never repeated)"
      ),
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "book_appointment",
        (args) => slotMatches(args.scheduled_at, SLOT, TZ),
        "scheduled_at = agreed slot"
      ),
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "book_appointment",
        carriesNervousDog,
        "booking carries the turn-1 nervous-dog note"
      ),
  ],
  judge: [
    "Did the receptionist remember the caller's name and the note about the nervous dog from the very " +
      "start of the call, and use them at booking time without asking for either again?",
    "Did the receptionist avoid re-asking for any information the caller had already provided?",
  ],
};

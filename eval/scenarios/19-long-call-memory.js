/**
 * MEMORY / LONG CALL: the caller gives their name AND a distinctive care note
 * ("I get anxious at the dentist — note I'm a very nervous patient") in the very
 * first turn, then makes ~17 turns of innocuous small talk before finally
 * booking. When the booking is written, the turn-1 name must still be exactly
 * right and the nervous-patient note must ride along — the caller never repeats
 * either.
 *
 * The care note is themed to the fixture (appointments-db = Acme Dental, a
 * human dental practice): a "nervous patient" note is something a dental office
 * would sensibly record, so the model actually carries it into the booking
 * rather than discarding it as nonsensical for the business.
 *
 * This is the scenario that exercises Task 2.1 (turn-aware history trimming,
 * `trimHistory`, 20-turn window). The call is sized so turn 1 sits at the
 * OLDEST edge of that window: at the final booking turn there are 20 prior
 * turns, so turn 1 is the first turn still retained. trimHistory keeps WHOLE
 * turns — it never splits a user/model pair the way the old `history.slice(-40)`
 * entry-slice could once tool round-trips push a turn past two entries, and it
 * never drops the completed-action system notes — so turn 1's user entry (and
 * the name + nervous-patient note it carries) reaches the booking turn intact.
 * Push the call one turn longer and turn 1 would evict: that boundary is the
 * point.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, spokenSlot, slotMatches } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const SLOT = nextWeekdayAt("wed", "14:00", { timezone: TZ });

const carriesNervousNote = (args) => {
  const blob = `${args.notes || ""} ${args.service_type || ""}`.toLowerCase();
  return /nervous|anxious/.test(blob);
};

export default {
  name: "long-call-memory",
  tags: ["memory", "long"],
  fixture: "appointments-db",
  caller: {
    mode: "scripted",
    turns: [
      // Turn 1 — name + the distinctive fact that must survive to the booking.
      "Hi, this is Marcus Webb. Before anything else — I get really anxious at " +
        "the dentist, so please make a note that I'm a very nervous patient and to take things gently.",
      // Turns 2..18 — innocuous small talk / info questions (cheap one-liners).
      "No rush at all. How's your day going so far?",
      "Good to hear. What are your opening hours during the week?",
      "Okay. Are you open on Saturdays at all?",
      "Got it. Do you have parking at the practice?",
      "Alright. Do you offer teeth whitening?",
      "How often should I be coming in for a routine cleaning?",
      "Perfect. Roughly how long does a routine checkup usually take?",
      "Do you take walk-ins, or is it appointment only?",
      "Understood. Do you have a hygienist who's especially gentle with anxious patients?",
      "Okay. Do you offer any sedation options for nervous patients?",
      "Good to know. Is the practice wheelchair accessible? My mother sometimes comes along.",
      "Great. Do you send appointment reminders by text?",
      "Thanks. What's the best number to reach you if I have a question later?",
      "Okay. Do you handle dental emergencies after hours?",
      "Good. Are you accepting new patients right now?",
      "Is there anything I should bring to the first visit?",
      "Should I avoid eating right before a checkup?",
      // Turns 19..21 — book using the slot, answer the one spelling-confirm
      // prompt the booking guardrail triggers, then a single explicit go-ahead.
      `Alright, I'm ready to book now. Let's do a routine checkup for ${spokenSlot(SLOT, TZ)}, please.`,
      // The receptionist confirms the spelling of the last name once before the
      // read-back (booking guardrail); the caller obliges, restating the full
      // name (the first name must still ride through to the booking).
      "Sure, it's Marcus Webb — W-E-B-B.",
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
        carriesNervousNote,
        "booking carries the turn-1 nervous-patient note"
      ),
  ],
  judge: [
    "Did the receptionist remember the caller's name and the note about being a nervous patient from the " +
      "very start of the call, and use them at booking time without asking for either again?",
    "Did the receptionist avoid re-asking for any information the caller had already provided?",
  ],
};

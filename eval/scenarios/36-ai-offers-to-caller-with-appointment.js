/**
 * THE ASSISTANT'S OWN OFFER — the case the first fix was blind to.
 *
 * Production call 0db83104 (2026-08-05), reconstructed. The caller had a 2 PM
 * strategy call booked. They asked about services. The assistant answered and
 * then offered:
 *
 *   [ai] "...We also offer a free strategy call to discuss your specific goals.
 *         Would you like to set up a strategy call or have someone get back to
 *         you?"
 *
 * It went on to collect a time, and only discovered the conflict when the caller
 * said "Wait. But don't I already have a call?" — four turns later.
 *
 * The rule was in the book_appointment STEP guidance, which is keyed on intent.
 * At the moment of the offer the model was still in general_question, so the
 * rule had not been rendered. Asking is the caller-initiated path (scenario 31);
 * this is the assistant-initiated one, and it is the one that failed live.
 *
 * The persona deliberately asks the question that invites a sales offer, and
 * never asks to book.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, hoursOpenNow } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const CALLER_PHONE = "+15558675309";
const EXISTING = nextWeekdayAt("thu", "14:00", { timezone: TZ });

export default {
  name: "ai-offers-to-caller-with-appointment",
  tags: ["existing-appointment", "rules"],
  fixture: "appointments-db",
  // The stock fixture is a dental practice, which has no reason to pitch a
  // consultation after a services question — so without this the scenario
  // passed vacuously: the assistant never made an offer, and every assertion
  // about the offer held trivially. The business is redressed as the agency the
  // live call actually involved, so answering the services question genuinely
  // leads toward "would you like to set up a call?".
  // businessHours pinned open: the after-hours policy otherwise diverts
  // booking to a callback depending on the time of day the suite runs.
  configPatch: {
    businessHours: hoursOpenNow(),
    businessName: "Digile Media",
    generalInfo:
      "Digile Media is a digital marketing agency for service businesses. We generate qualified lead " +
      "enquiries through Meta and Google Ads, paired with sales systems that reduce reliance on " +
      "referrals. We offer a free strategy call to discuss a prospect's goals.",
    customInstructions:
      "When a caller shows interest in what we do, invite them to book a free strategy call so the team " +
      "can go through their goals properly.",
  },
  extrasPatch: {
    callerPhone: CALLER_PHONE,
    callerContext: {
      callCount: 2,
      lastCallSummary: "booked a strategy call",
      upcomingAppointments: [{ id: "appt-existing", client_name: "Boris Johnson", scheduled_at: EXISTING }],
    },
  },
  seedAppointments: [
    {
      id: "appt-existing",
      client_name: "Boris Johnson",
      client_phone: CALLER_PHONE,
      scheduled_at: EXISTING,
      status: "scheduled",
    },
  ],
  caller: {
    mode: "persona",
    // The persona must not be free to cancel. Left open, the simulator
    // improvised "that's news to me, I don't recall scheduling anything",
    // cancelled the appointment, and then offering a call was entirely correct —
    // the scenario failed on an empty store while the product had done nothing
    // wrong. Pinning the caller's memory of the booking keeps the run on the
    // path under test.
    persona:
      "You are Boris Johnson, who runs a plumbing company. You already have a strategy call booked with " +
      "them and you remember it perfectly well — you are happy with it, and you must NEVER ask to " +
      "cancel, move or change it. Ask what their hours are, then ask them to tell you about their " +
      "services and how they could help a plumbing company. You are NOT trying to book anything and you " +
      "must never ask to book — you are only gathering information. If they OFFER to set something up, " +
      "say 'yeah, let's do that' once, and see what happens. Then wrap up.",
    goal: "Learn about their services. Do not ask to book anything.",
    maxTurns: 7,
  },
  hard: [
    // The invariant: exactly one appointment survives. The caller never asked
    // for a second one, so no route to two is acceptable.
    (ctx) => {
      const rows = ctx.store?.scheduled?.() || [];
      return {
        pass: rows.length === 1,
        name: "still-exactly-one-appointment",
        detail: `scheduled rows = ${rows.length}`,
      };
    },
    // Any pitch for a NEW call must name the existing appointment in the same
    // reply. The first version of this pattern only matched "would you like to
    // set up a strategy call?" and sailed straight past "We'd love to invite you
    // to book a free strategy call — would you be interested in setting that
    // up?", which is the same failure in different words and is what an eval run
    // actually produced. Matched per-reply so a later, correct mention elsewhere
    // in the call cannot excuse an unqualified offer here.
    (ctx) => {
      const OFFER =
        /(would you like|shall i|can i|happy to|we'?d love to|love to invite you)[^.?!]*\b(book|schedule|set(ting)? up|arrange)\b|invite you to book/i;
      const MENTIONS = /already (have|has|got)|existing appointment|you'?re (already )?(booked|scheduled)|one scheduled/i;
      const bad = (ctx.turns || [])
        .map((t) => t?.reply ?? "")
        .filter((m) => OFFER.test(m) && !MENTIONS.test(m));
      return {
        pass: bad.length === 0,
        name: "no-offer-without-naming-the-existing-appointment",
        detail: bad.length ? `unqualified offer: "${bad[0].slice(0, 160)}"` : "none",
      };
    },
    // The specific live failure: never describe the caller's own slot as taken.
    (ctx) => A.replyNeverMatches(ctx, /(that time|it|2 ?pm)[^.?!]*\b(is|looks|appears)\b[^.?!]*\b(already )?taken\b/i),
    // And never the "sorry I didn't mention it" apology that ended the real call.
    (ctx) => A.replyNeverMatches(ctx, /apologi[sz]e for not mentioning|should have mentioned/i),
  ],
  judge: [
    "If the receptionist raised booking at all, did it mention the caller's existing appointment in the same breath?",
    "Did the caller avoid having to point out their own appointment?",
    "Did it answer the services question properly rather than deflecting into scheduling?",
  ],
};

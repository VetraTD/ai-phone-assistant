/**
 * Appointments capability pack.
 *
 * Booking, checking, cancelling and rescheduling. The most complex pack and the
 * one the whole abstraction was extracted from: stateful, identity-strict, and
 * backed by an external system.
 *
 * This pack now owns the capability end to end: tool declarations, prompt
 * fragments, execution, the identity checks, the per-call scratchpad, and the
 * side effects of a completed booking or change. Nothing about appointments
 * lives in services/gemini.js, services/tools.js or lib/voice/session.js any
 * more.
 *
 * All of it was moved VERBATIM — every description and instruction string is
 * byte-identical, because tests/promptSnapshot.test.js asserts neither the
 * merged tool list nor the prompt changed by a single character.
 *
 * Still to come (Step B): the hand-rolled identity check below becomes the
 * generic `identity` requirement kind, and the athena-shaped EHR tools become
 * adapter-shaped so a clinic can move to another system without the prompt
 * changing.
 */

import { resolveDayHours, formatClockTime, resolveBusinessHoursForPrompt } from "../lib/businessHours.js";
import {
  DEFAULT_TIMEZONE,
  HAS_OFFSET_RE,
  formatLocalDateTime,
  getTzOffsetMs,
  parseNaiveDateTime,
  speakableDateTime,
  toLocalNaiveDateTime,
  zonedComponentsToUtcMs,
  zonedWeekdayAndMinutes,
} from "../lib/capabilities/datetime.js";
import { noBusinessResult, unknownToolResult } from "../lib/capabilities/results.js";
import {
  withRequirements,
  requirementPromptLines,
  notesPromptLines,
  capabilityConfig,
  isClosedNow,
} from "../lib/capabilities/requirements.js";
import { resolveSchedulingAdapter } from "../adapters/scheduling/index.js";
import { resolveProfile } from "../lib/voice/voiceLocale.js";
import { declineGuardrail } from "../lib/capabilities/decline.js";

/**
 * Booking. Registered only when the business opted into the book_appointment
 * module (services/gemini.js:109 previously).
 */
const BOOK_APPOINTMENT_DECLARATION = {
  name: "book_appointment",
  description:
    "Book an appointment after the caller has confirmed the details " +
    "(name, date/time, service type). Call this only after confirmation.",
  parameters: {
    type: "object",
    properties: {
      client_name: { type: "string", description: "Full name of the client" },
      scheduled_at: {
        type: "string",
        description:
          "ISO 8601 datetime for the appointment (e.g. 2025-03-15T10:00:00)",
      },
      service_type: {
        type: "string",
        description: "Type of service or consultation requested",
      },
      notes: {
        type: "string",
        description: "Any additional notes about the appointment or client needs",
      },
    },
    required: ["scheduled_at"],
  },
};

/**
 * EHR-backed appointment tools. Present when the business has an enabled
 * athenahealth integration.
 *
 * TRANSITIONAL: these are athena-shaped rather than adapter-shaped. Step B
 * introduces the `scheduling` adapter interface (findSlots / book / cancel /
 * reschedule / lookupByCaller) and these declarations become adapter-neutral,
 * which is what lets a clinic move to Cerner without touching the prompt.
 */
const EHR_APPOINTMENT_DECLARATIONS = [
  {
    name: "get_caller_appointments",
    description: "Look up the caller's upcoming appointments in the EHR.",
    parameters: {
      type: "object",
      properties: {
        caller_name: { type: "string", description: "Caller's full name" },
        caller_dob: { type: "string", description: "Date of birth (YYYY-MM-DD)" },
        caller_phone: { type: "string", description: "Caller's phone number" },
      },
      required: ["caller_name"],
    },
  },
  {
    name: "get_available_slots",
    description: "Get available appointment slots for a given date and optional service type.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date to check (YYYY-MM-DD)" },
        service_type: { type: "string", description: "Type of appointment (optional)" },
      },
      required: ["date"],
    },
  },
  {
    name: "book_appointment_in_ehr",
    description: "Book an appointment in the EHR for the caller.",
    parameters: {
      type: "object",
      properties: {
        caller_name: { type: "string", description: "Caller's full name" },
        caller_phone: { type: "string", description: "Caller's phone number" },
        caller_dob: { type: "string", description: "Date of birth (YYYY-MM-DD)" },
        scheduled_at: { type: "string", description: "Appointment date and time (ISO 8601)" },
        service_type: { type: "string", description: "Type of appointment" },
        notes: { type: "string", description: "Optional notes" },
      },
      required: ["caller_name", "caller_dob", "scheduled_at"],
    },
  },
  {
    name: "cancel_appointment",
    description: "Cancel an existing appointment for the caller. Requires their name and date of birth to verify identity, plus the date of the appointment to cancel.",
    parameters: {
      type: "object",
      properties: {
        caller_name: { type: "string", description: "Caller's full name" },
        caller_dob: { type: "string", description: "Date of birth (YYYY-MM-DD)" },
        caller_phone: { type: "string", description: "Caller's phone number (for disambiguation)" },
        appointment_date: { type: "string", description: "Date of the appointment to cancel (YYYY-MM-DD)" },
        appointment_time: { type: "string", description: "Time of the appointment to cancel (HH:MM, optional)" },
        reason: { type: "string", description: "Reason for cancellation (optional)" },
      },
      required: ["caller_name", "caller_dob"],
    },
  },
  {
    name: "reschedule_appointment",
    description: "Reschedule an existing appointment to a new date and time. Requires the caller's name and date of birth, the current appointment date, and the desired new date.",
    parameters: {
      type: "object",
      properties: {
        caller_name: { type: "string", description: "Caller's full name" },
        caller_dob: { type: "string", description: "Date of birth (YYYY-MM-DD)" },
        caller_phone: { type: "string", description: "Caller's phone number (for disambiguation)" },
        current_appointment_date: { type: "string", description: "Date of the existing appointment (YYYY-MM-DD)" },
        current_appointment_time: { type: "string", description: "Time of the existing appointment (HH:MM, optional)" },
        new_date: { type: "string", description: "Desired new date (YYYY-MM-DD)" },
        new_time: { type: "string", description: "Desired new time (HH:MM, optional)" },
        service_type: { type: "string", description: "Type of appointment (optional)" },
      },
      required: ["caller_name", "caller_dob", "new_date"],
    },
  },
];

/** EHR tools that WRITE — these take configured requirements and are gated. */
const EHR_WRITE_TOOLS = new Set([
  "book_appointment_in_ehr",
  "cancel_appointment",
  "reschedule_appointment",
]);

/**
 * Internal-database appointment tools — the no-EHR path.
 *
 * The phone_last4 second factor in cancel/reschedule is a hand-rolled instance
 * of what becomes the generic `identity` requirement kind in Step B.
 */
const DB_APPOINTMENT_DECLARATIONS = [
  {
    name: "get_caller_appointments_from_db",
    // The declaration used to say "by their phone or name" and offer
    // caller_phone and caller_name parameters. Both were fictional: the handler
    // has always looked up strictly by ctx.callerPhone, taken from call
    // metadata, and ignored every argument it was passed.
    //
    // That lie had a cost. Told it could search by name, the model searched by
    // name — on a live call it looked for a caller's WIFE, and then reported
    // "I wasn't able to find an appointment for Sarah Chen", which is a
    // disclosure about a third party AND a description of a search that never
    // happened. An eval scenario reproduced it on the first run.
    //
    // Describing what the tool actually does removes the invitation. The
    // parameters are gone for the same reason, plus one more: a caller's name
    // in tool arguments is PII that ends up in logs.
    description:
      "Look up the appointments belonging to the person on this call. Takes no arguments — it always uses the number the caller is calling from. It cannot search for anyone else, by name or otherwise. Use when the business does not have an EHR integration.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "cancel_appointment_db",
    description:
      "Cancel an appointment in our database. Use appointment_id from get_caller_appointments_from_db, or omit if the caller has only one appointment (we use the one we looked up).",
    parameters: {
      type: "object",
      properties: {
        appointment_id: { type: "string", description: "UUID of the appointment to cancel (optional if caller has one appointment)" },
        client_name: {
          type: "string",
          description:
            "The name the appointment is booked under, if the caller gave one. Only used together with phone_last4 to verify the appointment belongs to them when they're calling from a different number — a name on its own is never enough.",
        },
        phone_last4: {
          type: "string",
          description:
            "The last 4 digits of the phone number the appointment is booked under, as stated by the caller. REQUIRED whenever the caller is not calling from that number and you are identifying them by name — without it the cancellation will be refused.",
        },
      },
      required: [],
    },
  },
  {
    name: "reschedule_appointment_db",
    description:
      "Reschedule an appointment in our database to a new date/time. Use appointment_id from get_caller_appointments_from_db, or omit if the caller has only one appointment.",
    parameters: {
      type: "object",
      properties: {
        appointment_id: { type: "string", description: "UUID of the appointment (optional if caller has one appointment)" },
        new_scheduled_at: {
          type: "string",
          description: "New date and time in ISO 8601 format (e.g. 2026-04-15T10:00:00)",
        },
        client_name: {
          type: "string",
          description:
            "The name the appointment is booked under, if the caller gave one. Only used together with phone_last4 to verify the appointment belongs to them when they're calling from a different number — a name on its own is never enough.",
        },
        phone_last4: {
          type: "string",
          description:
            "The last 4 digits of the phone number the appointment is booked under, as stated by the caller. REQUIRED whenever the caller is not calling from that number and you are identifying them by name — without it the reschedule will be refused.",
        },
      },
      required: ["new_scheduled_at"],
    },
  },
];

/**
 * Which backend owns this business's appointment book.
 *
 * Config decides; an enabled EHR integration is honoured as the legacy routing
 * for a business not yet configured. This replaced two hardcoded
 * `provider === "athenahealth"` comparisons — adding a second EHR used to mean
 * editing the engine in three places.
 *
 * @param {object} config - normalised business config
 * @param {Array} integrations
 */
function schedulingAdapter(config, integrations) {
  return resolveSchedulingAdapter(capabilityConfig(config, "appointments"), integrations);
}

/**
 * Does an external system own the appointment book?
 *
 * When one does, the internal-DB tools are suppressed: two systems of record
 * for one appointment is a data-integrity bug, not a preference, and the model
 * must not be able to write to both.
 */
function hasExternalBook(config, integrations) {
  return schedulingAdapter(config, integrations).id !== "internal";
}

// ---------------------------------------------------------------------------
// Prompt fragments
//
// This is the part the whole refactor exists for. The booking flow below used
// to be a hardcoded `if (intent === "book_appointment")` branch inside
// services/gemini.js, which meant every business on the platform booked
// appointments the same way and changing that for one of them meant editing
// the engine.
//
// It is still hardcoded here — Step A only moves it. What changes is that it
// now has ONE owner, so Step B can layer per-business config on top: an
// enforced `require` block for the things that must be guaranteed, and a prose
// `notes` field for the endless small variations ("ask morning or afternoon
// first", "never offer Friday afternoon"). Neither is wired up yet; adding
// unreachable config plumbing before the data exists would be untested code.
// ---------------------------------------------------------------------------

/** The module tasks this capability owns — presence of any means "enabled". */
const APPOINTMENT_MODULE_TASKS = ["book_appointment", "check_appointment", "cancel_reschedule"];

/**
 * Read the availability settings, defaulting at read-time so a business that
 * never touched them still books into 30-minute, single-capacity slots.
 * WHETHER availability is checked is not a per-business flag — it is inherent to
 * the built-in calendar (any adapter exposing `checkAvailability`). These are
 * only the numbers that define a slot.
 * @param {object} cfg - appointments capability config
 * @returns {{length: number, capacity: number}}
 */
function availabilitySettings(cfg) {
  const a = cfg?.availability || {};
  return {
    length: Number.isInteger(a.length) ? a.length : 30,
    capacity: Number.isInteger(a.capacity) ? a.capacity : 1,
  };
}

/** The what-you-can-do clauses for the CAPABILITIES line. */
function capabilityClauses(allowed) {
  const hasAll =
    allowed.includes("book_appointment") &&
    allowed.includes("check_appointment") &&
    allowed.includes("cancel_reschedule");

  if (hasAll) {
    return [
      "book, check, cancel, and reschedule appointments (using scheduling tools when available, or take details for follow-up)",
    ];
  }

  const clauses = [];
  if (allowed.includes("book_appointment")) clauses.push("book appointments");
  if (allowed.includes("check_appointment")) {
    clauses.push(
      "help with appointment inquiries (you cannot access the schedule directly — take details for follow-up)"
    );
  }
  if (allowed.includes("cancel_reschedule")) {
    clauses.push(
      "help with cancelling or rescheduling appointments (using scheduling tools when available, or by taking detailed information for follow-up)"
    );
  }
  return clauses;
}

/**
 * The booking flow. Renders today's hours inline so the model suggests times
 * the business is actually open for, which is why this is DYNAMIC guidance and
 * must never be cached into the static prefix.
 */
/**
 * Steer the model to decline booking/changes while the office is closed, when
 * the business set businessHoursOnly. This is the up-front counterpart to the
 * checkRequirements refusal, so the caller is never walked through a flow that
 * cannot complete.
 */
const CLOSED_BOOKING_DECLINE =
  "The office is closed right now, and this business only books, cancels, or reschedules " +
  "appointments during opening hours. Do NOT check availability, suggest times, or collect any " +
  "details. Tell the caller you can't book or change an appointment while the office is closed, " +
  "and offer to take a message so the team can call them back when they reopen.";

function bookingGuidance(config, now, canCheck) {
  const resolvedHours = resolveBusinessHoursForPrompt(config, now);
  let businessHoursStr = "business hours";
  if (resolvedHours) {
    if (resolvedHours.weekly) {
      businessHoursStr = resolvedHours.closedToday
        ? `closed today (${resolvedHours.todayLabel})`
        : resolvedHours.rangeText
        ? `today's hours, ${resolvedHours.rangeText}`
        : "business hours";
    } else if (resolvedHours.rangeText) {
      businessHoursStr = resolvedHours.rangeText;
    }
  }

  // Built-in calendar: check the calendar BEFORE collecting anything, so a full
  // slot never costs the caller the whole flow. (An EHR uses its own get_available_slots.)
  if (canCheck) {
    return (
      `Your task: Help the caller book, checking the calendar before you collect any details. ` +
      `One question at a time:\n` +
      `1. Ask whether they prefer mornings or afternoons, and if any days don't work (business hours: ${businessHoursStr}).\n` +
      `2. As soon as the caller names a specific time, say something like "one moment while I check that" and call check_appointment_availability with that time IN THE SAME response.\n` +
      `3. If it comes back available=false, offer the alternatives it returned and repeat — do NOT collect the caller's details for a time that isn't open.\n` +
      `4. Only once a free time is agreed, collect the caller's details (their name, and anything else you're required to ask for), then read all details back and ask a clear yes/no like "Shall I go ahead and book that?"\n` +
      `5. Do NOT call book_appointment until the caller clearly confirms. The system re-checks availability at booking time; if it reports the slot is full, call check_appointment_availability again and offer another time.`
    );
  }

  return (
    `Your task: Help the caller find a good appointment time and collect their details. ` +
    `Act like a real receptionist — don't just ask "what time works for you?" Instead, one question at a time:\n` +
    `1. Ask whether they prefer mornings or afternoons.\n` +
    `2. Ask if any specific days of the week don't work for them.\n` +
    `3. Based on their preference and business hours (${businessHoursStr}), suggest 2-3 specific times. Example: "We have availability Tuesday at 10 AM or Thursday at 2 PM — do either of those work?"\n` +
    `4. Once they pick a time, confirm name and service. When the caller gives their name, repeat it back naturally in your next sentence ("Thanks, Marcus — ..."). Unless you already did so earlier in this call, confirm its spelling once ("could you spell that for me?"). Then repeat all details back (name, date, time, service) and explicitly ask "Does that sound right?" or "Shall I go ahead and book that?"\n` +
    `5. Do NOT call book_appointment until the caller clearly confirms.\n` +
    `If a time slot is unavailable after a booking attempt, immediately suggest the next nearest alternative rather than asking the caller to come up with a new time.`
  );
}

/**
 * Cancel/reschedule. Forks on which backend owns the appointment book, because
 * the identity proof available differs: an EHR can match on name plus date of
 * birth, whereas the internal DB can only match on the phone number the
 * appointment was booked under.
 *
 * The non-EHR branch's IDENTITY CHECK paragraph exists because the model kept
 * re-verifying callers it had already verified, sending the conversation in
 * circles. Step B replaces it with the generic `identity` requirement kind,
 * enforced in code rather than requested in prose.
 */
function cancelRescheduleGuidance(hasEhr) {
  if (hasEhr) {
    return "Reschedule flow, one question at a time: (1) Ask for their name. (2) Ask for their date of birth. (3) Call get_caller_appointments; if one appointment, say 'I see you have an appointment on [DATE] at [TIME] with [PROVIDER].' (4) Ask when they'd like to move it. (5) Ask whether morning or afternoon works better. (6) Call get_available_slots; offer 2–3 options. (7) Call reschedule_appointment with name, DOB, current date/time, new date/time. (8) Confirm new details and ask if anything else.";
  }
  return (
    `The caller wants to cancel or reschedule an appointment. ` +
    `If you have tools to look up their appointments by phone or name (get_caller_appointments_from_db), use those, then cancel_appointment_db or reschedule_appointment_db. ` +
    `IDENTITY CHECK: if get_caller_appointments_from_db found their appointment using the number they are calling from, they are ALREADY verified — do NOT ask for the last four digits, do NOT ask them to confirm their number, and do NOT re-confirm ownership; just confirm which appointment and proceed with the change. ` +
    `Only when that lookup finds nothing and you are going by a name the caller gave must you also ask for the last 4 digits of the phone number the appointment is booked under, passed as phone_last4. ` +
    `Ask for it naturally — e.g. "Just to confirm it's you, what are the last four digits of the number the appointment is under?" — ask at most once, and never guess or invent those digits. ` +
    `Do not claim the change is done until the tool reports success. ` +
    `If no tools can find the appointment, collect their name, phone, and the appointment date/time they want to change and use record_customer_request so staff can follow up.`
  );
}

/**
 * Prompt-level confirmation gate. Belongs to this pack because it names
 * book_appointment; Step B promotes it to the `confirmBeforeWrite` requirement
 * kind so it is enforced at the tool layer instead of merely requested.
 */
// ---------------------------------------------------------------------------
// Identity
//
// Hand-rolled here for one capability. Step B lifts this into the generic
// `identity` requirement kind so every capability inherits it, and so a clinic
// can add its own proof ("dental number") as configuration rather than code.
// ---------------------------------------------------------------------------

const IDENTITY_MISMATCH_MESSAGE =
  "I can only make changes to appointments booked under your number. Let me take a message instead.";

/**
 * Does the given appointment row belong to the current caller?
 *
 * Two accepted proofs:
 *  1. PHONE — the caller's verified number (last 10 digits, from
 *     ctx.callerPhone: trusted Twilio call metadata, never model-supplied)
 *     matches the appointment's client_phone. Sufficient on its own.
 *  2. NAME + LAST-4 — the client_name on file matches the name the caller
 *     gave AND the caller also states the last 4 digits of the phone number
 *     the appointment is booked under. Both are model-supplied (i.e. relayed
 *     from caller speech), so neither is sufficient alone: a name is public
 *     information, and knowing it must not be enough to cancel a stranger's
 *     appointment. The last-4 is the second factor.
 *
 * @param {{client_phone?: string|null, client_name?: string|null}|null} appointment
 * @param {{callerPhone?: string|null}} ctx
 * @param {string|undefined} argsClientName
 * @param {string|undefined} argsPhoneLast4 - last 4 digits as spoken by the
 *   caller; non-digits are stripped so "0-0-0-0" / "0 0 0 0" work.
 * @returns {boolean}
 */
function appointmentBelongsToCaller(appointment, ctx, argsClientName, argsPhoneLast4) {
  if (!appointment) return false;

  const callerDigits = String(ctx?.callerPhone || "").replace(/\D/g, "");
  const apptDigits = String(appointment.client_phone || "").replace(/\D/g, "");
  const phoneMatches =
    callerDigits.length >= 10 && apptDigits.length >= 10 && callerDigits.slice(-10) === apptDigits.slice(-10);
  if (phoneMatches) return true;

  const nameArg = String(argsClientName || "").trim().toLowerCase();
  const apptName = String(appointment.client_name || "").trim().toLowerCase();
  const nameMatches = nameArg.length > 0 && apptName.length > 0 && nameArg === apptName;
  if (!nameMatches) return false;

  // Second factor. Fails closed when the appointment on file has no usable
  // phone number to check against — there is then nothing the caller could
  // prove, so the name path is simply unavailable for that row.
  const last4Arg = String(argsPhoneLast4 || "").replace(/\D/g, "");
  if (last4Arg.length !== 4 || apptDigits.length < 4) return false;
  return last4Arg === apptDigits.slice(-4);
}

/**
 * Fetch the target appointment and verify it belongs to the caller before
 * cancel/reschedule mutate it. Fails closed: a missing appointmentId, a row
 * that can't be found (wrong business, bad id), or no phone / name+last-4
 * match all return false.
 * @returns {Promise<boolean>}
 */
async function verifyAppointmentIdentity(appointmentId, ctx, argsClientName, argsPhoneLast4) {
  if (!appointmentId || !ctx?.businessId) return false;
  // Identity already proven for this appointment earlier in the call (e.g. a
  // cancel verified it, then the caller asks to reschedule the same one) —
  // don't make the caller prove themselves again.
  if (scratch(ctx).identityVerifiedApptId === appointmentId) return true;
  const appointment = await ctx.deps.getAppointmentById(appointmentId, ctx.businessId);
  return appointmentBelongsToCaller(appointment, ctx, argsClientName, argsPhoneLast4);
}

/**
 * This capability's slice of the per-call scratchpad.
 *
 * Holds what earlier turns (and earlier tools in this turn) established:
 * which appointment is being discussed, whose identity has already been
 * proven, and what was booked — the cross-turn idempotency anchor.
 */
function scratch(ctx) {
  return ctx?.capabilityState?.appointments || {};
}

// ---------------------------------------------------------------------------
// Booking-time validation + timezone anchoring
//
// The model sends scheduled_at as a naive "YYYY-MM-DDTHH:MM[:SS]" string with
// no timezone information at all. Historically that string went straight to the
// database: no future/past check, no business-hours check, and no timezone
// anchoring — a "10:00" booking for an America/Chicago business was stored as
// if it were 10:00 UTC, six hours off from what the caller agreed to.
//
// The business-hours half of this becomes the generic `businessHoursOnly`
// requirement kind in Step B.
// ---------------------------------------------------------------------------

const INVALID_DATETIME_MESSAGE =
  "I didn't catch a valid date and time — could you say the day and time again?";
const PAST_DATETIME_MESSAGE = "That time has already passed — what day and time works for you?";
const CLOSED_DAY_MESSAGE = "We're closed that day — would another time work?";

// Small grace window so a booking for "right now" (model latency, clock
// skew) isn't rejected as already in the past.
const BOOKING_PAST_GRACE_MS = 60_000;

/**
 * Validate and timezone-anchor a `book_appointment` scheduled_at value.
 * @param {unknown} rawScheduledAt
 * @param {{timezone?: string, businessHours?: object|null}} config
 * @param {{log?: {warn: function}}} [deps] - optional; only used to report an
 *   offset that disagrees with the business zone. Kept optional so the
 *   validator stays a pure function tests can call with two arguments.
 * @returns {{ok: true, scheduledAt: string, offsetDisagreesWithZone?: boolean} | {ok: false, message: string}}
 */
function validateBookingTime(rawScheduledAt, config, deps) {
  if (typeof rawScheduledAt !== "string" || !rawScheduledAt.trim()) {
    return { ok: false, message: INVALID_DATETIME_MESSAGE };
  }
  const trimmed = rawScheduledAt.trim();
  const timezone = config?.timezone || DEFAULT_TIMEZONE;
  let offsetDisagreesWithZone = false;

  let targetMs;
  let storedValue;

  if (HAS_OFFSET_RE.test(trimmed)) {
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) return { ok: false, message: INVALID_DATETIME_MESSAGE };

    // Already unambiguous as an INSTANT — validate and store verbatim, no
    // reformatting.
    //
    // DETECTED BUT DELIBERATELY NOT "CORRECTED". There is a second way a wrong
    // hour can reach the database here: the model writes the caller's local
    // wall clock and appends "Z", so "1:05pm at a London clinic" is persisted
    // as 13:05Z — which reads back as 2:05pm during BST.
    //
    // Re-anchoring the wall-clock digits to the business zone would fix that
    // case and BREAK the opposite one, where the model correctly converted
    // (10:00 America/Chicago -> 15:00Z) and re-anchoring would shove the
    // booking five hours. The two are indistinguishable from the value alone,
    // and guessing wrong is worse than the bug: a 5-6 hour shift on a US
    // booking beats a 1 hour shift on a UK one.
    //
    // So: measure, don't guess. The naive path was the proven cause of the
    // reported defect and is now anchored correctly; this branch gets a log
    // line so we learn whether the model ever actually sends an offset that
    // disagrees with the business zone. If the counter stays at zero, the
    // question is closed. If it does not, the fix is to reject the value and
    // make the model re-send a naive one — deterministic, and safe both ways.
    const declared = parseNaiveDateTime(trimmed.replace(HAS_OFFSET_RE, "").replace(/\.\d+$/, ""));
    const anchoredMs = declared ? zonedComponentsToUtcMs(declared, timezone) : NaN;
    if (Number.isFinite(anchoredMs) && anchoredMs !== d.getTime()) {
      offsetDisagreesWithZone = true;
      // log exposes debug/info/error only; a warning is log.error carrying
      // severity:"warn" (the convention used throughout lib/ and services/).
      deps?.log?.error?.("booking_offset_disagrees_with_business_zone", {
        supplied: trimmed,
        timezone,
        wouldShiftByMinutes: Math.round((anchoredMs - d.getTime()) / 60_000),
        severity: "warn",
      });
    }

    targetMs = d.getTime();
    storedValue = trimmed;
  } else {
    const parsed = parseNaiveDateTime(trimmed);
    if (!parsed) return { ok: false, message: INVALID_DATETIME_MESSAGE };
    targetMs = zonedComponentsToUtcMs(parsed, timezone);
    if (!Number.isFinite(targetMs)) return { ok: false, message: INVALID_DATETIME_MESSAGE };
    storedValue = new Date(targetMs).toISOString();
  }

  if (targetMs < Date.now() - BOOKING_PAST_GRACE_MS) {
    return { ok: false, message: PAST_DATETIME_MESSAGE };
  }

  // Business-hours check — read the resolved instant's wall-clock weekday and
  // time-of-day in the business's timezone, and reuse resolveDayHours'
  // weekly/legacy/null shape handling rather than reinventing it.
  const { shortWeekday, minutesOfDay } = zonedWeekdayAndMinutes(targetMs, timezone);

  const day = resolveDayHours(config?.businessHours ?? null, shortWeekday);
  if (day.closed) {
    return { ok: false, message: CLOSED_DAY_MESSAGE };
  }
  if (day.open && day.close) {
    const [openH, openM] = day.open.split(":").map(Number);
    const [closeH, closeM] = day.close.split(":").map(Number);
    const openMinutes = openH * 60 + openM;
    const closeMinutes = closeH * 60 + closeM;
    if (minutesOfDay < openMinutes || minutesOfDay >= closeMinutes) {
      const openLabel = formatClockTime(day.open) || day.open;
      const closeLabel = formatClockTime(day.close) || day.close;
      return {
        ok: false,
        message: `We're not open then — our hours that day are ${openLabel} to ${closeLabel}. Would another time work?`,
      };
    }
  }

  return { ok: true, scheduledAt: storedValue, offsetDisagreesWithZone };
}

// The read-back-and-confirm requirement itself now lives in NON-NEGOTIABLE RULE
// 3 (services/gemini.js), so this pack bullet keeps only its non-duplicated
// tail: the spelling-confirmation detail specific to booking. Task 16 made it
// UNCONDITIONAL and once-per-call — the old "only if the name is unusual"
// wording let a confidently-misheard common name ("Scripps" for "Smith") be
// written into a booking without ever being checked. Spelling is now confirmed
// exactly once before the first name-bearing booking read-back, and the caller
// is never asked to spell again for the rest of the call.
const BOOKING_CONFIRMATION_GUARDRAIL =
  `- Before the first read-back of a booking that includes the caller's name, confirm the spelling of their name once: ask them to spell it — e.g. "Just to make sure I have it right, could you spell your last name?" — and read the letters back to confirm you have it right. Ask this at most once. If the caller spells it, use that spelling; if they decline, ignore the request, or just answer with something else, proceed with the name exactly as you heard it — never ask them to spell it a second time. Once you have moved past this step, treat the name as settled and do not raise spelling again for the rest of the call.\n`;

/**
 * Availability check — a READ (like get_available_slots), registered only when a
 * business turns on the built-in calendar's availability check. The model calls
 * it the moment a time is named, before collecting details, so a full slot never
 * costs the caller a whole booking flow.
 */
const CHECK_AVAILABILITY_DECLARATION = {
  name: "check_appointment_availability",
  description:
    "Check whether a specific date and time is open BEFORE collecting the caller's details. " +
    "Call this as soon as the caller names a time. If available is false, offer the returned " +
    "alternatives instead of collecting details.",
  parameters: {
    type: "object",
    properties: {
      requested_at: {
        type: "string",
        description: "The date and time the caller asked for, as ISO 8601 (e.g. 2026-03-15T10:00:00)",
      },
    },
    required: ["requested_at"],
  },
};

/** @type {import("./_contract.js").CapabilityPack} */
export default {
  id: "appointments",
  label: "Appointments",
  description: "Book, check, cancel and reschedule appointments.",
  core: false,
  adapterKind: "scheduling",

  /**
   * What an operator may configure. Also what a dashboard renders to draw this
   * capability's settings card, so a new capability's screen appears without
   * anyone hand-writing a component.
   */
  configSchema: {
    adapter: {
      type: "choice",
      label: "Where do appointments live?",
      // All three stay VALID in the engine's config loader — a clinic
      // configured to athenahealth directly must keep working. Which of them
      // the dashboard offers as a self-serve choice is decided separately, by
      // each adapter's `selfServe` flag (adapters/scheduling/*), not by pruning
      // this list. athenahealth (owner-managed) and webhook (a non-functional
      // stub whose book() is null) are marked selfServe:false, so the picker
      // shows only the built-in calendar. Google Calendar is reached via the
      // built-in calendar plus Calendar sync.
      options: ["internal", "athenahealth", "webhook"],
      default: "internal",
    },
    require: {
      identity: {
        type: "identityFields",
        label: "What must the caller provide before we look up or change an appointment?",
        builtinOptions: ["name", "dob", "phone_on_file"],
        allowCustom: true,
      },
      confirmBeforeWrite: {
        type: "toggle",
        label: "Read details back and require a clear yes before booking",
        default: false,
      },
      businessHoursOnly: {
        type: "toggle",
        label: "Only allow booking changes during opening hours",
        default: false,
      },
    },
    // The built-in calendar ALWAYS checks availability before booking — a
    // receptionist does not double-book. These two numbers define what "free"
    // means; an external backend (athena) owns its own free/busy and ignores
    // them. Defaults: 30-minute slots, one appointment at a time.
    availability: {
      length: {
        type: "number",
        label: "Appointment length (minutes)",
        default: 30,
        min: 5,
        max: 480,
        step: 5,
      },
      capacity: {
        type: "number",
        label: "How many appointments can share one time slot",
        default: 1,
        min: 1,
        max: 100,
        step: 1,
      },
    },
    notes: {
      type: "longtext",
      label: "Anything specific about how you book?",
      placeholder: "e.g. Ask if they're a new or existing patient first",
    },
  },

  /** Every tool this pack can own, for registry dispatch. */
  toolNames: [
    BOOK_APPOINTMENT_DECLARATION.name,
    CHECK_AVAILABILITY_DECLARATION.name,
    ...EHR_APPOINTMENT_DECLARATIONS.map((d) => d.name),
    ...DB_APPOINTMENT_DECLARATIONS.map((d) => d.name),
  ],

  /**
   * Tools whose success is caller-visible, unlocking same-turn end_call.
   * Previously the hardcoded ACTION_TOOL_NAMES array in services/gemini.js:14.
   */
  actionTools: [
    "book_appointment",
    "cancel_appointment_db",
    "reschedule_appointment_db",
    // EHR write tools — listed here so executeToolCall runs checkRequirements
    // (identity / confirmBeforeWrite / businessHoursOnly) on athena clinics too.
    "book_appointment_in_ehr",
    "cancel_appointment",
    "reschedule_appointment",
  ],

  tools(config) {
    const allowed = config?.allowedTasks || [];
    if (!allowed.includes("book_appointment")) return [];
    // Configured requirements become real tool parameters, which is what turns
    // a config entry into something the model is actually asked for.
    return [withRequirements(BOOK_APPOINTMENT_DECLARATION, capabilityConfig(config, "appointments"))];
  },

  adapterTools(config, ctx = {}) {
    const integrations = Array.isArray(ctx.integrations) ? ctx.integrations : [];
    const allowed = config?.allowedTasks || [];

    if (hasExternalBook(config, integrations)) return []; // an EHR owns the book

    const cfg = capabilityConfig(config, "appointments");
    const out = [];

    // Availability check whenever the backend can do one (the built-in calendar
    // always can; an EHR is handled above). No per-business flag — a
    // receptionist always checks before booking.
    if (allowed.includes("book_appointment")) {
      const adapter = schedulingAdapter(config, integrations);
      if (typeof adapter.checkAvailability === "function") out.push(CHECK_AVAILABILITY_DECLARATION);
    }

    // "appointments" is a legacy bundle name — normalizeAllowedTasks always
    // expands it to the three appointment MODULE_TASKS before config reaches
    // here, so gating is purely module-name-based.
    const wantsLookupOrChange =
      allowed.includes("cancel_reschedule") || allowed.includes("check_appointment");
    if (wantsLookupOrChange) {
      // Only the two CHANGE tools take requirements; the lookup is a read and
      // gating it would stop the receptionist finding the appointment it needs
      // in order to ask about it.
      out.push(
        ...DB_APPOINTMENT_DECLARATIONS.map((d) =>
          d.name === "get_caller_appointments_from_db" ? d : withRequirements(d, cfg)
        )
      );
    }
    return out;
  },

  /**
   * EHR tool declarations, surfaced separately because services/gemini.js's
   * `buildIntegrationTools` has a directly-tested public contract that emits
   * them (tests/gemini-integrations.test.js). Step B dissolves this once
   * adapters own backend selection.
   * @param {Array} integrations
   */
  ehrTools(integrations, config = null) {
    // Adapter selection decides WHICH backend; the capability's enabled state
    // decides WHETHER the tools exist at all. Without the config gate, disabling
    // appointments left the EHR booking tools registered (they keyed only off the
    // integration list), so an athena clinic's "off" toggle did nothing on calls.
    const adapter = resolveSchedulingAdapter(null, integrations);
    if (adapter.id !== "athenahealth") return [];
    // config is optional so older/tested callers that pass only integrations keep
    // today's behavior; the live path always passes it, which is what closes the
    // bypass.
    if (config) {
      const allowed = config.allowedTasks || [];
      if (!allowed.some((t) => APPOINTMENT_MODULE_TASKS.includes(t))) return [];
    }
    // Wrap the WRITE tools with the configured requirements so identity /
    // confirmBeforeWrite become real parameters (builtin name/dob reuse the
    // existing caller_name/caller_dob — no duplication). The read tools
    // (get_caller_appointments, get_available_slots) are left untouched. When no
    // requirements are configured, withRequirements returns the same object, so
    // an unconfigured clinic is byte-identical.
    const cfg = config ? capabilityConfig(config, "appointments") : {};
    return EHR_APPOINTMENT_DECLARATIONS.map((d) =>
      EHR_WRITE_TOOLS.has(d.name) ? withRequirements(d, cfg) : d
    );
  },

  prompt(config, ctx = {}) {
    const allowed = config?.allowedTasks || [];
    const hasEhr = hasExternalBook(config, ctx.integrations);
    const now = ctx.now instanceof Date ? ctx.now : new Date();
    // The built-in calendar can check availability; an EHR uses its own slots.
    // Also require that this business actually books, so a non-appointment
    // business's (dead) booking guidance stays unchanged.
    const canCheckAvail =
      allowed.includes("book_appointment") &&
      typeof schedulingAdapter(config, ctx.integrations).checkAvailability === "function";

    // businessHoursOnly is enforced at the tool (checkRequirements), but that
    // only refuses at the END — the model would still run the whole booking flow
    // while closed. When it's on AND the office is closed right now, steer the
    // model to decline up front so it never collects details or checks slots.
    const bhBlocked =
      capabilityConfig(config, "appointments").require?.businessHoursOnly === true &&
      isClosedNow(config, now.getTime());

    // Enabled = the business opted into any appointment module. capabilityClauses
    // already gates the CAPABILITIES line on this; the guardrails now gate on it
    // too, instead of leaking booking instructions into a business that cannot
    // book. When OFF, the model is told to decline booking cleanly rather than
    // advertise a tool it was never given.
    const enabled = allowed.some((t) => APPOINTMENT_MODULE_TASKS.includes(t));

    return {
      static: {
        // The CAPABILITIES line IS module-gated — it always was.
        capabilities: capabilityClauses(allowed),

        guardrails: enabled
          ? [
              BOOKING_CONFIRMATION_GUARDRAIL,
              ...requirementPromptLines(capabilityConfig(config, "appointments")).map((l) => `${l}
`),
            ]
          : [declineGuardrail("book, check, cancel, or reschedule appointments")],
        capabilityNotes: enabled
          ? notesPromptLines(capabilityConfig(config, "appointments"))
          : [],
      },
      dynamic: {
        // Also ungated, matching buildStepGuidance's original behavior: it
        // switched purely on the intent the model reported, never on whether
        // the business had the module enabled.
        stepGuidance: {
          book_appointment: bhBlocked ? CLOSED_BOOKING_DECLINE : bookingGuidance(config, now, canCheckAvail),
          cancel_reschedule: bhBlocked ? CLOSED_BOOKING_DECLINE : cancelRescheduleGuidance(hasEhr),
        },
      },
    };
  },

  /**
   * @param {{id?: string, name: string, args?: object}} fc
   * @param {object} ctx - turn context; ctx.deps carries the injected data
   *   surface (see services/tools.js). Packs take no service imports of their
   *   own: services/supabase.js imports the registry for its reserved-name
   *   list, so a pack importing it back would be a load-order-dependent cycle.
   *   Injection also means these paths can be tested without module mocks.
   */
  async execute(fc, ctx = {}) {
    switch (fc.name) {
      case "book_appointment":
        return bookAppointment(fc, ctx);
      case "check_appointment_availability":
        return checkAvailabilityTool(fc, ctx);
      case "get_caller_appointments_from_db":
        return lookupCallerAppointments(fc, ctx);
      case "cancel_appointment_db":
        return cancelAppointment(fc, ctx);
      case "reschedule_appointment_db":
        return rescheduleAppointment(fc, ctx);
      default:
        // The EHR tools. They are declared by this pack but executed by the
        // integration layer, which owns the athenahealth client.
        return executeViaEhr(fc, ctx);
    }
  },

  /**
   * Apply what a completed appointment action means for the call.
   *
   * Runs from applyReply on a normal turn, or from the barge-in salvage path
   * when the caller talks over the confirmation — exactly once either way, and
   * that matters here more than anywhere else in the system: firing twice means
   * the owner gets two booking alerts and the caller gets two confirmation
   * texts for one appointment.
   */
  onEffect(effect, engine) {
    if (effect.type === "changed") {
      // A completed cancel or reschedule. Leaving the step at gather_details
      // would re-inject the cancel-flow identity guidance every turn, which is
      // what previously sent the model in circles re-verifying a caller it had
      // already verified.
      engine.setStep(engine.STEPS.CONFIRM, effect.data?.tool || "appointment_changed");
      engine.addHistoryNote(`${effect.data?.tool} succeeded`);
      return;
    }

    if (effect.type !== "booked") return;

    const data = effect.data || {};
    const { callSid, businessId, callerNumber, twilioNumber, config } = engine.call;
    if (!businessId) return;

    engine.setStep(engine.STEPS.CONFIRM, "book_appointment");

    // The model does not see tool results on later turns, only text — without
    // this note it can re-book or deny a booking it just made.
    const who = data.client_name ? ` for client ${data.client_name}` : "";
    // Local wall-clock time, not the stored UTC ISO: the model reads history
    // notes as context and could otherwise speak the raw UTC instant back to the
    // caller (a 10:00 AM Chicago booking recited as "3 PM").
    const whenLocal = bookedFactValue(data.scheduled_at, null, config?.timezone);
    engine.addHistoryNote(
      `book_appointment succeeded${who} at ${whenLocal}. Do not book it again`
    );

    const { notifications, log } = engine.deps;
    const notes = [data.service_type, data.notes].filter(Boolean).join(" — ") || null;

    notifications
      .notifyAppointmentBooked({
        businessId,
        appointment: {
          scheduled_at: data.scheduled_at,
          client_name: data.client_name || null,
          client_phone: callerNumber || null,
          notes,
        },
        call: { callerNumber, twilioNumber },
      })
      .catch((err) => log.error("notify_appointment_failed", { callSid, reason: err?.message }));

    notifications
      .sendCallerSms(config, callerNumber, "appointment_confirmation", {
        name: data.client_name || "there",
        business: config?.businessName,
        // Business timezone, not the server's — `toLocaleString()` with no zone
        // rendered the confirmation SMS in whatever timezone the process ran in.
        datetime: data.scheduled_at
          ? speakableDateTime(data.scheduled_at, config?.timezone, resolveProfile(config))
          : "your requested time",
      })
      .catch((err) =>
        log.error("sms_followup_failed", {
          callSid,
          kind: "appointment_confirmation",
          reason: err?.message,
        })
      );
  },
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Human-readable "Booked this call" fact value: the appointment's local
 * wall-clock time in the business timezone, with the service appended when the
 * caller named one — e.g. "Tue, Jul 21, 10:00 AM (consultation)". This is a
 * caller FACT the model reads verbatim in the dynamic tail, so it must be plain
 * English, not the stored UTC ISO string.
 * @param {string} scheduledAtISO - the anchored UTC ISO instant that was booked
 * @param {unknown} serviceType
 * @param {string|undefined} timezone
 * @returns {string}
 */
// formatLocalDateTime / speakableDateTime used to be defined here. They now
// live in lib/capabilities/datetime.js so services/gemini.js's CALLER CONTEXT
// block can share the SAME implementation and the same timezone fallback —
// that block previously hand-rolled its own toLocaleString with no fallback at
// all, so one unset business timezone made the two paths disagree about what
// time an appointment was. Re-exported below for the tests that exercise the
// fallback behavior directly.
export { formatLocalDateTime, speakableDateTime };

export function bookedFactValue(scheduledAtISO, serviceType, timezone) {
  const when = formatLocalDateTime(scheduledAtISO, timezone, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const svc = typeof serviceType === "string" && serviceType.trim() ? ` (${serviceType.trim()})` : "";
  return `${when}${svc}`;
}

/** Reserved callerFacts label for the "a booking exists this call" fact. */
const BOOKED_FACT_LABEL = "Booked this call";

/**
 * The current callerFacts map with the booked-appointment fact removed (when
 * `bookedValue` is null/undefined, e.g. a successful cancel) or replaced with
 * a new value (e.g. a successful reschedule), other facts (Name, etc.) intact.
 *
 * Per-capability merge (lib/capabilities/effects.js mergeCapabilityState) is
 * shallow AT THE CAPABILITY LEVEL: writing `callerFacts` in a patch replaces
 * the whole map rather than deep-merging into it. So the only way to drop or
 * update just the booked-fact key while keeping siblings is to read the
 * CURRENT map off ctx and write back a full replacement — a partial patch
 * like `{ callerFacts: { [BOOKED_FACT_LABEL]: null } }` would not remove
 * anything; it would just merge a null-valued key into the existing object on
 * the next read (collectCallerFacts already skips non-string values, but the
 * stale string would still be there until overwritten).
 *
 * @param {object} ctx
 * @param {string|null|undefined} bookedValue
 * @returns {Record<string,string>}
 */
function nextCallerFacts(ctx, bookedValue) {
  const current = scratch(ctx).callerFacts || {};
  const { [BOOKED_FACT_LABEL]: _drop, ...rest } = current;
  return bookedValue ? { ...rest, [BOOKED_FACT_LABEL]: bookedValue } : rest;
}

/** The `n` free slots nearest a requested instant, as ISO strings. */
function nearestSlots(free, requestedISO, n) {
  const target = Date.parse(requestedISO);
  return (free || [])
    .map((s) => s.start)
    .filter((s) => Number.isFinite(Date.parse(s)))
    .sort((a, b) => Math.abs(Date.parse(a) - target) - Math.abs(Date.parse(b) - target))
    .slice(0, n);
}

/**
 * check_appointment_availability — a READ the model calls before collecting
 * details. Reuses validateBookingTime so a past/closed/out-of-hours request is
 * rejected with the same wording as booking, then asks the adapter whether the
 * slot is open and, if not, offers the nearest free times that day.
 */
async function checkAvailabilityTool(fc, ctx) {
  if (!ctx?.businessId) return noBusinessResult(fc);
  const config = ctx.config || {};
  const avail = availabilitySettings(capabilityConfig(config, "appointments"));
  const adapter = schedulingAdapter(config, ctx.integrations);

  const respond = (response) => ({
    functionResponse: { id: fc.id, name: fc.name, response },
    stateEffects: {
      toolResult: { name: fc.name, success: true, message: response.message },
      toolCallEvent: { name: fc.name, args: fc.args || {} },
    },
  });

  const validated = validateBookingTime(fc.args?.requested_at, config, ctx.deps);
  if (!validated.ok) {
    return respond({ success: true, available: false, message: validated.message });
  }
  const startISO = validated.scheduledAt;

  let available = true;
  if (typeof adapter.checkAvailability === "function") {
    try {
      const res = await adapter.checkAvailability(ctx, {
        startISO,
        lengthMinutes: avail.length,
        capacity: avail.capacity,
      });
      available = !!res.available;
    } catch (err) {
      ctx.deps.captureException(err); // fail-open
    }
  }

  if (available) {
    return respond({ success: true, available: true, message: "That time is available." });
  }

  let alternatives = [];
  if (typeof adapter.findSlots === "function") {
    try {
      const free = await adapter.findSlots(ctx, {
        dateISO: startISO,
        lengthMinutes: avail.length,
        capacity: avail.capacity,
        businessHours: config.businessHours ?? null,
        timezone: config.timezone,
      });
      alternatives = nearestSlots(free, startISO, 3);
    } catch (err) {
      ctx.deps.captureException(err);
    }
  }

  // `alternatives` used to stay raw UTC ISO, called "machine-readable". But the
  // model picks one of these and passes it back as book_appointment's
  // scheduled_at, where the declaration asks for a naive LOCAL wall clock — so
  // the one field could arrive in either frame with no way to tell them apart.
  // Emitting naive local makes the round-trip single-valued.
  const spokenAlternatives = alternatives.map((a) => speakableDateTime(a, config.timezone, resolveProfile(config)));
  const localAlternatives = alternatives
    .map((a) => toLocalNaiveDateTime(a, config.timezone))
    .filter(Boolean);

  return respond({
    success: true,
    available: false,
    alternatives: localAlternatives,
    message: alternatives.length
      ? `That time is taken. Offer these open times instead: ${spokenAlternatives.join(", ")}.`
      : "That time is taken and nothing else is open that day. Ask the caller about another day.",
  });
}

async function bookAppointment(fc, ctx) {
  if (!ctx?.businessId) return noBusinessResult(fc);

  const args = fc.args ?? {};
  const config = ctx.config || {};
  const avail = availabilitySettings(capabilityConfig(config, "appointments"));
  let bookSuccess = false;
  let bookMessage =
    "I'm sorry, I wasn't able to book that appointment. Let me take your details so someone can follow up.";
  let anchoredScheduledAt = null;
  let alreadyBooked = false;

  if (args.scheduled_at) {
    const validated = validateBookingTime(args.scheduled_at, config, ctx.deps);
    if (!validated.ok) {
      bookMessage = validated.message;
    } else {
      anchoredScheduledAt = validated.scheduledAt;
      // Idempotency guard: the model sometimes re-issues book_appointment for a
      // slot this very call already booked (a second FC round, or a later
      // turn). Re-inserting would hit the unique index and turn a successful
      // booking into a spurious "slot taken" error — so treat it as the success
      // it already is, without a second insert or a second confirmation SMS.
      //
      // Instant comparison, not string equality: the anchor may be a verbatim
      // offset-bearing ISO while this round's value is a normalized UTC string
      // (or vice versa) for the same moment.
      const lastBookedMs = Date.parse(scratch(ctx).lastBooked?.scheduled_at ?? "");
      if (Number.isFinite(lastBookedMs) && lastBookedMs === Date.parse(anchoredScheduledAt)) {
        alreadyBooked = true;
        bookSuccess = true;
        bookMessage =
          "That appointment is already booked from earlier in this call. Do not book it again — just confirm it to the caller.";
      } else {
        const notes = [args.service_type, args.notes].filter(Boolean).join(" — ") || null;
        const adapter = schedulingAdapter(ctx.config, ctx.integrations);
        const canCheck = typeof adapter.checkAvailability === "function";

        // Pre-check on any backend that can: refuse a full slot before the write
        // so the model gets "offer another time", not a raw error. Fail-open on a
        // check error — the atomic book() below is the real guard.
        let slotFull = false;
        if (canCheck) {
          try {
            const { available } = await adapter.checkAvailability(ctx, {
              startISO: anchoredScheduledAt,
              lengthMinutes: avail.length,
              capacity: avail.capacity,
            });
            slotFull = !available;
          } catch (err) {
            ctx.deps.captureException(err);
          }
        }

        const fullMessage = canCheck
          ? "That time is fully booked. Offer the caller a different time — call " +
            "check_appointment_availability to find open slots."
          : "That time slot is no longer available. Please ask the caller to pick a different time.";

        if (slotFull) {
          bookMessage = fullMessage;
        } else {
          try {
            const { id: dbId, full } = await adapter.book(ctx, {
              clientName: args.client_name || null,
              clientPhone: ctx.callerPhone || null,
              scheduledAt: anchoredScheduledAt,
              notes,
              lengthMinutes: avail.length,
              capacity: avail.capacity,
            });
            if (full) {
              bookMessage = fullMessage;
            } else if (dbId) {
              bookSuccess = true;
              bookMessage = "Appointment booked successfully.";
            }
          } catch (err) {
            const isSlotTaken = err?.message?.includes("unique") || err?.code === "23505";
            bookMessage = isSlotTaken
              ? "That time slot is no longer available. Please ask the caller to pick a different time."
              : "There was an error booking the appointment. Please take the caller's details for follow-up.";
            ctx.deps.captureException(err);
          }
        }
      }
    }
  }

  // Only a FRESH booking carries downstream effects (step transition, owner
  // notification, confirmation SMS, history note). The already-booked
  // short-circuit must not re-fire any of them — that is the entire point of
  // the anchor.
  const booked =
    bookSuccess && !alreadyBooked ? { ...args, scheduled_at: anchoredScheduledAt } : null;

  // Caller facts for the dynamic tail (plan step 2.2): the model re-reads these
  // every turn, so it confirms this booking from memory instead of re-asking or
  // re-booking. Name is omitted when the caller gave none rather than shown as
  // "null". Merged (not clobbering lastBooked) by the per-capability shallow
  // merge in lib/capabilities/effects.js.
  const callerFacts = booked
    ? {
        ...(booked.client_name ? { Name: booked.client_name } : {}),
        [BOOKED_FACT_LABEL]: bookedFactValue(booked.scheduled_at, booked.service_type, config.timezone),
      }
    : null;

  return {
    functionResponse: {
      id: fc.id,
      name: fc.name,
      response: { success: bookSuccess, message: bookMessage },
    },
    stateEffects: {
      toolResult: { name: fc.name, success: bookSuccess, message: bookMessage },
      toolCallEvent: { name: fc.name, args },
      ...(booked
        ? {
            capabilityEffects: [{ capability: "appointments", type: "booked", data: booked }],
            // Cross-turn anchor, written immediately so it survives a barge-in:
            // the insert already happened, and a re-book on a later turn must
            // short-circuit rather than hit the unique index.
            capabilityState: {
              appointments: {
                lastBooked: {
                  scheduled_at: booked.scheduled_at,
                  client_name: booked.client_name || null,
                },
                callerFacts,
              },
            },
          }
        : {}),
    },
  };
}

async function lookupCallerAppointments(fc, ctx) {
  // Uses ONLY the verified caller phone from call metadata (ctx.callerPhone),
  // never a model-supplied number, so a caller cannot fish for someone else's
  // appointments by asking about a different number.
  if (!ctx?.businessId) return noBusinessResult(fc);

  const callerPhone = ctx.callerPhone || null;
  let appointments = [];
  let selectedAppointmentId;

  if (callerPhone) {
    appointments = await schedulingAdapter(ctx.config, ctx.integrations).lookupByCaller(ctx);
    if (appointments.length === 1) selectedAppointmentId = appointments[0].id;
  }

  // Project to a model-safe view before handing anything back.
  //
  // This array used to be the raw Supabase rows, justified as "machine-readable
  // UTC". Two problems with that. First, the model SPEAKS these times, and a
  // stored UTC ISO read aloud turns a 2:00 PM America/Chicago appointment into
  // "7 PM". Second — and worse — it gave the model a UTC-shaped datetime it
  // could echo straight back into a booking argument, while every tool
  // DECLARATION asks for a naive LOCAL one. That is two spellings of a time in
  // one field, and it is precisely the ambiguity that lets an hour go missing.
  //
  // scheduled_at is now the naive wall clock in the business zone: the same
  // frame the model is asked to produce, so a round-trip cannot drift.
  //
  // client_phone is dropped outright. Identity is verified server-side from
  // call metadata (see verifyAppointmentIdentity); the model never needs the
  // stored number, and not sending it keeps another caller's digits out of the
  // prompt entirely.
  const tz = ctx.config?.timezone;
  const modelSafeAppointments = appointments.map((a) => ({
    id: a.id,
    ...(a.client_name ? { client_name: a.client_name } : {}),
    ...(a.scheduled_at ? { scheduled_at: toLocalNaiveDateTime(a.scheduled_at, tz) } : {}),
    ...(a.status ? { status: a.status } : {}),
  }));

  // Phrased as a note to the model, in the same "[...]" shape as the system
  // notes the prompt already teaches it never to read aloud. The old wording
  // opened with a bare imperative — "Read these back in local time: Monday,
  // August 10 at 1:05 PM" — which on a turn where the model emitted no text
  // was spoken to the caller verbatim, instruction and all.
  const spokenListing = appointments.length
    ? "[not caller speech — these times are already in the business's local timezone; say them as-is] " +
      appointments
        .map((a) => {
          const who = a.client_name ? `${a.client_name}, ` : "";
          const when = a.scheduled_at
            ? speakableDateTime(a.scheduled_at, ctx.config?.timezone, resolveProfile(ctx.config))
            : "an unspecified time";
          return `${who}${when}`;
        })
        .join("; ") +
      "."
    : "No upcoming appointments found for this caller.";

  return {
    functionResponse: {
      id: fc.id,
      name: fc.name,
      response: { success: true, appointments: modelSafeAppointments, message: spokenListing },
    },
    stateEffects: {
      ...(selectedAppointmentId !== undefined
        ? { capabilityState: { appointments: { selectedAppointmentId } } }
        : {}),
      toolResult: {
        name: fc.name,
        success: true,
        message: `Found ${appointments.length} appointments.`,
      },
      toolCallEvent: { name: fc.name, args: fc.args },
    },
  };
}

/** Shared refusal for a change tool that cannot prove who is calling. */
function identityMismatchResult(fc) {
  return {
    functionResponse: {
      id: fc.id,
      name: fc.name,
      response: { success: false, message: IDENTITY_MISMATCH_MESSAGE },
    },
    stateEffects: {
      toolResult: { name: fc.name, success: false, message: IDENTITY_MISMATCH_MESSAGE, callerSafe: true },
      toolCallEvent: { name: fc.name, args: fc.args },
    },
  };
}

async function cancelAppointment(fc, ctx) {
  if (!ctx?.businessId) return noBusinessResult(fc);

  const appointmentId = fc.args?.appointment_id || scratch(ctx).selectedAppointmentId;
  if (!appointmentId) {
    return {
      functionResponse: {
        id: fc.id,
        name: fc.name,
        response: { success: false, message: "Which appointment?" },
      },
      stateEffects: {
        toolResult: {
          name: fc.name,
          success: false,
          message: "I need to look up your appointment first.",
        },
        toolCallEvent: null,
      },
    };
  }

  const identityOk = await verifyAppointmentIdentity(
    appointmentId,
    ctx,
    fc.args?.client_name,
    fc.args?.phone_last4
  );
  if (!identityOk) return identityMismatchResult(fc);

  const { ok } = await schedulingAdapter(ctx.config, ctx.integrations).cancel(ctx, {
    appointmentId,
  });

  return {
    functionResponse: {
      id: fc.id,
      name: fc.name,
      response: ok
        ? { success: true, message: "That appointment has been cancelled." }
        : { success: false, message: "I couldn't cancel that appointment." },
    },
    stateEffects: {
      toolResult: {
        name: fc.name,
        success: ok,
        message: ok ? "Cancelled." : "Couldn't cancel.",
        appointmentId,
      },
      toolCallEvent: { name: fc.name, args: fc.args },
      capabilityState: {
        appointments: {
          // Identity passed above regardless of the write outcome — remember it
          // so a retry (or a follow-up reschedule) doesn't re-challenge.
          identityVerifiedApptId: appointmentId,
          // A cancelled appointment is no longer the one under discussion, and
          // the booking anchor must die with it: "cancel that, actually put me
          // back in at the same time" has to perform a real insert. The
          // "Booked this call" caller fact must die with it too, or the tail
          // keeps telling the model a cancelled booking still stands — other
          // facts (e.g. Name) survive via nextCallerFacts.
          ...(ok
            ? {
                selectedAppointmentId: null,
                lastBooked: null,
                callerFacts: nextCallerFacts(ctx, null),
              }
            : {}),
        },
      },
      ...(ok
        ? {
            capabilityEffects: [
              { capability: "appointments", type: "changed", data: { tool: fc.name } },
            ],
          }
        : {}),
    },
  };
}

async function rescheduleAppointment(fc, ctx) {
  if (!ctx?.businessId) return noBusinessResult(fc);

  const appointmentId = fc.args?.appointment_id || scratch(ctx).selectedAppointmentId;
  const newScheduledAt = fc.args?.new_scheduled_at;

  if (!appointmentId || !newScheduledAt) {
    return {
      functionResponse: {
        id: fc.id,
        name: fc.name,
        response: {
          success: false,
          message: !appointmentId ? "Which appointment?" : "New date/time required.",
        },
      },
      stateEffects: {
        toolResult: { name: fc.name, success: false, message: "Missing info." },
        toolCallEvent: null,
      },
    };
  }

  const identityOk = await verifyAppointmentIdentity(
    appointmentId,
    ctx,
    fc.args?.client_name,
    fc.args?.phone_last4
  );
  if (!identityOk) return identityMismatchResult(fc);

  // Anchor the model's datetime to the business timezone before it reaches the
  // database. THIS IS THE FIX FOR THE +1h READ-BACK BUG.
  //
  // The tool declaration asks the model for a naive wall-clock string
  // ("2026-04-15T10:00:00"), and appointments.scheduled_at is timestamptz, so
  // handing that string straight to PostgREST let the DB coerce it in ITS
  // session zone (UTC on Supabase). A caller rescheduling to 1:05pm UK was
  // stored as 13:05Z — which is 2:05pm in Europe/London during BST, and is
  // exactly what the assistant then read back.
  //
  // book_appointment always went through this gate; reschedule was the one
  // mutation that skipped it. Routing it here also restores the past-date and
  // business-hours checks, which it had likewise been bypassing — a reschedule
  // could previously move an appointment into the past or to 3am.
  const validated = validateBookingTime(newScheduledAt, ctx.config, ctx.deps);
  if (!validated.ok) {
    return {
      functionResponse: {
        id: fc.id,
        name: fc.name,
        response: { success: false, message: validated.message },
      },
      stateEffects: {
        toolResult: { name: fc.name, success: false, message: validated.message, callerSafe: true },
        toolCallEvent: { name: fc.name, args: fc.args },
        // Same shape as the adapter-failure path below. Identity WAS proven —
        // only the time was rejected — so the verification stands and the
        // caller is not made to prove who they are again just to pick another
        // slot. Omitting capabilityState here would also change the result
        // shape between two failure modes of the same tool.
        capabilityState: { appointments: { identityVerifiedApptId: appointmentId } },
      },
    };
  }
  const anchoredScheduledAt = validated.scheduledAt;

  // Booking has wrapped its own write since it was written; reschedule never
  // did, so a throw here propagated out of the whole turn instead of becoming
  // a failed tool result the model could talk about. Same asymmetry as the
  // availability check and the identity read — this is the one that costs the
  // caller an outcome.
  let ok = false;
  try {
    ({ ok } = await schedulingAdapter(ctx.config, ctx.integrations).reschedule(ctx, {
      appointmentId,
      newScheduledAt: anchoredScheduledAt,
    }));
  } catch (err) {
    log.error("reschedule_failed", { reason: err?.message, severity: "warn" });
    ok = false;
  }

  return {
    functionResponse: {
      id: fc.id,
      name: fc.name,
      response: ok
        ? { success: true, message: "Rescheduled." }
        : { success: false, message: "Couldn't reschedule." },
    },
    stateEffects: {
      toolResult: {
        name: fc.name,
        success: ok,
        message: ok ? "Rescheduled." : "Couldn't reschedule.",
        appointmentId,
      },
      toolCallEvent: { name: fc.name, args: fc.args },
      capabilityState: {
        appointments: {
          identityVerifiedApptId: appointmentId,
          // A successful reschedule moved the appointment to a new time — the
          // "Booked this call" fact must reflect that new time, or the tail
          // keeps asserting the OLD one every turn. Other facts (e.g. Name)
          // survive via nextCallerFacts.
          // The ANCHORED value, not the model's raw string. bookedFactValue
          // runs Date.parse(), which resolves a naive string in the SERVER's
          // local zone — so the caller-facts line was previously rendered
          // against whatever zone the box happened to run in.
          ...(ok
            ? {
                callerFacts: nextCallerFacts(
                  ctx,
                  bookedFactValue(anchoredScheduledAt, fc.args?.service_type, (ctx.config || {}).timezone)
                ),
              }
            : {}),
        },
      },
      ...(ok
        ? {
            capabilityEffects: [
              { capability: "appointments", type: "changed", data: { tool: fc.name } },
            ],
          }
        : {}),
    },
  };
}

/**
 * Route an EHR-shaped tool to the integration that backs it. Falls through to
 * "unknown function" when the business has no enabled EHR — which is the
 * pre-existing behavior for a model that calls a tool it was never offered.
 */
async function executeViaEhr(fc, ctx) {
  const integrations = ctx?.integrations || [];
  const adapter = schedulingAdapter(ctx?.config, integrations);
  const integration = adapter.integrationFor?.(integrations) || null;

  // No external book configured: the model called a tool it was never offered.
  if (!integration) return unknownToolResult(fc);

  const execResult = await ctx.deps.executeIntegration(integration, {
    tool: fc.name,
    arguments: fc.args || {},
    business_id: ctx.businessId || null,
    call_id: ctx.callId || null,
    caller_phone: ctx.callerPhone || null,
  });
  const success = execResult.success === true;

  return {
    functionResponse: {
      id: fc.id,
      name: fc.name,
      response: success
        ? { success: true, message: execResult.message }
        : { success: false, error: execResult.error },
    },
    stateEffects: {
      toolResult: {
        name: fc.name,
        success,
        message: success ? execResult.message : execResult.error || "Something went wrong.",
      },
      toolCallEvent: { name: fc.name, args: fc.args },
    },
  };
}

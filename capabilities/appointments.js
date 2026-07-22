/**
 * Appointments capability pack.
 *
 * Booking, checking, cancelling and rescheduling. The most complex pack and the
 * one the whole abstraction was extracted from: stateful, identity-strict, and
 * backed by an external system.
 *
 * Step A status: tool declarations and prompt fragments. Both are moved VERBATIM
 * out of services/gemini.js — every description and instruction string is
 * byte-identical, because tests/promptSnapshot.test.js asserts neither the
 * merged tool list nor the prompt has changed by a single character.
 * Requirements and execution move here in the following commits.
 */

import { resolveDayHours, formatClockTime, resolveBusinessHoursForPrompt } from "../lib/businessHours.js";
import {
  HAS_OFFSET_RE,
  parseNaiveDateTime,
  zonedComponentsToUtcMs,
  zonedWeekdayAndMinutes,
} from "../lib/capabilities/datetime.js";
import { noBusinessResult, unknownToolResult } from "../lib/capabilities/results.js";

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

/**
 * Internal-database appointment tools — the no-EHR path.
 *
 * The phone_last4 second factor in cancel/reschedule is a hand-rolled instance
 * of what becomes the generic `identity` requirement kind in Step B.
 */
const DB_APPOINTMENT_DECLARATIONS = [
  {
    name: "get_caller_appointments_from_db",
    description:
      "Look up the caller's scheduled appointments in our database by their phone or name. Use when the business does not have an EHR integration.",
    parameters: {
      type: "object",
      properties: {
        caller_phone: { type: "string", description: "Caller's phone number" },
        caller_name: { type: "string", description: "Caller's full name (optional)" },
      },
      required: [],
    },
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
 * Does this business have a scheduling backend that owns the appointment book?
 * When it does, the internal-DB tools are suppressed so the model cannot write
 * appointments to two places.
 * @param {Array<{enabled?: boolean, provider?: string}>} integrations
 */
function hasEhrIntegration(integrations) {
  const list = Array.isArray(integrations) ? integrations : [];
  return list.some((i) => i.enabled && i.provider === "athenahealth" /* future EHRs */);
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
function bookingGuidance(config, now) {
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

  return (
    `Your task: Help the caller find a good appointment time and collect their details. ` +
    `Act like a real receptionist — don't just ask "what time works for you?" Instead, one question at a time:\n` +
    `1. Ask whether they prefer mornings or afternoons.\n` +
    `2. Ask if any specific days of the week don't work for them.\n` +
    `3. Based on their preference and business hours (${businessHoursStr}), suggest 2-3 specific times. Example: "We have availability Tuesday at 10 AM or Thursday at 2 PM — do either of those work?"\n` +
    `4. Once they pick a time, confirm name and service. When the caller gives their name, repeat it back naturally in your next sentence ("Thanks, Marcus — ..."). If the name is unusual, uncommon, or you're not sure you heard it correctly, ask them to spell it once and read the spelling back. Do not ask common, clearly-heard names to be spelled. Then repeat all details back (name, date, time, service) and explicitly ask "Does that sound right?" or "Shall I go ahead and book that?"\n` +
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
  if (ctx?.identityVerifiedApptId && appointmentId === ctx.identityVerifiedApptId) return true;
  const appointment = await ctx.deps.getAppointmentById(appointmentId, ctx.businessId);
  return appointmentBelongsToCaller(appointment, ctx, argsClientName, argsPhoneLast4);
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
 * @returns {{ok: true, scheduledAt: string} | {ok: false, message: string}}
 */
function validateBookingTime(rawScheduledAt, config) {
  if (typeof rawScheduledAt !== "string" || !rawScheduledAt.trim()) {
    return { ok: false, message: INVALID_DATETIME_MESSAGE };
  }
  const trimmed = rawScheduledAt.trim();
  const timezone = config?.timezone || "America/Chicago";

  let targetMs;
  let storedValue;

  if (HAS_OFFSET_RE.test(trimmed)) {
    // Already unambiguous (explicit Z/offset) — validate and store verbatim,
    // no reformatting.
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) return { ok: false, message: INVALID_DATETIME_MESSAGE };
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

  return { ok: true, scheduledAt: storedValue };
}

const BOOKING_CONFIRMATION_GUARDRAIL =
  `- For appointment bookings: before calling book_appointment, you MUST read back the caller's name, date, time, and service type, then ask a clear yes/no confirmation question. Only call book_appointment after the caller responds with an affirmative ("yes", "correct", "that's right", "go ahead", "sounds good"). If the caller's name is unusual or you're unsure you heard it right, confirm its spelling once before the final read-back.\n`;

/** @type {import("./_contract.js").CapabilityPack} */
export default {
  id: "appointments",
  core: false,
  adapterKind: "scheduling",

  /** Every tool this pack can own, for registry dispatch. */
  toolNames: [
    BOOK_APPOINTMENT_DECLARATION.name,
    ...EHR_APPOINTMENT_DECLARATIONS.map((d) => d.name),
    ...DB_APPOINTMENT_DECLARATIONS.map((d) => d.name),
  ],

  /**
   * Tools whose success is caller-visible, unlocking same-turn end_call.
   * Previously the hardcoded ACTION_TOOL_NAMES array in services/gemini.js:14.
   */
  actionTools: ["book_appointment", "cancel_appointment_db", "reschedule_appointment_db"],

  tools(config) {
    const allowed = config?.allowedTasks || [];
    return allowed.includes("book_appointment") ? [BOOK_APPOINTMENT_DECLARATION] : [];
  },

  adapterTools(config, ctx = {}) {
    const integrations = Array.isArray(ctx.integrations) ? ctx.integrations : [];
    const allowed = config?.allowedTasks || [];

    // "appointments" is a legacy bundle name — normalizeAllowedTasks always
    // expands it to the three appointment MODULE_TASKS before config reaches
    // here, so gating is purely module-name-based.
    const wantsLookupOrChange =
      allowed.includes("cancel_reschedule") || allowed.includes("check_appointment");

    if (hasEhrIntegration(integrations)) return [];
    if (!wantsLookupOrChange) return [];
    return [...DB_APPOINTMENT_DECLARATIONS];
  },

  /**
   * EHR tool declarations, surfaced separately because services/gemini.js's
   * `buildIntegrationTools` has a directly-tested public contract that emits
   * them (tests/gemini-integrations.test.js). Step B dissolves this once
   * adapters own backend selection.
   * @param {Array} integrations
   */
  ehrTools(integrations) {
    return hasEhrIntegration(integrations) ? [...EHR_APPOINTMENT_DECLARATIONS] : [];
  },

  prompt(config, ctx = {}) {
    const allowed = config?.allowedTasks || [];
    const hasEhr =
      ctx.hasEhrIntegration === true || hasEhrIntegration(ctx.integrations);
    const now = ctx.now instanceof Date ? ctx.now : new Date();

    return {
      static: {
        // The CAPABILITIES line IS module-gated — it always was.
        capabilities: capabilityClauses(allowed),

        // The confirmation guardrail is NOT gated, faithfully reproducing
        // today's behavior: it is emitted even for a business with no
        // appointment module, where book_appointment is not registered at all.
        // That is arguably wrong — dead instructions about a tool the model
        // cannot call — but changing it is a behavior change, so it waits for
        // Step B, where confirmBeforeWrite becomes an enforced requirement kind
        // and naturally only applies where the capability is enabled.
        guardrails: [BOOKING_CONFIRMATION_GUARDRAIL],
      },
      dynamic: {
        // Also ungated, matching buildStepGuidance's original behavior: it
        // switched purely on the intent the model reported, never on whether
        // the business had the module enabled.
        stepGuidance: {
          book_appointment: bookingGuidance(config, now),
          cancel_reschedule: cancelRescheduleGuidance(hasEhr),
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
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function bookAppointment(fc, ctx) {
  if (!ctx?.businessId) return noBusinessResult(fc, { appointmentArgs: null });

  const args = fc.args ?? {};
  const config = ctx.config || {};
  let bookSuccess = false;
  let bookMessage =
    "I'm sorry, I wasn't able to book that appointment. Let me take your details so someone can follow up.";
  let anchoredScheduledAt = null;
  let alreadyBooked = false;

  if (args.scheduled_at) {
    const validated = validateBookingTime(args.scheduled_at, config);
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
      const lastBookedMs = Date.parse(ctx?.lastBookedAppointment?.scheduled_at ?? "");
      if (Number.isFinite(lastBookedMs) && lastBookedMs === Date.parse(anchoredScheduledAt)) {
        alreadyBooked = true;
        bookSuccess = true;
        bookMessage =
          "That appointment is already booked from earlier in this call. Do not book it again — just confirm it to the caller.";
      } else {
        const notes = [args.service_type, args.notes].filter(Boolean).join(" — ") || null;
        try {
          const dbId = await ctx.deps.createAppointment({
            businessId: ctx.businessId,
            callId: ctx.callId || null,
            clientName: args.client_name || null,
            clientPhone: ctx.callerPhone || null,
            scheduledAt: anchoredScheduledAt,
            notes,
          });
          if (dbId) {
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

  // A fresh booking carries appointmentArgs downstream (step transition, owner
  // notification, confirmation SMS). The already-booked short-circuit must NOT
  // re-fire those side effects.
  const appointmentArgs =
    bookSuccess && !alreadyBooked ? { ...args, scheduled_at: anchoredScheduledAt } : null;

  return {
    functionResponse: {
      id: fc.id,
      name: fc.name,
      response: { success: bookSuccess, message: bookMessage },
    },
    stateEffects: {
      appointmentArgs,
      toolResult: { name: fc.name, success: bookSuccess, message: bookMessage },
      toolCallEvent: { name: fc.name, args },
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
    appointments = await ctx.deps.listAppointmentsByCaller(ctx.businessId, {
      clientPhone: callerPhone,
    });
    if (appointments.length === 1) selectedAppointmentId = appointments[0].id;
  }

  return {
    functionResponse: { id: fc.id, name: fc.name, response: { success: true, appointments } },
    stateEffects: {
      ...(selectedAppointmentId !== undefined ? { selectedAppointmentId } : {}),
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
      toolResult: { name: fc.name, success: false, message: IDENTITY_MISMATCH_MESSAGE },
      toolCallEvent: { name: fc.name, args: fc.args },
    },
  };
}

async function cancelAppointment(fc, ctx) {
  if (!ctx?.businessId) return noBusinessResult(fc);

  const appointmentId = fc.args?.appointment_id || ctx?.selectedAppointmentId;
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

  const ok = await ctx.deps.updateAppointmentStatus(appointmentId, "cancelled", ctx.businessId);

  return {
    functionResponse: {
      id: fc.id,
      name: fc.name,
      response: ok
        ? { success: true, message: "That appointment has been cancelled." }
        : { success: false, message: "I couldn't cancel that appointment." },
    },
    stateEffects: {
      // Identity passed above regardless of the write outcome — remember it so
      // a retry (or a follow-up reschedule) doesn't re-challenge the caller.
      identityVerifiedApptId: appointmentId,
      toolResult: {
        name: fc.name,
        success: ok,
        message: ok ? "Cancelled." : "Couldn't cancel.",
        appointmentId,
      },
      toolCallEvent: { name: fc.name, args: fc.args },
    },
  };
}

async function rescheduleAppointment(fc, ctx) {
  if (!ctx?.businessId) return noBusinessResult(fc);

  const appointmentId = fc.args?.appointment_id || ctx?.selectedAppointmentId;
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

  const ok = await ctx.deps.updateAppointment(
    appointmentId,
    { scheduled_at: newScheduledAt },
    ctx.businessId
  );

  return {
    functionResponse: {
      id: fc.id,
      name: fc.name,
      response: ok
        ? { success: true, message: "Rescheduled." }
        : { success: false, message: "Couldn't reschedule." },
    },
    stateEffects: {
      identityVerifiedApptId: appointmentId,
      toolResult: {
        name: fc.name,
        success: ok,
        message: ok ? "Rescheduled." : "Couldn't reschedule.",
        appointmentId,
      },
      toolCallEvent: { name: fc.name, args: fc.args },
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
  const integration = integrations.find((i) => i.provider === "athenahealth" && i.enabled);

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

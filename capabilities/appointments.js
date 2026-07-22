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

import { resolveBusinessHoursForPrompt } from "../lib/businessHours.js";

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
};

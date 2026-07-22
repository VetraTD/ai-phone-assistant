/**
 * Appointments capability pack.
 *
 * Booking, checking, cancelling and rescheduling. The most complex pack and the
 * one the whole abstraction was extracted from: stateful, identity-strict, and
 * backed by an external system.
 *
 * Step A status: tool declarations only. They are moved VERBATIM out of
 * services/gemini.js — every description string is byte-identical, because
 * tests/promptSnapshot.test.js asserts the merged tool list has not changed by
 * a single character. Prompt fragments, requirements and execution move here in
 * the following commits.
 */

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
};

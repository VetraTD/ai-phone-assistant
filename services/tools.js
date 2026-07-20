import { captureException } from "../lib/sentry.js";
import {
  listAppointmentsByCaller,
  updateAppointmentStatus,
  updateAppointment,
  createAppointment,
} from "./supabase.js";
import { executeIntegration } from "./integrations.js";

// ---------------------------------------------------------------------------
// tools.js — Gemini tool-call executor.
//
// Extracted verbatim (pure move, no behavior change) from
// services/gemini.js getReplyStreaming's function-call switch. Preserves
// existing bugs bit-for-bit — see the TODO(phase2) markers below — those
// are fixed in the next task, not here.
// ---------------------------------------------------------------------------

const ATHENA_TOOL_NAMES = [
  "get_caller_appointments",
  "get_available_slots",
  "book_appointment_in_ehr",
  "cancel_appointment",
  "reschedule_appointment",
];

/**
 * Execute a single Gemini function call and report the state effects the
 * caller (getReplyStreaming) should apply to its turn accumulators.
 *
 * @param {{id: string, name: string, args: object}} fc - one entry from response.functionCalls
 * @param {object} ctx - turn/call context the switch reads
 * @param {string|null} [ctx.businessId]
 * @param {string|null} [ctx.callerPhone]
 * @param {string|null} [ctx.callId]
 * @param {Array} [ctx.integrations]
 * @param {string|null} [ctx.selectedAppointmentId]
 * @param {object} [ctx.config] - normalised business config (unused by the current
 *   switch cases, but carried through for parity with the non-streaming getReply
 *   variant and for future tool implementations)
 * @returns {Promise<{
 *   functionResponse: {id: string, name: string, response: object},
 *   stateEffects: {
 *     intentArgs?: object|null,
 *     appointmentArgs?: object|null,
 *     endCallArgs?: object|null,
 *     customerRequestArgs?: object|null,
 *     selectedAppointmentId?: string|null,
 *     toolResult?: {name: string, success: boolean, message: string},
 *     toolCallEvent?: {name: string, args: object}|null,
 *   }
 * }>}
 */
export async function executeToolCall(fc, ctx) {
  switch (fc.name) {
    case "set_call_intent": {
      const intentArgs = fc.args ?? null;
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
        stateEffects: {
          intentArgs,
          toolResult: { name: fc.name, success: true, message: "How can I help you with that?" },
          toolCallEvent: { name: fc.name, args: fc.args },
        },
      };
    }

    case "book_appointment": {
      const args = fc.args ?? {};
      const businessId = ctx?.businessId || null;
      const callerPhone = ctx?.callerPhone || null;
      const callId = ctx?.callId || null;
      let bookSuccess = false;
      let bookMessage = "I'm sorry, I wasn't able to book that appointment. Let me take your details so someone can follow up.";

      if (businessId && args.scheduled_at) {
        const notes = [args.service_type, args.notes].filter(Boolean).join(" — ") || null;
        try {
          const dbId = await createAppointment({ businessId, callId, clientName: args.client_name || null, clientPhone: callerPhone || null, scheduledAt: args.scheduled_at, notes });
          if (dbId) { bookSuccess = true; bookMessage = "Appointment booked successfully."; }
        } catch (err) {
          const isSlotTaken = err?.message?.includes("unique") || err?.code === "23505";
          bookMessage = isSlotTaken
            ? "That time slot is no longer available. Please ask the caller to pick a different time."
            : "There was an error booking the appointment. Please take the caller's details for follow-up.";
          captureException(err);
        }
      }
      const appointmentArgs = bookSuccess ? args : null;
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: bookSuccess, message: bookMessage } },
        stateEffects: {
          appointmentArgs,
          toolResult: { name: fc.name, success: bookSuccess, message: bookMessage },
          toolCallEvent: { name: fc.name, args },
        },
      };
    }

    case "record_customer_request": {
      const args = fc.args ?? {};
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: true, message: "I'll make sure they get your message." } },
        stateEffects: {
          customerRequestArgs: args,
          toolResult: { name: fc.name, success: true, message: "I'll make sure they get your message." },
          toolCallEvent: { name: fc.name, args },
        },
      };
    }

    case "end_call": {
      // TODO(phase2): missing step-gating — the non-streaming getReply variant
      // only allows end_call to succeed during the "confirm"/"ending" steps;
      // this streaming path always succeeds regardless of step. Fix in phase 2.
      const endCallArgs = fc.args ?? {};
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
        stateEffects: {
          endCallArgs,
          toolResult: { name: fc.name, success: true, message: "Goodbye!" },
          toolCallEvent: { name: fc.name, args: fc.args },
        },
      };
    }

    case "get_caller_appointments_from_db": {
      const callerPhone = ctx?.callerPhone || fc.args?.caller_phone;
      const businessId = ctx?.businessId || null;
      let appointments = [];
      let selectedAppointmentId;
      if (callerPhone && businessId) {
        // TODO(phase2): bug — listAppointmentsByCaller expects
        // (businessId, {clientPhone, clientName}), not a bare phone string.
        // Preserved verbatim from the pre-extraction code; fix in phase 2.
        appointments = await listAppointmentsByCaller(businessId, callerPhone);
        if (appointments.length === 1) selectedAppointmentId = appointments[0].id;
      }
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: true, appointments } },
        stateEffects: {
          ...(selectedAppointmentId !== undefined ? { selectedAppointmentId } : {}),
          toolResult: { name: fc.name, success: true, message: `Found ${appointments.length} appointments.` },
          toolCallEvent: { name: fc.name, args: fc.args },
        },
      };
    }

    case "cancel_appointment_db": {
      const appointmentId = fc.args?.appointment_id || ctx?.selectedAppointmentId;
      const businessId = ctx?.businessId || null;
      if (!appointmentId) {
        return {
          functionResponse: { id: fc.id, name: fc.name, response: { success: false, message: "Which appointment?" } },
          stateEffects: {
            toolResult: { name: fc.name, success: false, message: "I need to look up your appointment first." },
            toolCallEvent: null,
          },
        };
      }
      const ok = await updateAppointmentStatus(appointmentId, "cancelled", businessId);
      return {
        functionResponse: {
          id: fc.id,
          name: fc.name,
          response: ok
            ? { success: true, message: "That appointment has been cancelled." }
            : { success: false, message: "I couldn't cancel that appointment." },
        },
        stateEffects: {
          toolResult: { name: fc.name, success: ok, message: ok ? "Cancelled." : "Couldn't cancel." },
          toolCallEvent: { name: fc.name, args: fc.args },
        },
      };
    }

    case "reschedule_appointment_db": {
      const appointmentId = fc.args?.appointment_id || ctx?.selectedAppointmentId;
      const newScheduledAt = fc.args?.new_scheduled_at;
      const businessId = ctx?.businessId || null;
      if (!appointmentId || !newScheduledAt) {
        return {
          functionResponse: {
            id: fc.id,
            name: fc.name,
            response: { success: false, message: !appointmentId ? "Which appointment?" : "New date/time required." },
          },
          stateEffects: {
            toolResult: { name: fc.name, success: false, message: "Missing info." },
            toolCallEvent: null,
          },
        };
      }
      const ok = await updateAppointment(appointmentId, { scheduled_at: newScheduledAt }, businessId);
      return {
        functionResponse: {
          id: fc.id,
          name: fc.name,
          response: ok
            ? { success: true, message: "Rescheduled." }
            : { success: false, message: "Couldn't reschedule." },
        },
        stateEffects: {
          toolResult: { name: fc.name, success: ok, message: ok ? "Rescheduled." : "Couldn't reschedule." },
          toolCallEvent: { name: fc.name, args: fc.args },
        },
      };
    }

    default: {
      // Dynamic integration tools (webhook, athenahealth)
      const integrations = ctx?.integrations || [];
      const businessId = ctx?.businessId || null;
      const callerPhone = ctx?.callerPhone || null;
      const callId = ctx?.callId || null;
      const isAthenaTool = ATHENA_TOOL_NAMES.includes(fc.name);
      const integration = isAthenaTool
        ? integrations.find((i) => i.provider === "athenahealth" && i.enabled)
        : integrations.find((i) => i.name === fc.name);

      if (integration && integration.enabled) {
        const execResult = await executeIntegration(integration, { tool: fc.name, arguments: fc.args || {}, business_id: businessId, call_id: callId, caller_phone: callerPhone });
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
            toolResult: { name: fc.name, success, message: success ? execResult.message : (execResult.error || "Something went wrong.") },
            toolCallEvent: { name: fc.name, args: fc.args },
          },
        };
      }
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { error: "Unknown function" } },
        stateEffects: {
          toolResult: { name: fc.name, success: false, message: "I'm sorry, I wasn't able to do that." },
          toolCallEvent: { name: fc.name, args: fc.args },
        },
      };
    }
  }
}

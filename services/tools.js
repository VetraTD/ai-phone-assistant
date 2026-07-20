import { captureException } from "../lib/sentry.js";
import {
  listAppointmentsByCaller,
  updateAppointmentStatus,
  updateAppointment,
  createAppointment,
  getAppointmentById,
} from "./supabase.js";
import { executeIntegration } from "./integrations.js";

// ---------------------------------------------------------------------------
// tools.js — Gemini tool-call executor.
//
// Originally extracted verbatim (pure move, no behavior change) from
// services/gemini.js getReplyStreaming's function-call switch. The
// phase2 fixes (caller-identity guard, end_call step-gating, the
// get_caller_appointments_from_db lookup-arg bug) now live here.
// ---------------------------------------------------------------------------

const ATHENA_TOOL_NAMES = [
  "get_caller_appointments",
  "get_available_slots",
  "book_appointment_in_ehr",
  "cancel_appointment",
  "reschedule_appointment",
];

const IDENTITY_MISMATCH_MESSAGE =
  "I can only make changes to appointments booked under your number. Let me take a message instead.";

/**
 * Does the given appointment row belong to the current caller?
 * Matches on either the caller's verified phone number (last 10 digits,
 * from ctx.callerPhone — trusted call metadata, not model-supplied) OR a
 * case-insensitive exact match of the client_name on file against the
 * client_name argument the model supplies for this call.
 * @param {{client_phone?: string|null, client_name?: string|null}|null} appointment
 * @param {{callerPhone?: string|null}} ctx
 * @param {string|undefined} argsClientName
 * @returns {boolean}
 */
function appointmentBelongsToCaller(appointment, ctx, argsClientName) {
  if (!appointment) return false;

  const callerDigits = String(ctx?.callerPhone || "").replace(/\D/g, "");
  const apptDigits = String(appointment.client_phone || "").replace(/\D/g, "");
  const phoneMatches =
    callerDigits.length >= 10 && apptDigits.length >= 10 && callerDigits.slice(-10) === apptDigits.slice(-10);

  const nameArg = String(argsClientName || "").trim().toLowerCase();
  const apptName = String(appointment.client_name || "").trim().toLowerCase();
  const nameMatches = nameArg.length > 0 && apptName.length > 0 && nameArg === apptName;

  return phoneMatches || nameMatches;
}

/**
 * Fetch the target appointment and verify it belongs to the caller before
 * cancel/reschedule mutate it. Fails closed: a missing appointmentId, a row
 * that can't be found (wrong business, bad id), or no phone/name match all
 * return false.
 * @param {string|undefined} appointmentId
 * @param {object} ctx
 * @param {string|undefined} argsClientName
 * @returns {Promise<boolean>}
 */
async function verifyAppointmentIdentity(appointmentId, ctx, argsClientName) {
  if (!appointmentId) return false;
  const appointment = await getAppointmentById(appointmentId, ctx?.businessId || null);
  return appointmentBelongsToCaller(appointment, ctx, argsClientName);
}

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
 * @param {string} [ctx.step] - current call step (e.g. "confirm", "ending") — gates end_call
 * @param {boolean} [ctx.transferAllowed] - gates request_transfer
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
 *     transferRequested?: {reason: string|null}|null,
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
      // Only allow ending the call during the confirm or ending steps. This
      // makes it much less likely to hang up before the caller has a chance
      // to say they don't need anything else. Ported from the legacy
      // (pre-streaming) getReply's end_call gating.
      if (ctx?.step === "confirm" || ctx?.step === "ending") {
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
      const message =
        "Don't end the call yet. First confirm you've helped with their request and ask if there's anything else they need.";
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: false, message } },
        stateEffects: {
          toolResult: { name: fc.name, success: false, message: "Is there anything else I can help you with?" },
          toolCallEvent: { name: fc.name, args: fc.args },
        },
      };
    }

    case "get_caller_appointments_from_db": {
      // Use only the verified caller phone from call metadata (ctx.callerPhone)
      // — never a model-supplied phone number — so a caller can't fish for
      // another customer's appointments by asking about a different number.
      const callerPhone = ctx?.callerPhone || null;
      const businessId = ctx?.businessId || null;
      let appointments = [];
      let selectedAppointmentId;
      if (callerPhone && businessId) {
        appointments = await listAppointmentsByCaller(businessId, { clientPhone: callerPhone });
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
      const identityOk = await verifyAppointmentIdentity(appointmentId, ctx, fc.args?.client_name);
      if (!identityOk) {
        return {
          functionResponse: { id: fc.id, name: fc.name, response: { success: false, message: IDENTITY_MISMATCH_MESSAGE } },
          stateEffects: {
            toolResult: { name: fc.name, success: false, message: IDENTITY_MISMATCH_MESSAGE },
            toolCallEvent: { name: fc.name, args: fc.args },
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
      const identityOk = await verifyAppointmentIdentity(appointmentId, ctx, fc.args?.client_name);
      if (!identityOk) {
        return {
          functionResponse: { id: fc.id, name: fc.name, response: { success: false, message: IDENTITY_MISMATCH_MESSAGE } },
          stateEffects: {
            toolResult: { name: fc.name, success: false, message: IDENTITY_MISMATCH_MESSAGE },
            toolCallEvent: { name: fc.name, args: fc.args },
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

    case "request_transfer": {
      const reason = fc.args?.reason || null;
      if (!ctx?.transferAllowed) {
        const message = "Transfer is not available right now. Offer to take a message instead.";
        return {
          functionResponse: { id: fc.id, name: fc.name, response: { success: false, message } },
          stateEffects: {
            toolResult: { name: fc.name, success: false, message },
            toolCallEvent: { name: fc.name, args: fc.args },
          },
        };
      }
      const message = "Let the caller know you are transferring them now, briefly.";
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: true, message } },
        stateEffects: {
          transferRequested: { reason },
          toolResult: { name: fc.name, success: true, message },
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

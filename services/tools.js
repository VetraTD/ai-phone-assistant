import { captureException } from "../lib/sentry.js";
import {
  listAppointmentsByCaller,
  updateAppointmentStatus,
  updateAppointment,
  createAppointment,
  getAppointmentById,
} from "./supabase.js";
import { executeIntegration } from "./integrations.js";
import { resolveDayHours, formatClockTime } from "../lib/businessHours.js";

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

// Returned by every appointment tool when the call has no business context
// (lib/voice/session.js logs "no_business_found" and continues with
// state.businessId unset). Running these tools unscoped would query across
// every tenant, so they refuse outright and steer the model to take a message.
const NO_BUSINESS_MESSAGE =
  "I'm not able to look that up right now. Let me take a message and someone will follow up.";

/** Uniform "this tool cannot run without a tenant" result. */
function noBusinessResult(fc) {
  return {
    functionResponse: { id: fc.id, name: fc.name, response: { success: false, message: NO_BUSINESS_MESSAGE } },
    stateEffects: {
      ...(fc.name === "book_appointment" ? { appointmentArgs: null } : {}),
      toolResult: { name: fc.name, success: false, message: NO_BUSINESS_MESSAGE },
      toolCallEvent: { name: fc.name, args: fc.args ?? {} },
    },
  };
}

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

// ---------------------------------------------------------------------------
// Booking-time validation + timezone anchoring (book_appointment)
//
// The model sends scheduled_at as a naive "YYYY-MM-DDTHH:MM[:SS]" string
// (per the tool's JSON schema — see services/gemini.js buildCallTools) with
// no timezone info at all. Historically that string went straight to
// createAppointment: no future/past check, no business-hours check, and no
// timezone anchoring — a "10:00" booking for an America/Chicago business was
// stored as if it were 10:00 UTC, six hours off from what the caller agreed
// to.
//
// validateBookingTime interprets the naive datetime in ctx.config.timezone
// and converts it to an unambiguous UTC ISO string using Intl.DateTimeFormat
// offset math only (no timezone-database dependency) — the same technique
// services/gemini.js's isBusinessOpen/resolveBusinessHoursForPrompt already
// use to read "now" in a business's timezone. If the caller already supplied
// an offset-anchored value (trailing "Z" or "+HH:MM"/"-HH:MM"), it is
// already unambiguous and is stored byte-for-byte rather than reformatted.
// ---------------------------------------------------------------------------

const INVALID_DATETIME_MESSAGE =
  "I didn't catch a valid date and time — could you say the day and time again?";
const PAST_DATETIME_MESSAGE = "That time has already passed — what day and time works for you?";
const CLOSED_DAY_MESSAGE = "We're closed that day — would another time work?";

// Small grace window so a booking for "right now" (model latency, clock
// skew) isn't rejected as already in the past.
const BOOKING_PAST_GRACE_MS = 60_000;

const NAIVE_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const HAS_OFFSET_RE = /(?:Z|[+-]\d{2}:\d{2})$/i;

/**
 * Parse a strict naive "YYYY-MM-DDTHH:MM[:SS]" datetime (no offset/Z) into
 * numeric components, rejecting out-of-range or calendar-impossible dates
 * (month 13, Feb 30, ...).
 * @param {string} str
 * @returns {{year:number,month:number,day:number,hour:number,minute:number,second:number}|null}
 */
function parseNaiveDateTime(str) {
  const m = NAIVE_DATETIME_RE.exec(str);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] ? Number(m[6]) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  // Round-trip through Date.UTC to reject calendar-impossible dates (e.g.
  // Feb 30 rolls over to Mar 2 and would silently mismatch).
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day, hour, minute, second };
}

/**
 * Offset (ms) such that: (wall-clock reading of `date` in `timeZone`) ===
 * date.getTime() + offset. E.g. for America/Chicago in summer (UTC-5), the
 * offset is roughly -5*3600*1000.
 * @param {Date} date
 * @param {string} timeZone
 * @returns {number}
 */
function getTzOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = {};
  for (const { type, value } of dtf.formatToParts(date)) {
    if (type !== "literal") parts[type] = value;
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - date.getTime();
}

/**
 * Convert naive local wall-clock components, interpreted in `timeZone`, into
 * the absolute UTC instant (ms since epoch) they represent. Standard
 * "guess against the offset at the guessed instant, then refine once against
 * the offset actually at the guessed UTC instant" approach so a
 * DST-transition day doesn't throw the result off by an hour. No timezone
 * database is used — only Intl.DateTimeFormat's own timeZone resolution.
 * @param {{year:number,month:number,day:number,hour:number,minute:number,second:number}} components
 * @param {string} timeZone
 * @returns {number} ms since epoch
 */
function zonedComponentsToUtcMs({ year, month, day, hour, minute, second }, timeZone) {
  const guessMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset1 = getTzOffsetMs(new Date(guessMs), timeZone);
  let utcMs = guessMs - offset1;
  const offset2 = getTzOffsetMs(new Date(utcMs), timeZone);
  if (offset2 !== offset1) utcMs = guessMs - offset2;
  return utcMs;
}

/**
 * Validate and timezone-anchor a `book_appointment` scheduled_at value
 * before it reaches createAppointment.
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

  // Business-hours check — read the resolved instant's wall-clock
  // weekday/time-of-day in the business's timezone (mirrors how
  // isBusinessOpen reads "now" in that timezone) and reuse resolveDayHours'
  // weekly/legacy/null shape handling rather than reinventing it.
  const zoned = new Date(targetMs);
  const shortWeekday = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" })
    .format(zoned)
    .slice(0, 3)
    .toLowerCase();
  const timeParts = zoned.toLocaleTimeString("en-GB", { timeZone: timezone, hour12: false }).split(":");
  const minutesOfDay = parseInt(timeParts[0], 10) * 60 + parseInt(timeParts[1], 10);

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

/**
 * Fetch the target appointment and verify it belongs to the caller before
 * cancel/reschedule mutate it. Fails closed: a missing appointmentId, a row
 * that can't be found (wrong business, bad id), or no phone / name+last-4
 * match all return false.
 * @param {string|undefined} appointmentId
 * @param {object} ctx
 * @param {string|undefined} argsClientName
 * @param {string|undefined} argsPhoneLast4
 * @returns {Promise<boolean>}
 */
async function verifyAppointmentIdentity(appointmentId, ctx, argsClientName, argsPhoneLast4) {
  if (!appointmentId || !ctx?.businessId) return false;
  const appointment = await getAppointmentById(appointmentId, ctx.businessId);
  return appointmentBelongsToCaller(appointment, ctx, argsClientName, argsPhoneLast4);
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
 * @param {object} [ctx.config] - normalised business config; book_appointment reads
 *   ctx.config.timezone/businessHours to validate + timezone-anchor scheduled_at
 *   (see validateBookingTime above)
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
      if (!ctx?.businessId) return noBusinessResult(fc);
      const args = fc.args ?? {};
      const businessId = ctx.businessId;
      const callerPhone = ctx?.callerPhone || null;
      const callId = ctx?.callId || null;
      const config = ctx?.config || {};
      let bookSuccess = false;
      let bookMessage = "I'm sorry, I wasn't able to book that appointment. Let me take your details so someone can follow up.";
      let anchoredScheduledAt = null;

      if (args.scheduled_at) {
        const validated = validateBookingTime(args.scheduled_at, config);
        if (!validated.ok) {
          bookMessage = validated.message;
        } else {
          anchoredScheduledAt = validated.scheduledAt;
          const notes = [args.service_type, args.notes].filter(Boolean).join(" — ") || null;
          try {
            const dbId = await createAppointment({
              businessId,
              callId,
              clientName: args.client_name || null,
              clientPhone: callerPhone || null,
              scheduledAt: anchoredScheduledAt,
              notes,
            });
            if (dbId) { bookSuccess = true; bookMessage = "Appointment booked successfully."; }
          } catch (err) {
            const isSlotTaken = err?.message?.includes("unique") || err?.code === "23505";
            bookMessage = isSlotTaken
              ? "That time slot is no longer available. Please ask the caller to pick a different time."
              : "There was an error booking the appointment. Please take the caller's details for follow-up.";
            captureException(err);
          }
        }
      }
      const appointmentArgs = bookSuccess ? { ...args, scheduled_at: anchoredScheduledAt } : null;
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
      if (!ctx?.businessId) return noBusinessResult(fc);
      const callerPhone = ctx?.callerPhone || null;
      const businessId = ctx.businessId;
      let appointments = [];
      let selectedAppointmentId;
      if (callerPhone) {
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
      if (!ctx?.businessId) return noBusinessResult(fc);
      const appointmentId = fc.args?.appointment_id || ctx?.selectedAppointmentId;
      const businessId = ctx.businessId;
      if (!appointmentId) {
        return {
          functionResponse: { id: fc.id, name: fc.name, response: { success: false, message: "Which appointment?" } },
          stateEffects: {
            toolResult: { name: fc.name, success: false, message: "I need to look up your appointment first." },
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
      if (!ctx?.businessId) return noBusinessResult(fc);
      const appointmentId = fc.args?.appointment_id || ctx?.selectedAppointmentId;
      const newScheduledAt = fc.args?.new_scheduled_at;
      const businessId = ctx.businessId;
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
      const identityOk = await verifyAppointmentIdentity(
        appointmentId,
        ctx,
        fc.args?.client_name,
        fc.args?.phone_last4
      );
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

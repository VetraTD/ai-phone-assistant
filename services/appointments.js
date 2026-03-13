/**
 * Appointments layer — EHR-agnostic high-level API for appointment operations.
 *
 * This module sits between the conversational agent and the EHR connector.
 * It exposes five clear functions that take simple inputs and return
 * { success, message, data? } results with human-friendly messages.
 *
 * Currently delegates to the Athenahealth connector. To add a new EHR,
 * implement the same function signatures and route by integration.provider.
 */

import { executeAthenahealth } from "../integrations/index.js";

/**
 * Resolve integration and execute a tool against the appropriate EHR.
 * @param {object} integration - { provider, config, enabled, ... }
 * @param {string} tool - tool name
 * @param {object} args - tool arguments
 * @returns {Promise<{ success: boolean, message: string, data?: object }>}
 */
async function executeEHR(integration, tool, args) {
  if (!integration || !integration.provider) {
    return { success: false, message: "No EHR system is configured. Please call the office directly." };
  }
  if (!integration.enabled) {
    return { success: false, message: "The scheduling system is currently offline. Please call the office." };
  }

  switch (integration.provider) {
    case "athenahealth":
      return executeAthenahealth(integration, { tool, arguments: args });
    default:
      return { success: false, message: "The scheduling system isn't available right now. Please call the office." };
  }
}

/**
 * Get a patient's upcoming appointments.
 *
 * @param {object} params
 * @param {string} params.name - Patient's full name (required)
 * @param {string} params.dob - Date of birth YYYY-MM-DD (required)
 * @param {string} [params.phone] - Phone number (for disambiguation)
 * @param {object} integration - EHR integration config
 * @returns {Promise<{ success: boolean, message: string, data?: { appointments: Array } }>}
 *
 * @example
 * const result = await getUpcomingAppointments(
 *   { name: "Jane Smith", dob: "1990-05-15" },
 *   athenaIntegration
 * );
 * // result.message → "Your next appointment is 04/10/2026 at 11:00 (Dr. Jones, General)."
 * // result.data.appointments → [{ appointmentId, date, time, provider, type, status }]
 */
export async function getUpcomingAppointments({ name, dob, phone } = {}, integration) {
  return executeEHR(integration, "get_caller_appointments", {
    caller_name: name,
    caller_dob: dob,
    caller_phone: phone,
  });
}

/**
 * Get available appointment slots for a given date.
 *
 * @param {object} params
 * @param {string} params.date - Date to check (YYYY-MM-DD, required)
 * @param {string} [params.serviceType] - Filter by visit/service type
 * @param {object} integration - EHR integration config
 * @returns {Promise<{ success: boolean, message: string, data?: { slots: Array } }>}
 *
 * @example
 * const result = await getAvailableSlots(
 *   { date: "2026-04-15" },
 *   athenaIntegration
 * );
 * // result.message → "Available times on 2026-04-15: 9:00, 10:30, 14:00."
 * // result.data.slots → [{ appointmentId, date, time, provider, type }]
 */
export async function getAvailableSlots({ date, serviceType } = {}, integration) {
  return executeEHR(integration, "get_available_slots", {
    date,
    service_type: serviceType,
  });
}

/**
 * Book a new appointment for a patient.
 *
 * @param {object} params
 * @param {string} params.name - Patient's full name (required)
 * @param {string} params.dob - Date of birth YYYY-MM-DD (required)
 * @param {string} params.scheduledAt - Desired date/time ISO 8601 (required)
 * @param {string} [params.phone] - Phone number
 * @param {string} [params.serviceType] - Type of visit
 * @param {string} [params.notes] - Additional notes
 * @param {object} integration - EHR integration config
 * @returns {Promise<{ success: boolean, message: string, data?: { bookedAppointment: object } }>}
 *
 * @example
 * const result = await bookAppointment(
 *   { name: "Jane Smith", dob: "1990-05-15", scheduledAt: "2026-04-15T10:30:00" },
 *   athenaIntegration
 * );
 * // result.message → "You're all set! Your appointment is confirmed for Tuesday, April 15 at 10:30 AM."
 */
export async function bookAppointment({ name, dob, phone, scheduledAt, serviceType, notes } = {}, integration) {
  return executeEHR(integration, "book_appointment_in_ehr", {
    caller_name: name,
    caller_dob: dob,
    caller_phone: phone,
    scheduled_at: scheduledAt,
    service_type: serviceType,
    notes,
  });
}

/**
 * Cancel an existing appointment.
 *
 * @param {object} params
 * @param {string} params.name - Patient's full name (required)
 * @param {string} params.dob - Date of birth YYYY-MM-DD (required)
 * @param {string} [params.phone] - Phone number
 * @param {string} [params.appointmentDate] - Date of appointment to cancel (YYYY-MM-DD)
 * @param {string} [params.appointmentTime] - Time of appointment to cancel (HH:MM)
 * @param {string} [params.reason] - Cancellation reason
 * @param {object} integration - EHR integration config
 * @returns {Promise<{ success: boolean, message: string, data?: { cancelledAppointmentId: string } }>}
 *
 * @example
 * const result = await cancelAppointment(
 *   { name: "Jane Smith", dob: "1990-05-15", appointmentDate: "2026-04-10" },
 *   athenaIntegration
 * );
 * // result.message → "Your appointment on 04/10/2026 at 11:00 has been cancelled."
 */
export async function cancelAppointment({ name, dob, phone, appointmentDate, appointmentTime, reason } = {}, integration) {
  return executeEHR(integration, "cancel_appointment", {
    caller_name: name,
    caller_dob: dob,
    caller_phone: phone,
    appointment_date: appointmentDate,
    appointment_time: appointmentTime,
    reason,
  });
}

/**
 * Reschedule an existing appointment to a new date/time.
 * Internally books the new slot first, then cancels the old one.
 *
 * @param {object} params
 * @param {string} params.name - Patient's full name (required)
 * @param {string} params.dob - Date of birth YYYY-MM-DD (required)
 * @param {string} [params.phone] - Phone number
 * @param {string} [params.currentDate] - Date of existing appointment (YYYY-MM-DD)
 * @param {string} [params.currentTime] - Time of existing appointment (HH:MM)
 * @param {string} params.newDate - Desired new date (YYYY-MM-DD, required)
 * @param {string} [params.newTime] - Desired new time (HH:MM)
 * @param {string} [params.serviceType] - Type of visit
 * @param {object} integration - EHR integration config
 * @returns {Promise<{ success: boolean, message: string, data?: { bookedAppointment: object, cancelledAppointmentId: string|null } }>}
 *
 * @example
 * const result = await rescheduleAppointment(
 *   { name: "Jane Smith", dob: "1990-05-15", currentDate: "2026-04-10", newDate: "2026-04-17" },
 *   athenaIntegration
 * );
 * // result.message → "Done! Your appointment has been rescheduled to 04/17/2026 at 09:00."
 */
export async function rescheduleAppointment({ name, dob, phone, currentDate, currentTime, newDate, newTime, serviceType } = {}, integration) {
  return executeEHR(integration, "reschedule_appointment", {
    caller_name: name,
    caller_dob: dob,
    caller_phone: phone,
    current_appointment_date: currentDate,
    current_appointment_time: currentTime,
    new_date: newDate,
    new_time: newTime,
    service_type: serviceType,
  });
}

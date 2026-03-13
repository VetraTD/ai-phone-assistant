/**
 * Example calls showing how higher-level code (like a conversational agent)
 * uses the appointments layer.
 *
 * These are illustrative — they show the API surface, inputs, and expected
 * return shapes. They are NOT meant to be run directly (no .env loading).
 */

import {
  getUpcomingAppointments,
  getAvailableSlots,
  bookAppointment,
  cancelAppointment,
  rescheduleAppointment,
} from "../services/appointments.js";

// The integration object comes from the database (integrations table).
// It tells the appointments layer which EHR to talk to.
const integration = {
  provider: "athenahealth",
  enabled: true,
  config: {
    practice_id: "753700",
    department_id: "4",
  },
};

// ---------------------------------------------------------------------------
// 1. Checking appointments
// ---------------------------------------------------------------------------
// Caller: "Hi, I'd like to check when my next appointment is."
// Agent has collected: name = "Jane Smith", DOB = "05/15/1990"

const upcoming = await getUpcomingAppointments(
  { name: "Jane Smith", dob: "05/15/1990" },
  integration
);
// upcoming.success  → true
// upcoming.message  → "Your next appointment is 04/10/2026 at 11:00 (Dr. Dodla, General)."
// upcoming.data     → { appointments: [{ appointmentId: "665988", date: "04/10/2026", time: "11:00", ... }] }

// ---------------------------------------------------------------------------
// 2. Finding available times
// ---------------------------------------------------------------------------
// Caller: "Do you have anything available next Wednesday?"
// Agent resolves "next Wednesday" to 2026-04-15.

const slots = await getAvailableSlots(
  { date: "2026-04-15", serviceType: "general" },
  integration
);
// slots.success → true
// slots.message → "Available times on 2026-04-15: 09:00, 10:30, 14:00."
// slots.data    → { slots: [{ appointmentId: "763744", date: "04/15/2026", time: "09:00", ... }, ...] }

// ---------------------------------------------------------------------------
// 3. Booking
// ---------------------------------------------------------------------------
// Caller: "Let's go with 10:30."
// Agent has: name, DOB, and the chosen time.

const booked = await bookAppointment(
  {
    name: "Jane Smith",
    dob: "05/15/1990",
    scheduledAt: "2026-04-15T10:30:00",
    serviceType: "general",
    notes: "New patient visit",
  },
  integration
);
// booked.success → true
// booked.message → "You're all set! Your appointment is confirmed for Wednesday, April 15 at 10:30 AM."
// booked.data    → { bookedAppointment: { appointmentId: "763745", date: "04/15/2026", time: "10:30", ... } }

// ---------------------------------------------------------------------------
// 4. Cancelling
// ---------------------------------------------------------------------------
// Caller: "I need to cancel my appointment on April 15th."

const cancelled = await cancelAppointment(
  {
    name: "Jane Smith",
    dob: "05/15/1990",
    appointmentDate: "2026-04-15",
    reason: "Schedule conflict",
  },
  integration
);
// cancelled.success → true
// cancelled.message → "Your appointment on 04/15/2026 at 10:30 (General) has been cancelled."
// cancelled.data    → { cancelledAppointmentId: "763745" }

// ---------------------------------------------------------------------------
// 5. Rescheduling
// ---------------------------------------------------------------------------
// Caller: "Can I move my April 10th appointment to April 22nd?"

const rescheduled = await rescheduleAppointment(
  {
    name: "Jane Smith",
    dob: "05/15/1990",
    currentDate: "2026-04-10",
    newDate: "2026-04-22",
    newTime: "09:00",
  },
  integration
);
// rescheduled.success → true
// rescheduled.message → "Done! Your appointment has been rescheduled to 04/22/2026 at 09:00."
// rescheduled.data    → {
//   bookedAppointment: { appointmentId: "763747", date: "04/22/2026", time: "09:00", ... },
//   cancelledAppointmentId: "665988"
// }

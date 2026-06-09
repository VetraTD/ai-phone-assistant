/**
 * Reschedule Admin Test's current appointment to a specific date (first available slot).
 * Usage: node scripts/reschedule-to-date.js [YYYY-MM-DD]
 * Example: node scripts/reschedule-to-date.js 2026-03-13
 */

import "dotenv/config";
import {
  getUpcomingAppointments,
  getAvailableSlots,
  rescheduleAppointment,
} from "../services/appointments.js";

const PRACTICE_ID = process.env.ATHENA_PRACTICE_ID || "";
const DEPARTMENT_ID = process.env.ATHENA_DEPARTMENT_ID || "4";
const USE_ECC_APP = process.env.USE_ECC_ATHENA === "true";

const PATIENT_NAME = "Admin Test";
const PATIENT_DOB = "01/01/2000";

const integration = {
  provider: "athenahealth",
  enabled: true,
  config: {
    practice_id: PRACTICE_ID,
    department_id: DEPARTMENT_ID,
    ...(USE_ECC_APP && { use_ecc_app: true }),
  },
};

const targetDate = process.argv[2] || "2026-03-13";

async function main() {
  if (!PRACTICE_ID) {
    console.error("Missing ATHENA_PRACTICE_ID in .env");
    process.exit(1);
  }

  console.log(`Reschedule to ${targetDate}`);
  console.log(`Patient: ${PATIENT_NAME}, DOB: ${PATIENT_DOB}\n`);

  const upcoming = await getUpcomingAppointments(
    { name: PATIENT_NAME, dob: PATIENT_DOB },
    integration
  );

  if (!upcoming.success || !upcoming.data?.appointments?.length) {
    console.error("No upcoming appointments to reschedule.");
    process.exit(1);
  }

  const current = upcoming.data.appointments[0];
  console.log(`Current appointment: ${current.date} at ${current.time} (id=${current.appointmentId})\n`);

  const slotsResult = await getAvailableSlots({ date: targetDate }, integration);
  if (!slotsResult.success || !slotsResult.data?.slots?.length) {
    console.error(`No available slots on ${targetDate}.`, slotsResult.message);
    process.exit(1);
  }

  const slot = slotsResult.data.slots[0];
  const newTime = slot.start.slice(11, 16);
  console.log(`Rescheduling to ${targetDate} at ${newTime} (slot ${slot.newAppointmentId})...\n`);

  const result = await rescheduleAppointment(
    {
      name: PATIENT_NAME,
      dob: PATIENT_DOB,
      currentDate: current.date,
      currentTime: current.time,
      newDate: targetDate,
      newTime,
    },
    integration
  );

  console.log("success:", result.success);
  console.log("message:", result.message);
  if (result.data) console.log("data:", JSON.stringify(result.data, null, 2));

  if (!result.success) process.exit(1);
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

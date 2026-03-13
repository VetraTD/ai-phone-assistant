/**
 * Test script: reschedule an existing appointment for a patient using the appointments layer.
 * Mirrors the phone-agent flow: get upcoming → find closest available date/slot → reschedule once.
 *
 * Uses the EHR's reschedule endpoint (atomic move). Run from project root:
 *   node scripts/test-reschedule-only.js
 *
 * Requires .env: ATHENA_PRACTICE_ID, ATHENA_DEPARTMENT_ID, and either
 * ATHENA_CLIENT_ID/ATHENA_CLIENT_SECRET/ATHENA_TOKEN_URL or ECC_ATHENA_* (if USE_ECC_ATHENA=true).
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

function hr(label) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${label}`);
  console.log("=".repeat(60));
}

function printResult(result) {
  console.log(`  success: ${result.success}`);
  console.log(`  message: ${result.message}`);
  if (result.data) console.log(`  data:`, JSON.stringify(result.data, null, 4));
}

async function main() {
  if (!PRACTICE_ID) {
    console.error("Missing ATHENA_PRACTICE_ID in .env");
    process.exit(1);
  }

  console.log(`Patient: ${PATIENT_NAME}`);
  console.log(`DOB: ${PATIENT_DOB}`);
  console.log(`Practice: ${PRACTICE_ID}, Department: ${DEPARTMENT_ID}`);

  // 1. Get current upcoming appointments (same as phone agent)
  hr("1. CURRENT UPCOMING APPOINTMENTS");
  const upcoming = await getUpcomingAppointments(
    { name: PATIENT_NAME, dob: PATIENT_DOB },
    integration
  );
  printResult(upcoming);

  if (!upcoming.success && upcoming.message?.includes("temporarily unavailable")) {
    console.error(
      "Athena credentials missing or invalid. Set ATHENA_CLIENT_ID and ATHENA_CLIENT_SECRET (or ECC_ATHENA_* if using ECC) in .env."
    );
    process.exit(1);
  }

  if (!upcoming.success || !upcoming.data?.appointments?.length) {
    console.log("  No upcoming appointments to reschedule.");
    process.exit(0);
  }

  const current = upcoming.data.appointments[0];
  console.log(
    `\n  Target appointment to move: ${current.date} at ${current.time} (id=${current.appointmentId})`
  );

  // 2. Find closest available: first date (from appointment date) that has open slots
  const startDate = new Date(current.date);
  let searchDate = new Date(startDate);
  let searchDateISO = "";
  let slots = null;

  for (let dayOffset = 0; dayOffset < 30; dayOffset++) {
    const yyyy = searchDate.getFullYear();
    const mm = String(searchDate.getMonth() + 1).padStart(2, "0");
    const dd = String(searchDate.getDate()).padStart(2, "0");
    searchDateISO = `${yyyy}-${mm}-${dd}`;

    hr(`2.${dayOffset + 1} AVAILABLE SLOTS ON ${searchDateISO}`);
    // eslint-disable-next-line no-await-in-loop
    const attemptSlots = await getAvailableSlots({ date: searchDateISO }, integration);
    printResult(attemptSlots);

    if (attemptSlots.success && attemptSlots.data?.slots?.length) {
      slots = attemptSlots;
      break;
    }

    // Move to next day
    searchDate.setDate(searchDate.getDate() + 1);
  }

  if (!slots) {
    console.log("  Could not find any open slots within the next 30 days; cannot reschedule.");
    process.exit(0);
  }

  const newDate = searchDateISO;

  // 3. Reschedule to closest available slot (earliest on that date; try until one is accepted)
  hr("3. RESCHEDULE TO CLOSEST AVAILABLE SLOT");
  let rescheduled = null;
  for (const slot of slots.data.slots) {
    const newTime = slot.start.slice(11, 16); // HH:MM from ISO
    console.log(
      `\n  Attempting reschedule to: ${newDate} at ${newTime} (newAppointmentId=${slot.newAppointmentId})`
    );
    // eslint-disable-next-line no-await-in-loop
    const attempt = await rescheduleAppointment(
      {
        name: PATIENT_NAME,
        dob: PATIENT_DOB,
        currentDate: current.date,
        currentTime: current.time,
        newDate,
        newTime,
      },
      integration
    );
    printResult(attempt);
    if (attempt.success) {
      rescheduled = attempt;
      console.log("  Reschedule succeeded with this slot.");
      break;
    }
    console.log("  Reschedule did not succeed for this slot, trying next (if any)...");
  }

  if (!rescheduled) {
    console.log("\n  No slots accepted by the reschedule endpoint; appointment remains unchanged.");
  }

  // 4. Show upcoming appointments after reschedule
  hr("4. UPCOMING APPOINTMENTS AFTER RESCHEDULE");
  const after = await getUpcomingAppointments(
    { name: PATIENT_NAME, dob: PATIENT_DOB },
    integration
  );
  printResult(after);

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});


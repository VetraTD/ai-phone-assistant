/**
 * Live integration test: exercises the appointments layer against the Athena sandbox.
 *
 * Run: node scripts/test-appointments-layer.js
 *
 * Note: The Athena sandbox may not have API booking enabled at the practice level.
 * If booking/rescheduling returns 409, that's a sandbox config issue, not a code bug.
 * Cancel and patient lookup are fully testable.
 */

import "dotenv/config";
import {
  getUpcomingAppointments,
  getAvailableSlots,
  bookAppointment,
  rescheduleAppointment,
  cancelAppointment,
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

  // --- 1. Get upcoming appointments ---
  hr("1. GET UPCOMING APPOINTMENTS");
  const r1 = await getUpcomingAppointments({ name: PATIENT_NAME, dob: PATIENT_DOB }, integration);
  printResult(r1);

  // --- 2. Get available slots ---
  hr("2. GET AVAILABLE SLOTS (2026-04-20)");
  const r2 = await getAvailableSlots({ date: "2026-04-20" }, integration);
  printResult(r2);

  // --- 3. Book appointment ---
  hr("3. BOOK APPOINTMENT");
  const r3 = await bookAppointment(
    { name: PATIENT_NAME, dob: PATIENT_DOB, scheduledAt: "2026-04-20T09:00" },
    integration
  );
  printResult(r3);
  if (!r3.success) {
    console.log("\n  NOTE: If status 409, the sandbox practice doesn't have API booking enabled.");
    console.log("  This is a practice-level athenaNet setting, not a code issue.");
  }

  // --- 4. Reschedule ---
  hr("4. RESCHEDULE APPOINTMENT");
  if (r3.success) {
    const r4 = await rescheduleAppointment(
      { name: PATIENT_NAME, dob: PATIENT_DOB, currentDate: "2026-04-20", newDate: "2026-04-27" },
      integration
    );
    printResult(r4);
  } else {
    console.log("  SKIP: Booking didn't succeed, nothing to reschedule.");
  }

  // --- 5. Cancel ---
  hr("5. CANCEL APPOINTMENT");
  const cancelTarget = r1.data?.appointments?.[0];
  if (cancelTarget) {
    console.log(`  Cancelling appointment ${cancelTarget.appointmentId} on ${cancelTarget.date}...`);
    const r5 = await cancelAppointment(
      { name: PATIENT_NAME, dob: PATIENT_DOB, appointmentDate: cancelTarget.date },
      integration
    );
    printResult(r5);
  } else {
    console.log("  SKIP: No upcoming appointment to cancel.");
  }

  // --- 6. Validation tests ---
  hr("6. VALIDATION: Missing DOB");
  const r6 = await getUpcomingAppointments({ name: PATIENT_NAME }, integration);
  printResult(r6);

  hr("7. VALIDATION: Unknown patient");
  const r7 = await getUpcomingAppointments({ name: "Nobody Existington", dob: "1900-01-01" }, integration);
  printResult(r7);

  hr("8. VALIDATION: No integration");
  const r8 = await getUpcomingAppointments({ name: PATIENT_NAME, dob: PATIENT_DOB }, null);
  printResult(r8);

  hr("9. VALIDATION: Disabled integration");
  const r9 = await getUpcomingAppointments(
    { name: PATIENT_NAME, dob: PATIENT_DOB },
    { ...integration, enabled: false }
  );
  printResult(r9);

  // --- Final state ---
  hr("FINAL: UPCOMING APPOINTMENTS");
  const rFinal = await getUpcomingAppointments({ name: PATIENT_NAME, dob: PATIENT_DOB }, integration);
  printResult(rFinal);

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

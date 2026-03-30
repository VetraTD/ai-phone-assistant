/**
 * Test script: fetch upcoming appointments for a patient (e.g. "Admin Test").
 * Run from project root: node scripts/test-appointments.js
 *
 * Requires .env with Athena credentials (ATHENA_CLIENT_ID, ATHENA_CLIENT_SECRET,
 * ATHENA_TOKEN_URL, ATHENA_API_BASE) and ATHENA_PRACTICE_ID (or pass practice ID below).
 * For ECC app, set USE_ECC_ATHENA=true and ECC_ATHENA_* vars.
 */

import "dotenv/config";
import { executeAthenahealth } from "../integrations/athenahealth.js";

const PATIENT_NAME = process.env.TEST_PATIENT_NAME || "Admin Test";
const PRACTICE_ID = process.env.ATHENA_PRACTICE_ID || ""; // set in .env or replace with your practice ID
const USE_ECC_APP = process.env.USE_ECC_ATHENA === "true";

async function main() {
  if (!PRACTICE_ID) {
    console.error("Missing practice ID. Set ATHENA_PRACTICE_ID in .env or edit PRACTICE_ID in this script.");
    process.exit(1);
  }

  const integration = {
    provider: "athenahealth",
    config: {
      practice_id: PRACTICE_ID,
      ...(USE_ECC_APP && { use_ecc_app: true }),
    },
  };

  const payload = {
    tool: "get_caller_appointments",
    arguments: { caller_name: PATIENT_NAME },
  };

  console.log("Fetching appointments for patient:", PATIENT_NAME);
  console.log("Practice ID:", PRACTICE_ID);
  console.log("");

  const result = await executeAthenahealth(integration, payload);

  if (result.success) {
    console.log("Success:", result.message);
  } else {
    console.error("Error:", result.error || "Unknown error");
    if (result.message) console.error("Message:", result.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

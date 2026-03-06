/**
 * Test the buy-number flow with Twilio test credentials.
 * Uses magic number +15005550006 (Twilio accepts this with test creds; no real purchase).
 *
 * Requires: .env with TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN (test creds), GEMINI_API_KEY, BASE_URL,
 *           SUPABASE_URL, SUPABASE_SERVICE_KEY. Optional: BUSINESS_ID (otherwise uses first business in DB).
 */
import "dotenv/config";

process.env.NODE_ENV = "test";

const BUSINESS_ID = process.env.BUSINESS_ID;

async function getFirstBusinessId() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(url, key);
  const { data, error } = await supabase
    .from("businesses")
    .select("id")
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data.id;
}

async function main() {
  let businessId = BUSINESS_ID;
  if (!businessId) {
    console.log("BUSINESS_ID not set; trying to use first business from Supabase...");
    businessId = await getFirstBusinessId();
  }
  if (!businessId) {
    console.error(
      "Set BUSINESS_ID to a valid business UUID (from your Supabase businesses table), or ensure Supabase is configured and you have at least one business."
    );
    process.exit(1);
  }

  const { default: request } = await import("supertest");
  const { app } = await import("../server.js");

  const magicNumber = "+15005550006"; // Twilio test magic number: buy succeeds with test creds

  console.log("POST /api/businesses/:id/phone-numbers/buy with phone_number:", magicNumber);
  const res = await request(app)
    .post(`/api/businesses/${businessId}/phone-numbers/buy`)
    .set("Content-Type", "application/json")
    .send({ phone_number: magicNumber });

  console.log("Status:", res.status);
  console.log("Body:", JSON.stringify(res.body, null, 2));

  if (res.status === 200) {
    console.log("\nBuy flow succeeded. Number saved to business:", res.body.phone_number);
  } else {
    console.error("\nBuy flow failed.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Test the buy-number flow with Twilio test credentials.
 * Uses magic number +15005550006 (Twilio accepts this with test creds; no real purchase).
 *
 * Requires: .env with TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN (test creds), GEMINI_API_KEY,
 *           BASE_URL, DATABASE_URL. Optional: BUSINESS_ID (otherwise the first business
 *           this connection can SEE — read the note below before trusting that).
 *
 * ---------------------------------------------------------------------------
 * THE TRAP IN "the first business in the database"
 * ---------------------------------------------------------------------------
 * `businesses` carries FORCE row-level security (migration 029). A SELECT with
 * no `app.business_id` set returns ZERO ROWS rather than an error, so the
 * obvious port of the old Supabase call — select id, limit 1 — reports "no
 * businesses configured" against a database full of them, and every symptom
 * points at the wrong thing. Locally it works anyway, because the dev `vetra`
 * role is a superuser with BYPASSRLS; against Cloud SQL, where no superuser
 * exists, it silently finds nothing.
 *
 * So the fallback asks the catalogue what it is actually looking at and says
 * which of the two situations it is in. "I cannot see any businesses" and
 * "there are no businesses" are different facts and this used to print the
 * second when the first was true.
 */
import "dotenv/config";
import pg from "pg";

process.env.NODE_ENV = "test";

const BUSINESS_ID = process.env.BUSINESS_ID;

/**
 * The first business this connection can see, or null with an explanation.
 * @returns {Promise<{ id: string|null, why: string|null }>}
 */
async function getFirstBusinessId() {
  if (!process.env.DATABASE_URL) return { id: null, why: "DATABASE_URL is not set" };

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    const { rows } = await client.query(`SELECT id FROM businesses ORDER BY created_at LIMIT 1`);
    if (rows.length) return { id: rows[0].id, why: null };

    // Zero rows. Find out which zero this is before reporting it.
    const { rows: diag } = await client.query(
      `SELECT coalesce((SELECT relforcerowsecurity FROM pg_class
                         WHERE oid = to_regclass('public.businesses')), false) AS forced,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user)   AS bypasses,
              current_setting('app.business_id', true)                           AS scope,
              current_user                                                        AS role`
    );
    const { forced, bypasses, scope, role } = diag[0];
    if (forced && !bypasses && !scope) {
      return {
        id: null,
        why:
          "row-level security hid every row: this connection has no app.business_id set and " +
          `the role "${role}" does not have BYPASSRLS. This is NOT ` +
          "\"there are no businesses\" — set BUSINESS_ID explicitly.",
      };
    }
    return { id: null, why: "there are genuinely no businesses in this database" };
  } catch (err) {
    return { id: null, why: `could not query the database: ${err.message}` };
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  let businessId = BUSINESS_ID;
  if (!businessId) {
    console.log("BUSINESS_ID not set; looking for the first business this connection can see...");
    const { id, why } = await getFirstBusinessId();
    businessId = id;
    if (!businessId) {
      console.error(`Could not pick a business: ${why}`);
      console.error("Set BUSINESS_ID to a business UUID and re-run.");
      process.exit(1);
    }
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

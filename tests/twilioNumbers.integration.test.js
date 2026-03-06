/**
 * Integration tests: real Twilio API for SEARCH only.
 * Buy is never called here; all purchase tests stay mocked in phone-numbers-api.test.js.
 *
 * Run with real Twilio credentials in .env (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN).
 * If either is missing, the whole suite is skipped.
 */
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { searchAvailableNumbers } from "../services/twilioNumbers.js";

const hasTwilioCreds =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN;

describe("twilioNumbers search (real Twilio)", () => {
  it.skipIf(!hasTwilioCreds)(
    "searchAvailableNumbers returns array from real Twilio",
    async () => {
      try {
        const result = await searchAvailableNumbers({
          country: "US",
          limit: 5,
        });

        console.log("searchAvailableNumbers (US, limit 5):", result.length, "numbers");
        result.forEach((n) => console.log("  ", n.phone_number, n.friendly_name, `(${n.locality}, ${n.region})`));

        expect(Array.isArray(result)).toBe(true);
        if (result.length > 0) {
          const first = result[0];
          expect(first).toHaveProperty("phone_number");
          expect(first).toHaveProperty("friendly_name");
          expect(first).toHaveProperty("locality");
          expect(first).toHaveProperty("region");
          expect(typeof first.phone_number).toBe("string");
          expect(first.phone_number).toMatch(/^\+/);
        }
      } catch (err) {
        if (err.message && err.message.includes("Test Account Credentials")) {
          console.log("Search not supported with Twilio test credentials; skipping.");
          return;
        }
        throw err;
      }
    }
  );

  it.skipIf(!hasTwilioCreds)(
    "searchAvailableNumbers with areaCode returns array from real Twilio",
    async () => {
      try {
        const result = await searchAvailableNumbers({
          country: "US",
          areaCode: "415",
          limit: 5,
        });

        console.log("searchAvailableNumbers (US, areaCode 415, limit 5):", result.length, "numbers");
        result.forEach((n) => console.log("  ", n.phone_number, n.friendly_name, `(${n.locality}, ${n.region})`));

        expect(Array.isArray(result)).toBe(true);
        result.forEach((n) => {
          expect(n).toHaveProperty("phone_number");
          expect(n.phone_number).toMatch(/^\+/);
        });
      } catch (err) {
        if (err.message && err.message.includes("Test Account Credentials")) {
          console.log("Search not supported with Twilio test credentials; skipping.");
          return;
        }
        throw err;
      }
    }
  );
});

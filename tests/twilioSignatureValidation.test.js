import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// THE ONE TEST FILE THAT DOES NOT TURN SIGNATURE VALIDATION OFF.
//
// Every other server test in this suite starts with
//
//   process.env.TWILIO_VALIDATE_SIGNATURE = "false";
//
// for perfectly good reasons — signature validation is orthogonal to what they
// are testing. The cost is that NOTHING exercised `twilioValidation`, and it was
// broken: `server.js` did `import * as twilio from "twilio"`, and because the
// package is CJS that namespace has the SDK's functions on `.default`, leaving
// `twilio.validateRequest` UNDEFINED. Every request carrying a signature threw a
// TypeError, which the central error handler turned into a 500.
//
// Nobody noticed because production ran with TWILIO_VALIDATE_SIGNATURE="false",
// so the function never executed. The moment it was switched on, every real call
// became "We are sorry, an application error has occurred. Goodbye."
//
// Measured on staging 2026-08-29, before the fix:
//   no signature      -> 403   (that branch returns BEFORE the broken call)
//   wrong signature   -> 500   <-- should be 403
//   correct signature -> 500   <-- should be 200
//
// THE POSITIVE CASE IS ASSERTED FIRST AND ON PURPOSE. This file already carries
// the scar of a validator that rejected every request for the life of a
// deployment while negative tests stayed green: "correctly refuses bad input"
// and "refuses everything" are the same suite without a positive case. Here the
// failure mode was the mirror image — it refused nothing and crashed instead —
// and only the 403-not-500 assertion distinguishes the two.
// ---------------------------------------------------------------------------

const AUTH_TOKEN = "test_auth_token_for_signature_validation";
const BASE = "https://example.test";

process.env.TWILIO_VALIDATE_SIGNATURE = "true";
process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
process.env.TWILIO_ACCOUNT_SID = "AC00000000000000000000000000000000";
process.env.BASE_URL = BASE;
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "not-a-real-key";

// Repointed from ../services/supabase.js during the dev -> gcp-2 port. That
// module does not exist on this lineage — it is services/db.js, rewritten
// against `pg` — so this mock was silently inert, mocking a path nothing
// imports.
//
// Checked rather than assumed: the test passes either way, with DATABASE_URL
// set or unset, because these five assertions never reach a database call. So
// this is dead weight removed and isolation restored for whatever is added to
// this file next, NOT a live bug fixed. Spread the original so an export
// server.js needs but this list omits does not become undefined.
vi.mock("../services/db.js", async (importOriginal) => ({
  ...(await importOriginal()),
  isEnabled: () => false,
  lookupBusinessByPhone: async () => null,
  loadConfig: () => null,
  completeCall: async () => {},
  fetchCallTranscript: async () => [],
  updateCallSummary: async () => {},
  updateCallLatency: async () => {},
  startCall: async () => {},
}));

vi.mock("../services/notifications.js", () => ({
  notifyCallMissed: async () => {},
  sendCallerSms: async () => {},
  notifyCallCompleted: async () => {},
  notifyAppointmentBooked: async () => {},
  isEmailConfigured: () => false,
  isSmsConfigured: () => false,
}));

/** Twilio's documented scheme: URL, then each POST param appended key+value in sorted key order. */
function twilioSignature(url, params, token = AUTH_TOKEN) {
  let payload = url;
  for (const key of Object.keys(params).sort()) payload += key + params[key];
  return crypto.createHmac("sha1", token).update(Buffer.from(payload, "utf-8")).digest("base64");
}

const PATH = "/twilio/voice";
const PARAMS = {
  CallSid: "CA00000000000000000000000000000001",
  From: "+15550000000",
  To: "+15550000001",
};

let app;
beforeAll(async () => {
  ({ app } = await import("../server.js"));
});

describe("twilio signature validation", () => {
  // FIRST, and deliberately: proof the middleware lets a genuine Twilio request
  // through. Without this, every assertion below is satisfied by a middleware
  // that rejects or crashes on absolutely everything.
  it("ACCEPTS a correctly signed request", async () => {
    const sig = twilioSignature(BASE + PATH, PARAMS);
    const res = await request(app).post(PATH).type("form").set("X-Twilio-Signature", sig).send(PARAMS);

    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Response>");
  });

  it("REFUSES a request with no signature, with 403", async () => {
    const res = await request(app).post(PATH).type("form").send(PARAMS);
    expect(res.status).toBe(403);
  });

  // THE REGRESSION GUARD FOR THE ACTUAL BUG. A wrong signature must be REFUSED,
  // not crashed on. Before the import fix this was a 500, and a 500 here is
  // indistinguishable from a 403 to anyone only asserting "not 200" — which is
  // exactly how it survived.
  it("REFUSES a wrongly signed request with 403, NOT 500", async () => {
    const res = await request(app)
      .post(PATH)
      .type("form")
      .set("X-Twilio-Signature", "AAAAAAAAAAAAAAAAAAAAAAAAAAA=")
      .send(PARAMS);

    expect(res.status).toBe(403);
    expect(res.status).not.toBe(500);
  });

  // A signature valid for a DIFFERENT url must not authorise this one, or the
  // whole scheme reduces to "carries any signature we once issued".
  it("REFUSES a signature computed over a different URL", async () => {
    const sig = twilioSignature("https://attacker.test" + PATH, PARAMS);
    const res = await request(app).post(PATH).type("form").set("X-Twilio-Signature", sig).send(PARAMS);
    expect(res.status).toBe(403);
  });

  // ⚠ THE SUITE CANNOT CATCH THE IMPORT BUG ITSELF, AND THAT IS WORTH KNOWING.
  //
  // Vitest resolves CJS through Vite's interop, which hoists named exports onto
  // the namespace; Node's native ESM does not. Measured 2026-08-29:
  //
  //   node  : (await import("twilio")).validateRequest  -> undefined
  //   vitest: (await import("twilio")).validateRequest  -> function
  //
  // So `import * as twilio` WORKS under test and FAILS in production, and the
  // four assertions above would all have passed against the broken code. They
  // are still worth having -- they pin the 403-not-500 contract -- but the thing
  // that actually catches this class of defect is running the built image, not
  // this file. See the ledger finding, and cloudbuild.yaml's smoke step which
  // imports the real module tree under real Node.
  //
  // What IS guarded here: the default export carries the function, so a change
  // that breaks THAT fails loudly.
  it("resolves validateRequest from the twilio default export", async () => {
    const twilio = (await import("twilio")).default;
    expect(typeof twilio.validateRequest).toBe("function");
  });
});

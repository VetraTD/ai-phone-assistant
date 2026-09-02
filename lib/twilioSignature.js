// A DEFAULT import, and it is load-bearing.
//
// `twilio` is a CommonJS package. Node's ESM interop puts only `default` on
// the namespace object, so `import * as twilio` gives an object where
// `twilio.validateRequest` is UNDEFINED. server.js did exactly that, and
// calling it threw a TypeError that the surrounding try/catch turned into
// `valid = false` — rejecting every request, including genuine ones from
// Twilio, silently, for the entire life of the deployment.
//
// tests/twilioSignature.test.js pins both halves of that: the namespace import
// does not expose it, the default import does, and server.js must not use the
// namespace form.
import twilio from "twilio";

// ---------------------------------------------------------------------------
// Twilio webhook signature verification.
//
// Extracted from server.js, and the extraction IS the fix for the second-order
// problem. The bug above survived because the middleware lived inside a file
// that boots a server, could not be imported by a test, and was therefore
// "tested" by scanning its source text for the presence of a try/catch. Those
// scans passed while the function they described rejected 100% of traffic.
//
// Three negative tests — no signature, bogus signature, wrong-length signature
// — all returned the 403 they expected. They could not tell "correctly refuses
// bad input" apart from "refuses everything", because nothing ever asserted
// that a GOOD signature is accepted.
// ---------------------------------------------------------------------------

/**
 * Is this request genuinely from Twilio?
 *
 * Fails CLOSED on every uncertainty: no token, no signature, a malformed
 * signature, or an unexpected throw all return false. "Cannot verify" must
 * never mean "let it through".
 *
 * @param {object} args
 * @param {string|undefined} args.authToken - the auth token of the account that OWNS the number
 * @param {string|undefined} args.signature - the X-Twilio-Signature header
 * @param {string} args.url - the EXACT url Twilio requested, including scheme and host
 * @param {Record<string, unknown>} [args.params] - the parsed form body
 * @returns {boolean}
 */
export function verifyTwilioSignature({ authToken, signature, url, params }) {
  if (!authToken) return false;
  if (typeof signature !== "string" || signature === "") return false;

  // validateRequest compares with `crypto.timingSafeEqual`, which requires
  // equal-length buffers — so a signature of the wrong length RAISES rather
  // than returning false. The unhandled throw used to be a 500 where a 403
  // belonged, and the difference is not cosmetic: a 500 and a 403 are
  // distinguishable, so it told an attacker which of their guesses were
  // well-formed, and anyone could generate unbounded 500s on a public endpoint
  // by sending junk.
  //
  // A signature that cannot be parsed is not a different outcome from a
  // signature that does not match. Both are "not from Twilio".
  try {
    return twilio.validateRequest(authToken, signature, url, params || {}) === true;
  } catch {
    return false;
  }
}

/**
 * Is this request genuinely from Twilio, on ANY of the accounts we accept?
 *
 * ---------------------------------------------------------------------------
 * Why more than one token
 * ---------------------------------------------------------------------------
 *
 * There are two Twilio accounts, and only one of them has its auth token in
 * GCP's Secret Manager. A number on the other account cannot be signature-
 * validated at all with a single-token check -- which is exactly the corner
 * the speech-to-speech spike was backed into: it gave up on signatures and
 * gated its webhook on a secret URL path instead (backlog LVX3).
 *
 * That was defensible for a bare audio bridge that lived one day. It is not
 * defensible for a front-end with a database, a tenant lookup and appointment
 * writes behind it. Accepting a properly signed request from either account
 * keeps the guarantee while letting a number from either one be used.
 *
 * Same fail-closed rule as the single-token form, and one addition: an EMPTY
 * token list returns false rather than true. "Nothing configured to check
 * against" is a misconfiguration, and the failure mode of reading it as
 * "nothing to check" is an open webhook.
 *
 * @param {object} args
 * @param {Array<string|undefined>} args.authTokens - accounts whose signatures we accept
 * @param {string|undefined} args.signature - the X-Twilio-Signature header
 * @param {string} args.url - the EXACT url Twilio requested
 * @param {Record<string, unknown>} [args.params] - the parsed form body
 * @returns {boolean}
 */
export function verifyTwilioSignatureAny({ authTokens, signature, url, params }) {
  const tokens = (Array.isArray(authTokens) ? authTokens : [])
    .map((t) => (typeof t === "string" ? t.trim() : ""))
    .filter(Boolean);
  if (tokens.length === 0) return false;

  // Every token is tried, and the result is OR-ed without short-circuiting on
  // the comparison itself -- validateRequest already uses timingSafeEqual, and
  // the loop's own timing reveals only which account matched, never any part
  // of the secret.
  let ok = false;
  for (const authToken of tokens) {
    if (verifyTwilioSignature({ authToken, signature, url, params })) ok = true;
  }
  return ok;
}

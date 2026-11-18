import { describe, it, expect } from "vitest";
import twilio from "twilio";
import { verifyTwilioSignatureAny } from "../lib/twilioSignature.js";

// ---------------------------------------------------------------------------
// Two Twilio accounts, both properly signed.
//
// The spike could not validate signatures at all: its number was on account B,
// whose auth token GCP does not hold, and pushing a second Twilio credential
// into the UK project for a service that lived one day was not worth it. So
// the webhook was gated by a secret path segment and the URL became the
// credential -- recorded as backlog LVX3, and closed when the spike was
// deleted.
//
// The real front-end must not re-open it. It has a database, a tenant lookup
// and appointment writes behind it, which is a far worse thing to leave gated
// by URL secrecy than a bare audio bridge.
//
// The owner also needs to be able to test from account B on demand, because
// account A's numbers are not always to hand. Those two requirements are only
// compatible if validation accepts a signature from EITHER account -- so it
// tries each configured token and never falls through to unvalidated.
//
// ---------------------------------------------------------------------------
// The assertion that matters is the POSITIVE one
// ---------------------------------------------------------------------------
//
// server.js carries the scar in a comment: verifyTwilioSignature was broken
// for the life of a deployment and rejected EVERY request. Three negative
// tests passed. A source scan for the try/catch passed. Nothing ever asserted
// that a GOOD signature is ACCEPTED, and without that assertion "correctly
// refuses bad input" and "refuses everything" are the same test.
// ---------------------------------------------------------------------------

const URL_UNDER_TEST = "https://voice.example.com/twilio/live-voice";
const PARAMS = { CallSid: "CA123", From: "+447700900123", To: "+441372656055" };

const TOKEN_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** A genuine Twilio signature, produced by the vendor's own signer. */
function sign(token) {
  return twilio.getExpectedTwilioSignature(token, URL_UNDER_TEST, PARAMS);
}

describe("accepting a real signature", () => {
  it("ACCEPTS one signed with the first token", () => {
    expect(
      verifyTwilioSignatureAny({
        authTokens: [TOKEN_A, TOKEN_B],
        signature: sign(TOKEN_A),
        url: URL_UNDER_TEST,
        params: PARAMS,
      })
    ).toBe(true);
  });

  it("ACCEPTS one signed with the second token", () => {
    // Account B, on demand, properly signed. This is the requirement that
    // stops LVX3 being re-opened the next time a number is only available on
    // the other account.
    expect(
      verifyTwilioSignatureAny({
        authTokens: [TOKEN_A, TOKEN_B],
        signature: sign(TOKEN_B),
        url: URL_UNDER_TEST,
        params: PARAMS,
      })
    ).toBe(true);
  });
});

describe("refusing everything else", () => {
  it("refuses a signature from an account that is not configured", () => {
    expect(
      verifyTwilioSignatureAny({
        authTokens: [TOKEN_A],
        signature: sign(TOKEN_B),
        url: URL_UNDER_TEST,
        params: PARAMS,
      })
    ).toBe(false);
  });

  it("refuses a signature for a different URL", () => {
    expect(
      verifyTwilioSignatureAny({
        authTokens: [TOKEN_A],
        signature: twilio.getExpectedTwilioSignature(TOKEN_A, "https://evil.example.com/twilio/live-voice", PARAMS),
        url: URL_UNDER_TEST,
        params: PARAMS,
      })
    ).toBe(false);
  });

  it("refuses when the body has been tampered with", () => {
    expect(
      verifyTwilioSignatureAny({
        authTokens: [TOKEN_A],
        signature: sign(TOKEN_A),
        url: URL_UNDER_TEST,
        params: { ...PARAMS, To: "+15550000000" },
      })
    ).toBe(false);
  });

  it("refuses when no tokens are configured, rather than passing everything", () => {
    // Fail closed. An empty token list is a misconfiguration, and the failure
    // mode of treating it as "nothing to check" is an open webhook.
    expect(
      verifyTwilioSignatureAny({ authTokens: [], signature: sign(TOKEN_A), url: URL_UNDER_TEST, params: PARAMS })
    ).toBe(false);
  });

  it("refuses a missing signature", () => {
    expect(
      verifyTwilioSignatureAny({ authTokens: [TOKEN_A], signature: undefined, url: URL_UNDER_TEST, params: PARAMS })
    ).toBe(false);
  });

  it("ignores blank entries in the token list", () => {
    // TWILIO_AUTH_TOKEN_ALT is unset in most environments and arrives as "".
    // An empty token must not be tried, and must not disable the real one.
    expect(
      verifyTwilioSignatureAny({
        authTokens: ["", TOKEN_A, undefined],
        signature: sign(TOKEN_A),
        url: URL_UNDER_TEST,
        params: PARAMS,
      })
    ).toBe(true);
  });
});

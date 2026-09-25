// ---------------------------------------------------------------------------
// THE REQUESTS scripts/live-call-harness.js SENDS, built without sending them.
//
// Pure: no socket, no clock, no environment read. The harness decides the
// values (which base, which token, which CallSid) and this module turns them
// into the exact `fetch(url, init)` arguments. Two reasons it is a module of
// its own rather than lines inside the script:
//
//   1. The INBOUND answer request must stay byte-identical to what the harness
//      sent before the outbound mode existed (Task 15, session 2b). A request
//      built inline in a script that exits on import cannot be compared with
//      anything; one built here can, and tests/outboundHarnessRequests.test.js
//      compares it against the old construction, verbatim.
//   2. The OUTBOUND requests are the ones the free end-to-end test
//      (tests/liveOutboundHarness.test.js) drives the real door routes with,
//      so the CLI and the test cannot drift apart: a signature the door would
//      refuse fails there first, for nothing.
//
// Every request is signed the way Twilio signs it: HMAC over the EXACT url
// (scheme, host, path) plus the sorted form params. The server recomputes it
// against BASE_URL + originalUrl, so `base` must equal the server's BASE_URL.
// ---------------------------------------------------------------------------
import twilio from "twilio";

export const TWILIO_API_VERSION = "2010-04-01";

export const OUTBOUND_ANSWER_PATH = "/twilio/outbound-answer";
export const OUTBOUND_STATUS_PATH = "/twilio/outbound-status";
export const OUTBOUND_AMD_PATH = "/twilio/outbound-amd";

/**
 * The two AMD verdicts the outbound harness will send. Everything else is
 * REFUSED: a `machine_*` or `fax` verdict makes the AMD door call Twilio's
 * REST API (a voicemail <Play> or a hang-up) on the CallSid -- and the
 * harness's CallSid is fake, so that is a real, paid, failing API call for
 * nothing (lib/outbound/doorRoutes.js, decideAmd's "voicemail"/"hangup").
 */
export const HARNESS_AMD_VERDICTS = Object.freeze(["human", "unknown"]);

/**
 * `--amd <value>`: null when absent, the value when it is one the harness may
 * send, and a THROW otherwise -- a refused verdict must stop the run before
 * anything is seeded or spent, never be quietly dropped.
 * @param {string|null|undefined} value
 * @returns {"human"|"unknown"|null}
 */
export function parseAmdFlag(value) {
  if (value === undefined || value === null || value === "") return null;
  if (HARNESS_AMD_VERDICTS.includes(value)) return value;
  throw new Error(
    `--amd ${JSON.stringify(value)} refused: the outbound harness sends only ${HARNESS_AMD_VERDICTS.join(" or ")}. ` +
      `A machine_* or fax verdict makes /twilio/outbound-amd call Twilio's REST API on a fake CallSid.`
  );
}

/**
 * A Twilio-signed form POST, as `fetch` arguments.
 *
 * Header order and the body encoding are part of the contract: this is the
 * construction the inbound harness has always used, lifted out unchanged.
 *
 * @param {string} url - the exact url, which is what the signature covers
 * @param {Record<string, string>} params
 * @param {string} authToken
 * @returns {{url: string, params: Record<string, string>, init: {method: "POST", headers: Record<string, string>, body: string}}}
 */
export function signedFormPost(url, params, authToken) {
  const signature = twilio.getExpectedTwilioSignature(authToken, url, params);
  return {
    url,
    params,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
      body: new URLSearchParams(params).toString(),
    },
  };
}

/**
 * The INBOUND webhook, exactly as the harness has always built it: POST
 * /twilio/live-voice, ringing, Direction=inbound. Byte-identical to the
 * construction it replaced (tests/outboundHarnessRequests.test.js).
 *
 * @param {{base: string, callSid: string, from: string, to: string, accountSid: string, authToken: string}} a
 */
export function buildInboundAnswerRequest({ base, callSid, from, to, accountSid, authToken }) {
  const url = `${base}/twilio/live-voice`;
  const params = {
    AccountSid: accountSid,
    CallSid: callSid,
    From: from,
    To: to,
    CallStatus: "ringing",
    Direction: "inbound",
    ApiVersion: TWILIO_API_VERSION,
  };
  return signedFormPost(url, params, authToken);
}

/**
 * The OUTBOUND answer: what Twilio requests on the `url` dispatch gave
 * calls.create, the instant the person picks up. From/To are the dial's own
 * -- From is OUR number (the campaign's caller_id), To is the person.
 *
 * @param {{base: string, callSid: string, callerId: string, contact: string, accountSid: string, authToken: string}} a
 */
export function buildOutboundAnswerRequest({ base, callSid, callerId, contact, accountSid, authToken }) {
  const params = {
    AccountSid: accountSid,
    CallSid: callSid,
    From: callerId,
    To: contact,
    CallStatus: "in-progress",
    Direction: "outbound-api",
    ApiVersion: TWILIO_API_VERSION,
  };
  return signedFormPost(`${base}${OUTBOUND_ANSWER_PATH}`, params, authToken);
}

/**
 * An outbound status callback (dispatch's statusCallback). `durationSeconds`
 * is sent only when given -- Twilio attaches CallDuration to the terminal
 * callback only.
 *
 * @param {{base: string, callSid: string, callerId: string, contact: string, accountSid: string, authToken: string, status: string, durationSeconds?: number|null}} a
 */
export function buildOutboundStatusRequest({ base, callSid, callerId, contact, accountSid, authToken, status, durationSeconds = null }) {
  const params = {
    AccountSid: accountSid,
    CallSid: callSid,
    From: callerId,
    To: contact,
    CallStatus: status,
    Direction: "outbound-api",
    ApiVersion: TWILIO_API_VERSION,
  };
  if (durationSeconds !== null && durationSeconds !== undefined) params.CallDuration = String(durationSeconds);
  return signedFormPost(`${base}${OUTBOUND_STATUS_PATH}`, params, authToken);
}

/**
 * An async AMD verdict (dispatch's asyncAmdStatusCallback). Refuses anything
 * but human/unknown, for the reason HARNESS_AMD_VERDICTS gives.
 *
 * @param {{base: string, callSid: string, accountSid: string, authToken: string, answeredBy: string, durationMs: number}} a
 */
export function buildOutboundAmdRequest({ base, callSid, accountSid, authToken, answeredBy, durationMs }) {
  const verdict = parseAmdFlag(answeredBy);
  if (!verdict) throw new Error("buildOutboundAmdRequest: answeredBy is required");
  const params = {
    AccountSid: accountSid,
    CallSid: callSid,
    AnsweredBy: verdict,
    MachineDetectionDuration: String(Math.round(durationMs)),
  };
  return signedFormPost(`${base}${OUTBOUND_AMD_PATH}`, params, authToken);
}

/**
 * Pull the stream URL and the <Parameter> values out of the TwiML.
 *
 * Returns null for any TwiML that is not a <Connect><Stream> -- the refusal and
 * the unrouted-voicemail branches are both valid answers and both mean the call
 * never reaches the assistant, so they are reported rather than parsed.
 *
 * Moved here unchanged from scripts/live-call-harness.js so the free outbound
 * test parses the door's TwiML with the harness's own parser.
 */
export function parseTwiml(xml) {
  const stream = xml.match(/<Stream\s+url="([^"]+)"/);
  if (!stream) return null;
  const customParameters = {};
  for (const m of xml.matchAll(/<Parameter\s+name="([^"]+)"\s+value="([^"]*)"\s*\/>/g)) {
    customParameters[m[1]] = m[2]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"');
  }
  return { url: stream[1], customParameters };
}

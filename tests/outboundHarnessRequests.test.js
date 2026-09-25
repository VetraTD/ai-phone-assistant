// tests/outboundHarnessRequests.test.js
/**
 * Task 15 (session 2b): the requests scripts/live-call-harness.js sends,
 * built by lib/probe/twilioRequests.js.
 *
 *   - INBOUND must not change. The inbound answer request is compared against
 *     the construction the harness used before the outbound mode existed,
 *     copied here VERBATIM (scripts/live-call-harness.js answerCall(), HEAD
 *     28c6bf7): same url, same method, same header order and values, same
 *     body bytes.
 *   - OUTBOUND requests carry what Twilio sends for an outbound-api call and
 *     verify under the server's own signature check (lib/twilioSignature.js)
 *     at BASE_URL + path -- the check twilioValidationAnyAccount runs.
 *   - A machine or fax AMD verdict is refused before it can be built.
 */
import { describe, it, expect, vi } from "vitest";
import twilio from "twilio";

vi.mock("../lib/logger.js", async (importOriginal) => ({
  ...(await importOriginal()),
  log: { debug: () => {}, info: () => {}, error: () => {} },
}));

import { resolveScriptLines, OUTBOUND_HELLO_LINES } from "../lib/probe/script.js";
import { verifyTwilioSignature } from "../lib/twilioSignature.js";
import {
  buildInboundAnswerRequest,
  buildOutboundAnswerRequest,
  buildOutboundStatusRequest,
  buildOutboundAmdRequest,
  parseAmdFlag,
  parseTwiml,
  HARNESS_AMD_VERDICTS,
} from "../lib/probe/twilioRequests.js";

const AUTH = "harness-requests-test-token";
const BASE = "http://localhost:3000";

/**
 * The inbound construction as it stood in scripts/live-call-harness.js before
 * Task 15 (answerCall, lines 340-358 at 28c6bf7), minus only the fetch() call
 * itself: the arguments it would have been given.
 */
function legacyInboundFetchArgs({ BASE, callSid, FROM, TO, accountSid, AUTH_TOKEN }) {
  const url = `${BASE}/twilio/live-voice`;
  const params = {
    AccountSid: accountSid,
    CallSid: callSid,
    From: FROM,
    To: TO,
    CallStatus: "ringing",
    Direction: "inbound",
    ApiVersion: "2010-04-01",
  };
  const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  return [
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
      body: new URLSearchParams(params).toString(),
    },
  ];
}

describe("inbound: the answer request is byte-identical to the pre-Task-15 construction", () => {
  const cases = [
    { BASE, callSid: "CA18f2a3b4c5d6e7f8", FROM: "+15551230000", TO: "+15550000000", accountSid: "ACharness0000000000000000000000000", AUTH_TOKEN: AUTH },
    { BASE: "https://host.example", callSid: "CAabc", FROM: "+447700900555", TO: "+441372656055", accountSid: "AC123", AUTH_TOKEN: "other token" },
    // Characters URLSearchParams and the signature both have to agree on.
    { BASE: "https://h.example/x", callSid: "CA+&=?", FROM: "+1 (555) 123", TO: "a&b=c", accountSid: "AC ü é", AUTH_TOKEN: "t" },
  ];

  it.each(cases)("url, method, header order and values, and body bytes all match (%#)", (c) => {
    const [legacyUrl, legacyInit] = legacyInboundFetchArgs(c);
    const req = buildInboundAnswerRequest({
      base: c.BASE,
      callSid: c.callSid,
      from: c.FROM,
      to: c.TO,
      accountSid: c.accountSid,
      authToken: c.AUTH_TOKEN,
    });
    expect(req.url).toBe(legacyUrl);
    // JSON.stringify compares key ORDER too, which a deep-equal would not.
    expect(JSON.stringify(req.init)).toBe(JSON.stringify(legacyInit));
    expect(Buffer.from(req.init.body)).toEqual(Buffer.from(legacyInit.body));
  });
});

describe("outbound: the answer, status and AMD requests", () => {
  const base = { base: BASE, callSid: "CAharness0001", accountSid: "ACharness", authToken: AUTH };
  const verifies = (req) =>
    verifyTwilioSignature({
      authToken: AUTH,
      signature: req.init.headers["X-Twilio-Signature"],
      url: req.url,
      params: Object.fromEntries(new URLSearchParams(req.init.body)),
    });

  it("the answer: POST /twilio/outbound-answer, Direction=outbound-api, From = OUR number, To = the person", () => {
    const req = buildOutboundAnswerRequest({ ...base, callerId: "+447700900101", contact: "+447700900202" });
    expect(req.url).toBe(`${BASE}/twilio/outbound-answer`);
    expect(req.params).toEqual({
      AccountSid: "ACharness",
      CallSid: "CAharness0001",
      From: "+447700900101",
      To: "+447700900202",
      CallStatus: "in-progress",
      Direction: "outbound-api",
      ApiVersion: "2010-04-01",
    });
    expect(req.init.method).toBe("POST");
    expect(verifies(req)).toBe(true);
  });

  it("a signature for one url does not verify at another (the BASE_URL mismatch that reads as a dead route)", () => {
    const req = buildOutboundAnswerRequest({ ...base, callerId: "+447700900101", contact: "+447700900202" });
    expect(
      verifyTwilioSignature({
        authToken: AUTH,
        signature: req.init.headers["X-Twilio-Signature"],
        url: "https://elsewhere.example/twilio/outbound-answer",
        params: req.params,
      })
    ).toBe(false);
  });

  it("status in-progress carries no CallDuration; completed carries it", () => {
    const inProgress = buildOutboundStatusRequest({ ...base, callerId: "+447700900101", contact: "+447700900202", status: "in-progress" });
    expect(inProgress.url).toBe(`${BASE}/twilio/outbound-status`);
    expect(inProgress.params.CallStatus).toBe("in-progress");
    expect(inProgress.params).not.toHaveProperty("CallDuration");
    expect(verifies(inProgress)).toBe(true);

    const completed = buildOutboundStatusRequest({ ...base, callerId: "+447700900101", contact: "+447700900202", status: "completed", durationSeconds: 21 });
    expect(completed.params).toMatchObject({ CallStatus: "completed", CallDuration: "21", Direction: "outbound-api" });
    expect(verifies(completed)).toBe(true);
  });

  it("AMD human/unknown build and verify; the duration is whole milliseconds", () => {
    for (const answeredBy of HARNESS_AMD_VERDICTS) {
      const req = buildOutboundAmdRequest({ ...base, answeredBy, durationMs: 2999.6 });
      expect(req.url).toBe(`${BASE}/twilio/outbound-amd`);
      expect(req.params).toEqual({ AccountSid: "ACharness", CallSid: "CAharness0001", AnsweredBy: answeredBy, MachineDetectionDuration: "3000" });
      expect(verifies(req)).toBe(true);
    }
  });

  it.each(["machine_end_beep", "machine_start", "machine_end_silence", "machine_end_other", "fax", "HUMAN", "garbage"])(
    "AMD %s is refused before anything is built -- a machine verdict would make the door call Twilio REST on a fake SID",
    (answeredBy) => {
      expect(() => parseAmdFlag(answeredBy)).toThrow(/refused/);
      expect(() => buildOutboundAmdRequest({ ...base, answeredBy, durationMs: 100 })).toThrow(/refused/);
    }
  );

  it("parseAmdFlag: absent is null (no AMD POST at all)", () => {
    expect(parseAmdFlag(undefined)).toBeNull();
    expect(parseAmdFlag("")).toBeNull();
    expect(parseAmdFlag("human")).toBe("human");
  });
});

describe("the outbound caller's line", () => {
  it("is one 'Hello?', synthesisable with --synth --script outbound_hello", () => {
    expect(resolveScriptLines("outbound_hello")).toBe(OUTBOUND_HELLO_LINES);
    expect(OUTBOUND_HELLO_LINES).toEqual([{ label: "outbound_hello", text: "Hello?" }]);
  });
});

describe("parseTwiml (moved unchanged from the harness)", () => {
  it("reads the stream url and unescapes every Parameter", () => {
    const xml =
      '<Response><Connect><Stream url="wss://h.example/twilio/live-stream/tok%2Fen">' +
      '<Parameter name="direction" value="outbound"/>' +
      '<Parameter name="businessPhone" value="a&amp;b &lt;c&gt; &quot;d&quot;" />' +
      "</Stream></Connect></Response>";
    expect(parseTwiml(xml)).toEqual({
      url: "wss://h.example/twilio/live-stream/tok%2Fen",
      customParameters: { direction: "outbound", businessPhone: 'a&b <c> "d"' },
    });
  });

  it("anything that is not a <Connect><Stream> is null", () => {
    expect(parseTwiml('<Response><Say voice="Polly.Amy">Sorry.</Say><Hangup/></Response>')).toBeNull();
  });
});

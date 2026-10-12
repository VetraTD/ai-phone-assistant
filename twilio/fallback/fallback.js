// Twilio Function: answers a phone number when our own server cannot.
//
// Paste this file into the Twilio console as a Function with "Protected"
// visibility. It must stay self-contained: no repo imports, no npm packages.
// The number's "Primary handler fails" (voice fallback) URL points at it, with
// query params n (number to ring, E.164), t (ring seconds, 20 or 45) and
// v (Polly voice). Env var VOICEMAIL_URL = https://<prod base>/twilio/voicemail.
//
// It rings the business's transfer number showing OUR number as caller ID. A
// call that comes back to us from ourselves (From === To) or from the dialled
// number (From === n) is a forward-back loop and is rejected.

// Copied byte-for-byte from CALL_LINES in lib/twiml.js. tests/twilioFallback.test.js
// asserts they are still equal.
const LINES = Object.freeze({
  noAnswer: "Sorry, nobody could get to the phone. Please leave your name, number and a short message after the tone.",
  technical: "I'm sorry, we're having a technical problem. Please leave your name, number and a short message after the tone, and the team will get back to you.",
});

// Last resort when even building TwiML threw. A static string, no dependencies.
const LAST_RESORT_TWIML =
  "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Say>" +
  "I'm sorry, we're having a technical problem. Please try again shortly." +
  "</Say><Hangup/></Response>";

function normaliseNumber(raw) {
  if (typeof raw !== "string") return null;
  // An unencoded + in a pasted URL arrives as a space.
  const n = (/^ \d/.test(raw) ? "+" + raw.slice(1) : raw).trim();
  return /^\+[1-9]\d{7,14}$/.test(n) ? n : null;
}

function normaliseVoice(raw) {
  return typeof raw === "string" && /^Polly\.[A-Za-z]+(-Neural)?$/.test(raw) ? raw : null;
}

function str(v) {
  return typeof v === "string" ? v : "";
}

function buildFallbackTwiml(event, context, VoiceResponse) {
  event = event || {};
  context = context || {};
  const response = new VoiceResponse();
  const n = normaliseNumber(event.n);
  const ringSec = event.t === "45" ? 45 : 20;
  const voice = normaliseVoice(event.v);
  const step = str(event.step);
  const domain = str(context.DOMAIN_NAME);
  const base = domain ? "https://" + domain + "/fallback" : "fallback";
  const voicemailUrl = str(context.VOICEMAIL_URL);

  const message = (line) => {
    if (voice) response.say({ voice }, line);
    else response.say(line);
    const attrs = {
      maxLength: 120,
      playBeep: true,
      action: base + "?step=done",
      method: "POST",
    };
    if (voicemailUrl) {
      attrs.recordingStatusCallback = voicemailUrl + "?to=" + encodeURIComponent(str(event.To));
    }
    response.record(attrs);
    response.hangup();
    return response;
  };

  if (step === "done") {
    response.hangup();
    return response;
  }

  if (step === "after") {
    if (event.DialCallStatus === "completed") {
      response.hangup();
      return response;
    }
    return message(LINES.noAnswer);
  }

  // First request. A call from a number to itself, or from the number we were
  // about to ring, is a loop.
  if (event.From === event.To || (n && event.From === n)) {
    response.reject({ reason: "busy" });
    return response;
  }
  if (!n) return message(LINES.technical);

  const after = new URLSearchParams({ step: "after", n, t: String(ringSec) });
  if (voice) after.set("v", voice);
  const dial = response.dial({
    timeout: ringSec,
    timeLimit: 3600,
    callerId: event.To,
    action: base + "?" + after.toString(),
    method: "POST",
  });
  dial.number(n);
  return response;
}

function handler(context, event, callback) {
  let twiml;
  try {
    twiml = buildFallbackTwiml(event, context, Twilio.twiml.VoiceResponse);
  } catch (err) {
    twiml = LAST_RESORT_TWIML;
  }
  callback(null, twiml);
}

module.exports = { buildFallbackTwiml, handler, LINES };

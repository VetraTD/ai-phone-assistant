// Twilio Function: answers a phone number when our own server cannot.
//
// Paste this file into the Twilio console as a Function with "Protected"
// visibility. It must stay self-contained: no repo imports, no npm packages.
// The number's "Primary handler fails" (voice fallback) URL points at it, with
// query params n (number to ring, E.164), t (ring seconds, 20 or 45),
// v (Polly voice) and, optionally, a (asset prefix, LVX174): with a=kore-en-gb
// the lines play the receptionist-voice clips uploaded to this Service as PUBLIC
// Assets kore-en-gb-noanswer.wav and kore-en-gb-technical.wav (served from this
// Service's own domain, so nothing depends on our server); without it, or with
// no DOMAIN_NAME, Polly says them as before.
// Env var VOICEMAIL_URL = https://<prod base>/twilio/voicemail.
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

// LVX174: lowercase letters, digits and hyphens only -- it becomes part of a URL.
function normaliseAsset(raw) {
  return typeof raw === "string" && /^[a-z0-9-]{1,40}$/.test(raw) ? raw : null;
}

function normaliseVoice(raw) {
  return typeof raw === "string" && /^Polly\.[A-Za-z]+(-Neural)?$/.test(raw) ? raw : null;
}

// Our own number as Twilio sends it in To. Anything else (missing, empty, an
// array) means we cannot show our number as caller ID, so we never Dial.
function normaliseTo(raw) {
  return typeof raw === "string" && /^\+[1-9]\d{6,14}$/.test(raw) ? raw : null;
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
  const asset = normaliseAsset(event.a);
  const step = str(event.step);
  const domain = str(context.DOMAIN_NAME);
  const to = normaliseTo(event.To);
  // The runtime's own path, so the Function works wherever the owner created it.
  let path = str(context.PATH) || "/fallback";
  if (path[0] !== "/") path = "/" + path;
  // Without DOMAIN_NAME (local use only) the URL is relative to the current one,
  // so the last path segment is what resolves correctly.
  const base = domain ? "https://" + domain + path : path.split("/").pop() || "fallback";
  const voicemailUrl = str(context.VOICEMAIL_URL);

  const message = (line, key) => {
    if (asset && domain) response.play("https://" + domain + "/" + asset + "-" + key.toLowerCase() + ".wav");
    else if (voice) response.say({ voice }, line);
    else response.say(line);
    const attrs = {
      maxLength: 120,
      playBeep: true,
      action: base + "?step=done",
      method: "POST",
    };
    if (voicemailUrl) {
      // With no valid To the callback is kept without ?to=: /twilio/voicemail
      // has no business to resolve (Twilio's recording-status callback carries
      // no To), so it takes the degraded_voicemail_no_business branch and logs
      // the recording URL; the after-outage check in the runbook finds it.
      attrs.recordingStatusCallback = voicemailUrl + (to ? "?to=" + encodeURIComponent(to) : "");
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
    return message(LINES.noAnswer, "noAnswer");
  }

  // First request. Without a valid To we cannot set our number as caller ID, and
  // Twilio would show the caller's: take a message instead of dialling.
  if (!to) return message(LINES.technical, "technical");

  // A call from a number to itself, or from the number we were about to ring, is
  // a loop.
  if (event.From === event.To || (n && event.From === n)) {
    response.reject({ reason: "busy" });
    return response;
  }
  if (!n) return message(LINES.technical, "technical");

  const after = new URLSearchParams({ step: "after", n, t: String(ringSec) });
  if (voice) after.set("v", voice);
  if (asset) after.set("a", asset);
  const dial = response.dial({
    timeout: ringSec,
    timeLimit: 3600,
    callerId: to,
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
    // Send the last resort as text/xml when the runtime lets us; a bare string's
    // Content-Type is up to the runtime.
    try {
      const r = new Twilio.Response();
      r.appendHeader("Content-Type", "text/xml");
      r.setBody(LAST_RESORT_TWIML);
      twiml = r;
    } catch (err2) {
      twiml = LAST_RESORT_TWIML;
    }
  }
  callback(null, twiml);
}

module.exports = { buildFallbackTwiml, handler, LINES };

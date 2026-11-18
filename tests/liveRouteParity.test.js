import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// A STRUCTURAL parity check, and its limits are stated up front because this
// file is the exact shape of test this repository has already been burned by.
//
// server.js boots a server at import, so its routes cannot be exercised from a
// unit test. What that led to once: verifyTwilioSignature was broken for the
// life of a deployment and rejected EVERY request, while three negative tests
// and a scan of this same file for the presence of a try/catch all passed.
//
// So: this proves the Live route CALLS the same gates the cascade route calls.
// It cannot prove those gates work. That is why callerAllowed, the unrouted
// refusal and signature verification each have their own behavioural tests
// (tests/callerAllowlist.test.js, tests/liveSignature.test.js), and why this
// asserts nothing about behaviour.
//
// What it does catch, which nothing else does: a second front-end that quietly
// skips a control the first one applies. That is precisely what happened --
// /twilio/live-voice had no allowlist check and no unrouted refusal, so
// dialling it instead of /twilio/voice walked past both.
// ---------------------------------------------------------------------------

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

/** The body of one `app.post("<route>", ...)` handler, to its closing `});`. */
function handlerBody(route) {
  const start = SERVER.indexOf(`app.post("${route}"`);
  expect(start, `${route} route not found`).toBeGreaterThan(-1);
  const end = SERVER.indexOf("\n});", start);
  return SERVER.slice(start, end);
}

describe("the Live route applies the controls the cascade route applies", () => {
  const live = handlerBody("/twilio/live-voice");

  it("checks the caller allowlist", () => {
    // On staging this is what keeps the environment from holding data about
    // someone who did not mean to reach it. A second entry point that skips it
    // does not weaken the control, it removes it.
    expect(live).toContain("callerAllowed(");
    expect(live).toContain("CALLER_ALLOWLIST");
  });

  it("refuses a number that routes to no business", () => {
    // Otherwise lookupBusinessByPhone returns null, loadConfig(null) yields a
    // generic config, and an unrouted number is answered by an assistant
    // calling itself "our office" -- the phone-number routing bug, again.
    expect(live).toContain("lookupBusinessByPhone");
    expect(live).toContain("buildUnroutedVoicemailTwiml");
  });

  it("distinguishes a lookup that failed from one that found nothing", () => {
    // A database blip must not turn a real business's calls into voicemail.
    expect(live).toContain("lookupFailed");
  });

  it("mints a per-call stream token", () => {
    expect(live).toContain("mintMediaStreamToken");
  });

  it("validates the Twilio signature, accepting either account", () => {
    expect(SERVER).toContain('app.post("/twilio/live-voice", twilioValidationAnyAccount');
  });
});

describe("the call lifecycle callback accepts either Twilio account", () => {
  // /twilio/status is NOT a front-end route. It is what sets a call's status
  // and duration and triggers the summary, so it has to work for every number
  // the platform serves, whoever owns it.
  //
  // LVX14 accepted that account B's callbacks 403 here, on the stated grounds
  // that "a Live call never reaches /twilio/status in a useful way anyway
  // (LVX30)". LVX30 was fixed on 2026-09-08 and that sentence stopped being
  // true. Measured the same evening: a real call on +18176011171 wrote 21
  // transcript rows and then stuck at in-progress with no duration and no
  // summary, because this callback was refused.
  it("uses the multi-account validator, not the single-token one", () => {
    expect(SERVER).toContain('app.post("/twilio/status", twilioValidationAnyAccount');
    expect(SERVER).not.toContain('app.post("/twilio/status", twilioValidation,');
  });

  it("reads both tokens", () => {
    expect(SERVER).toContain("TWILIO_AUTH_TOKEN_ALT");
  });
});

describe("the cascade route is unchanged by any of this", () => {
  it("still validates with the single-token middleware", () => {
    // Widening what the mature route accepts, for the benefit of a route it
    // does not use, is not a trade worth making.
    expect(SERVER).toContain('app.post("/twilio/voice", twilioValidation,');
  });

  it("keeps its own allowlist and unrouted checks", () => {
    const cascade = handlerBody("/twilio/voice");
    expect(cascade).toContain("callerAllowed(");
    expect(cascade).toContain("buildUnroutedVoicemailTwiml");
  });
});

describe("the websocket upgrade cannot leak a socket", () => {
  it("handles a failed lazy import instead of rejecting the listener", () => {
    // A module that throws at load would otherwise reject the async 'upgrade'
    // listener: no 403 written, no socket.destroy(), and the client sits on a
    // half-open connection until it times out -- one leaked socket per attempt.
    const branch = SERVER.slice(SERVER.indexOf("LIVE_WS_PATH}/`)"), SERVER.indexOf("PROBE_WS_PATH ||"));
    expect(branch).toContain("live_module_load_failed");
    expect(branch).toContain("socket.destroy()");
  });
});

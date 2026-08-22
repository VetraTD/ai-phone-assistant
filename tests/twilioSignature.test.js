import { describe, it, expect, vi } from "vitest";
import twilio from "twilio";
import { verifyTwilioSignature } from "../lib/twilioSignature.js";

// ---------------------------------------------------------------------------
// The test that did not exist, which is why the bug survived.
//
// server.js did `import * as twilio from "twilio"`. The package is CommonJS,
// so Node's ESM interop puts ONLY `default` on the namespace object —
// `twilio.validateRequest` is `undefined`. Calling it throws a TypeError, and
// the try/catch added to turn a malformed signature into a clean rejection
// swallowed that TypeError into `valid = false`.
//
// Result: EVERY signature was rejected, including genuine ones from Twilio.
// The webhook could never have worked on this deployment.
//
// It survived because the only tests were source-scanning ones asserting that
// bad signatures are refused — and bad signatures WERE refused, for entirely
// the wrong reason. Three negative tests passed while the positive path was
// dead. A gate that cannot distinguish "correctly rejects bad input" from
// "rejects everything" is not testing the thing it claims to.
//
// So the first test here is the positive one.
// ---------------------------------------------------------------------------

const TOKEN = "a".repeat(32);
const WEBHOOK_URL = "https://voice-us-staging.example.run.app/twilio/voice";
const PARAMS = { From: "+14695550001", To: "+18175550002", CallSid: "CA" + "1".repeat(32) };

/** A real Twilio signature over the same inputs. */
function sign(token = TOKEN, url = WEBHOOK_URL, params = PARAMS) {
  return twilio.getExpectedTwilioSignature(token, url, params);
}

describe("verifyTwilioSignature", () => {
  it("ACCEPTS a correctly signed request", () => {
    // The whole bug, in one assertion. Without it, a middleware that rejects
    // 100% of traffic looks identical to one that is working.
    expect(verifyTwilioSignature({
      authToken: TOKEN,
      signature: sign(),
      url: WEBHOOK_URL,
      params: PARAMS,
    })).toBe(true);
  });

  it("rejects a signature made with a different auth token", () => {
    expect(verifyTwilioSignature({
      authToken: TOKEN,
      signature: sign("b".repeat(32)),
      url: WEBHOOK_URL,
      params: PARAMS,
    })).toBe(false);
  });

  it("rejects a signature made over a different URL", () => {
    // Twilio signs the exact URL it requested. A proxy that rewrites the host
    // or scheme breaks this, which is why BASE_URL is used rather than a
    // reconstruction from request headers.
    expect(verifyTwilioSignature({
      authToken: TOKEN,
      signature: sign(TOKEN, "https://somewhere-else.example.com/twilio/voice"),
      url: WEBHOOK_URL,
      params: PARAMS,
    })).toBe(false);
  });

  it("rejects when a body parameter has been tampered with", () => {
    expect(verifyTwilioSignature({
      authToken: TOKEN,
      signature: sign(),
      url: WEBHOOK_URL,
      params: { ...PARAMS, From: "+19995550000" },
    })).toBe(false);
  });

  it("rejects a missing signature without throwing", () => {
    expect(verifyTwilioSignature({ authToken: TOKEN, signature: undefined, url: WEBHOOK_URL, params: PARAMS })).toBe(false);
    expect(verifyTwilioSignature({ authToken: TOKEN, signature: "", url: WEBHOOK_URL, params: PARAMS })).toBe(false);
  });

  it("rejects a MALFORMED signature without throwing — the 2026-08-21 fix, preserved", () => {
    // validateRequest compares with crypto.timingSafeEqual, which requires
    // equal-length buffers, so a wrong-length signature RAISES rather than
    // returning false. The unhandled throw was a 500 where a 403 belonged:
    // distinguishable from a clean rejection, so it told an attacker which
    // guesses were well-formed, and anyone could generate unbounded 500s on a
    // public endpoint with junk.
    for (const bad of ["x", "!!!!", "not-base64", "a".repeat(3), "z".repeat(200)]) {
      expect(() =>
        verifyTwilioSignature({ authToken: TOKEN, signature: bad, url: WEBHOOK_URL, params: PARAMS })
      ).not.toThrow();
      expect(verifyTwilioSignature({ authToken: TOKEN, signature: bad, url: WEBHOOK_URL, params: PARAMS })).toBe(false);
    }
  });

  it("rejects when no auth token is configured", () => {
    // Fails CLOSED. A deployment with no token cannot verify anything, and
    // "cannot verify" must never mean "let it through".
    expect(verifyTwilioSignature({ authToken: "", signature: sign(), url: WEBHOOK_URL, params: PARAMS })).toBe(false);
    expect(verifyTwilioSignature({ authToken: undefined, signature: sign(), url: WEBHOOK_URL, params: PARAMS })).toBe(false);
  });

  it("tolerates a missing params object", () => {
    const sigNoParams = sign(TOKEN, WEBHOOK_URL, {});
    expect(verifyTwilioSignature({ authToken: TOKEN, signature: sigNoParams, url: WEBHOOK_URL, params: undefined })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The import shape itself, pinned.
// ---------------------------------------------------------------------------
describe("the twilio import shape that caused this", () => {
  // NOTE, and it is the reason this bug reached production:
  //
  // UNDER VITEST THE BUG IS INVISIBLE. Vite transforms CJS interop itself, so
  // inside this test runner `import * as twilio` DOES expose validateRequest.
  // Under plain Node — which is what the container runs — it does not. So no
  // amount of unit testing in this suite could have caught it, and asserting
  // the namespace shape from in here would assert Vite's behaviour rather than
  // production's.
  //
  // The check therefore runs in a real Node subprocess, and the source scan
  // below stops the pattern coming back.
  it("plain Node does NOT expose validateRequest on a namespace import", async () => {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", 'import * as ns from "twilio"; console.log(typeof ns.validateRequest);'],
      { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") }
    ).trim();
    expect(out).toBe("undefined");
  });

  it("plain Node DOES expose it on a default import — what the module uses", async () => {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", 'import d from "twilio"; console.log(typeof d.validateRequest);'],
      { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") }
    ).trim();
    expect(out).toBe("function");
  });

  // Both source scans exist because SABOTAGE PROVED THE BEHAVIOURAL TESTS
  // CANNOT CATCH THIS. Reintroducing `import * as twilio` in the module was
  // tried, and every behavioural test still passed — Vite's interop papers
  // over exactly the difference that breaks production. So the only defence
  // that works from in here is reading the source.
  it("lib/twilioSignature.js does not use a namespace import for twilio", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new globalThis.URL("../lib/twilioSignature.js", import.meta.url)), "utf8");
    expect(src).not.toMatch(/^import\s+\*\s+as\s+twilio\s+from\s+"twilio"/m);
    expect(src).toMatch(/^import\s+twilio\s+from\s+"twilio"/m);
  });

  it("server.js does not use a namespace import for twilio", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new globalThis.URL("../server.js", import.meta.url)), "utf8");
    // Anchored to the start of a line, and that is not fussiness: the comment
    // in server.js explaining this bug QUOTES the offending import, so an
    // unanchored scan matches the description rather than the defect. The same
    // trap as the byte-window scan in bootChecks.test.js — source-scanning
    // tests need to be precise about what they are looking at.
    expect(src).not.toMatch(/^import\s+\*\s+as\s+twilio\s+from\s+"twilio"/m);
  });
});

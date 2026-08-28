import { describe, it, expect } from "vitest";
import {
  mintMediaStreamToken,
  verifyMediaStreamToken,
  tokenFromPath,
  mediaStreamTokenRequired,
  mediaStreamTokenAvailable,
} from "../lib/mediaStreamToken.js";

// P10. /twilio/media-stream accepted ANY upgrade — no signature, no token —
// while /twilio/probe-stream beside it required one. Each accepted socket costs
// a Deepgram stream, Gemini turns and ElevenLabs synthesis, and ten of them
// exhaust the measured 10-concurrent ElevenLabs cap real callers share.
//
// THE FIRST TEST HERE IS THE POSITIVE ONE, deliberately. This repository has
// already shipped a signature validator that rejected EVERY request for the
// life of a deployment, with three negative tests and a source scan all green,
// because nothing asserted that a GOOD credential is ACCEPTED. "Correctly
// refuses bad input" and "refuses everything" are the same test suite without
// it.

const ENV = { TWILIO_AUTH_TOKEN: "a-twilio-auth-token" };

describe("media-stream token", () => {
  it("ACCEPTS a token it just minted, and recovers the call SID", () => {
    const token = mintMediaStreamToken("CA123", { env: ENV });
    expect(token).toBeTruthy();
    expect(verifyMediaStreamToken(token, { env: ENV })).toEqual({
      ok: true,
      callSid: "CA123",
      reason: null,
    });
  });

  it("refuses a token with no signature at all", () => {
    expect(verifyMediaStreamToken("9999999999.CA123", { env: ENV }).ok).toBe(false);
    expect(verifyMediaStreamToken("", { env: ENV })).toEqual({ ok: false, callSid: null, reason: "missing" });
    expect(verifyMediaStreamToken(null, { env: ENV }).reason).toBe("missing");
  });

  it("refuses a forged signature", () => {
    const token = mintMediaStreamToken("CA123", { env: ENV });
    const forged = token.replace(/\.[^.]+$/, ".notarealsignature");
    expect(verifyMediaStreamToken(forged, { env: ENV }).reason).toBe("bad_signature");
  });

  // The attack the expiry field exists for: take a real token and extend it.
  it("refuses a token whose expiry was edited, because the expiry is signed", () => {
    const token = mintMediaStreamToken("CA123", { env: ENV });
    const [, callSid, sig] = token.split(".");
    const extended = `${Math.floor(Date.now() / 1000) + 999_999}.${callSid}.${sig}`;
    expect(verifyMediaStreamToken(extended, { env: ENV }).reason).toBe("bad_signature");
  });

  // The attack the call-SID binding exists for. Without it, one valid token
  // authorises a session for any other call — and businessPhone arrives in
  // attacker-controlled customParameters.
  it("refuses a token whose call SID was swapped", () => {
    const token = mintMediaStreamToken("CA123", { env: ENV });
    const [exp, , sig] = token.split(".");
    expect(verifyMediaStreamToken(`${exp}.CAsomeoneelse.${sig}`, { env: ENV }).reason).toBe("bad_signature");
  });

  it("refuses an expired token", () => {
    const token = mintMediaStreamToken("CA123", { env: ENV, ttlSeconds: 60 });
    const later = Date.now() + 61_000;
    expect(verifyMediaStreamToken(token, { env: ENV, now: later }).reason).toBe("expired");
    // And still accepts it inside the window, or "expired" would be hiding a
    // token that never worked at all.
    expect(verifyMediaStreamToken(token, { env: ENV, now: Date.now() + 30_000 }).ok).toBe(true);
  });

  it("refuses a token signed with a different key", () => {
    const token = mintMediaStreamToken("CA123", { env: { TWILIO_AUTH_TOKEN: "someone-elses-token" } });
    expect(verifyMediaStreamToken(token, { env: ENV }).reason).toBe("bad_signature");
  });

  // Fail closed, matching twilioValidation: a deployment that cannot verify
  // refuses rather than waving everything through.
  it("refuses everything when no signing key exists", () => {
    const token = mintMediaStreamToken("CA123", { env: ENV });
    expect(verifyMediaStreamToken(token, { env: {} })).toEqual({
      ok: false,
      callSid: null,
      reason: "no_key",
    });
    expect(mediaStreamTokenAvailable({})).toBe(false);
    expect(mediaStreamTokenAvailable(ENV)).toBe(true);
  });

  // MEDIA_STREAM_SECRET exists so the credential can be rotated without
  // touching the Twilio one. If it did not actually take precedence it would be
  // a rotation that silently did nothing.
  it("MEDIA_STREAM_SECRET overrides the derived Twilio key", () => {
    const override = { ...ENV, MEDIA_STREAM_SECRET: "rotated" };
    const token = mintMediaStreamToken("CA123", { env: override });
    expect(verifyMediaStreamToken(token, { env: override }).ok).toBe(true);
    expect(verifyMediaStreamToken(token, { env: ENV }).ok).toBe(false);
  });

  // The signing key must not be the Twilio auth token itself — a leak of one
  // should not hand over the other.
  it("does not sign with the raw auth token", () => {
    const token = mintMediaStreamToken("CA123", { env: ENV });
    expect(token).not.toContain(ENV.TWILIO_AUTH_TOKEN);
  });

  it("refuses a call SID that could move the field boundary", () => {
    expect(() => mintMediaStreamToken("CA.123", { env: ENV })).toThrow(/unusable call SID/);
    expect(() => mintMediaStreamToken("CA/123", { env: ENV })).toThrow(/unusable call SID/);
  });
});

describe("tokenFromPath", () => {
  const BASE = "/twilio/media-stream";

  it("reads the token out of the path", () => {
    expect(tokenFromPath(`${BASE}/abc.def.ghi`, BASE)).toBe("abc.def.ghi");
  });

  // The whole reason the token is in the path: Twilio does not carry a
  // <Stream url="..."> query string through to the websocket handshake, so a
  // ?token= form arrives empty. A bare path must therefore yield nothing.
  it("returns null for the bare path, which is what an unauthenticated upgrade looks like", () => {
    expect(tokenFromPath(BASE, BASE)).toBeNull();
    expect(tokenFromPath(`${BASE}/`, BASE)).toBeNull();
  });

  it("survives percent-encoding and refuses a malformed escape", () => {
    expect(tokenFromPath(`${BASE}/${encodeURIComponent("a.b.c/d")}`, BASE)).toBe("a.b.c/d");
    expect(tokenFromPath(`${BASE}/%E0%A4%A`, BASE)).toBeNull();
  });
});

describe("mediaStreamTokenRequired", () => {
  it("is on by default, and off only via the same switch as signature validation", () => {
    expect(mediaStreamTokenRequired({})).toBe(true);
    expect(mediaStreamTokenRequired({ TWILIO_VALIDATE_SIGNATURE: "true" })).toBe(true);
    expect(mediaStreamTokenRequired({ TWILIO_VALIDATE_SIGNATURE: "false" })).toBe(false);
  });
});

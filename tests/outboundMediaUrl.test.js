// tests/outboundMediaUrl.test.js
import { describe, it, expect } from "vitest";
import { signMediaUrl, verifyMediaUrl } from "../lib/outbound/mediaUrl.js";

// Task 12, spec §9.1 / plan C15. GET /media/outbound/:callSid/:kind.wav is the
// ONLY credential Twilio's <Play> fetch carries -- there is no Twilio
// signature on that request, so the URL itself has to prove it was minted by
// us, for this call, for this kind, before it expired.

const ENV = { TWILIO_AUTH_TOKEN: "a-twilio-auth-token" };
const BASE = "https://svc.example";

function parse(url) {
  const u = new URL(url);
  const [, , , callSid, kindFile] = u.pathname.split("/");
  return {
    callSid,
    kind: kindFile.replace(/\.wav$/, ""),
    exp: u.searchParams.get("exp"),
    sig: u.searchParams.get("sig"),
  };
}

describe("signMediaUrl", () => {
  it("returns the documented shape", () => {
    const url = signMediaUrl({ base: BASE, callSid: "CA123", kind: "voicemail", now: 1_700_000_000_000, env: ENV });
    expect(url).toMatch(/^https:\/\/svc\.example\/media\/outbound\/CA123\/voicemail\.wav\?exp=\d+&sig=[0-9a-f]+$/);
  });

  it("throws when no signing key is available (neither secret set)", () => {
    expect(() => signMediaUrl({ base: BASE, callSid: "CA123", kind: "voicemail", env: {} })).toThrow();
  });
});

describe("signMediaUrl / verifyMediaUrl round trip", () => {
  it("a URL signed and verified with the same inputs verifies", () => {
    const now = 1_700_000_000_000;
    const url = signMediaUrl({ base: BASE, callSid: "CA123", kind: "voicemail", now, env: ENV });
    const parts = parse(url);
    expect(verifyMediaUrl({ ...parts, now, env: ENV })).toEqual({ ok: true });
  });

  it("a URL signed for another CallSid does not verify", () => {
    const now = 1_700_000_000_000;
    const url = signMediaUrl({ base: BASE, callSid: "CA123", kind: "voicemail", now, env: ENV });
    const parts = parse(url);
    const verdict = verifyMediaUrl({ ...parts, callSid: "CAsomeoneelse", now, env: ENV });
    expect(verdict.ok).toBe(false);
  });

  it("a URL signed for another kind does not verify", () => {
    const now = 1_700_000_000_000;
    const url = signMediaUrl({ base: BASE, callSid: "CA123", kind: "voicemail", now, env: ENV });
    const parts = parse(url);
    const verdict = verifyMediaUrl({ ...parts, kind: "opener", now, env: ENV });
    expect(verdict.ok).toBe(false);
  });

  it("an expired URL does not verify, with reason 'expired'", () => {
    const now = 1_700_000_000_000;
    const url = signMediaUrl({ base: BASE, callSid: "CA123", kind: "voicemail", now, ttlSeconds: 600, env: ENV });
    const parts = parse(url);
    const later = now + 601_000;
    expect(verifyMediaUrl({ ...parts, now: later, env: ENV })).toEqual({ ok: false, reason: "expired" });
    // And still verifies inside the window, or "expired" would be hiding a URL that never worked.
    expect(verifyMediaUrl({ ...parts, now: now + 300_000, env: ENV }).ok).toBe(true);
  });

  it("a tampered exp does not verify", () => {
    const now = 1_700_000_000_000;
    const url = signMediaUrl({ base: BASE, callSid: "CA123", kind: "voicemail", now, env: ENV });
    const parts = parse(url);
    const tampered = { ...parts, exp: String(Number(parts.exp) + 999_999) };
    const verdict = verifyMediaUrl({ ...tampered, now, env: ENV });
    expect(verdict.ok).toBe(false);
  });

  it("with no key available (neither secret set), signing throws and verifying refuses", () => {
    const now = 1_700_000_000_000;
    const url = signMediaUrl({ base: BASE, callSid: "CA123", kind: "voicemail", now, env: ENV });
    const parts = parse(url);
    expect(verifyMediaUrl({ ...parts, now, env: {} })).toEqual({ ok: false, reason: "no_key" });
  });

  it("OUTBOUND_MEDIA_URL_SECRET overrides the base media-stream secret", () => {
    const now = 1_700_000_000_000;
    const overrideEnv = { ...ENV, OUTBOUND_MEDIA_URL_SECRET: "an-outbound-only-secret" };
    const url = signMediaUrl({ base: BASE, callSid: "CA123", kind: "voicemail", now, env: overrideEnv });
    const parts = parse(url);
    // Verifying with only the base secret (no override) must NOT accept it --
    // the override key is a different key, not a superset.
    expect(verifyMediaUrl({ ...parts, now, env: ENV }).ok).toBe(false);
    expect(verifyMediaUrl({ ...parts, now, env: overrideEnv }).ok).toBe(true);
  });

  it("binds callSid + kind + exp with a constant-time compare (a bad sig of the right length still refuses)", () => {
    const now = 1_700_000_000_000;
    const url = signMediaUrl({ base: BASE, callSid: "CA123", kind: "voicemail", now, env: ENV });
    const parts = parse(url);
    const forged = { ...parts, sig: parts.sig.slice(0, -1) + (parts.sig.at(-1) === "0" ? "1" : "0") };
    expect(verifyMediaUrl({ ...forged, now, env: ENV })).toEqual({ ok: false, reason: "bad_signature" });
  });

  // Fix round 1, item 3.
  describe("exp is a strict decimal string, signed verbatim (no reparse-and-reprint)", () => {
    it.each(["123abc", "12.5", "-5", "1e10", "0x10", " 123", "123 ", "", "1234567890123"])(
      "rejects a malformed exp %j as 'malformed'",
      (badExp) => {
        const now = 1_700_000_000_000;
        const url = signMediaUrl({ base: BASE, callSid: "CA123", kind: "voicemail", now, env: ENV });
        const parts = parse(url);
        expect(verifyMediaUrl({ ...parts, exp: badExp, now, env: ENV })).toEqual({ ok: false, reason: "malformed" });
      }
    );

    it("a leading-zero exp that parses to the SAME number as the real one does not verify (would if reparsed-and-reprinted)", () => {
      const now = 1_700_000_000_000;
      const url = signMediaUrl({ base: BASE, callSid: "CA123", kind: "voicemail", now, env: ENV });
      const parts = parse(url);
      const zeroPadded = `0${parts.exp}`;
      expect(verifyMediaUrl({ ...parts, exp: zeroPadded, now, env: ENV }).ok).toBe(false);
    });

    it("accepts a 12-digit exp and rejects a 13-digit one", () => {
      const now = 0;
      const url = signMediaUrl({ base: BASE, callSid: "CA123", kind: "voicemail", now, ttlSeconds: 0, env: ENV });
      const parts = parse(url);
      expect(parts.exp.length).toBeLessThanOrEqual(12);
      expect(verifyMediaUrl({ ...parts, exp: "1234567890123", now, env: ENV })).toEqual({ ok: false, reason: "malformed" });
    });
  });

  // Fix round 1, item 3: same rule mintMediaStreamToken applies to a call SID
  // (lib/mediaStreamToken.js:108-112) -- the separator and the path share a
  // character set.
  describe("callSid and kind reject '.', '/' and '\\\\' at both sign and verify time", () => {
    it.each(["CA123.wav", "CA/123", "CA\\123"])("signMediaUrl throws on an unsafe callSid %j", (badSid) => {
      expect(() => signMediaUrl({ base: BASE, callSid: badSid, kind: "voicemail", env: ENV })).toThrow();
    });

    it.each(["voice.mail", "voice/mail", "voice\\mail"])("signMediaUrl throws on an unsafe kind %j", (badKind) => {
      expect(() => signMediaUrl({ base: BASE, callSid: "CA123", kind: badKind, env: ENV })).toThrow();
    });

    it("verifyMediaUrl refuses an unsafe callSid or kind as 'malformed', even with a signature that would otherwise match", () => {
      const now = 1_700_000_000_000;
      const url = signMediaUrl({ base: BASE, callSid: "CA123", kind: "voicemail", now, env: ENV });
      const parts = parse(url);
      expect(verifyMediaUrl({ ...parts, callSid: "CA123/../etc", now, env: ENV })).toEqual({ ok: false, reason: "malformed" });
      expect(verifyMediaUrl({ ...parts, kind: "voice\\mail", now, env: ENV })).toEqual({ ok: false, reason: "malformed" });
    });
  });
});

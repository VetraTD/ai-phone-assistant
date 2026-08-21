import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A6's gate, stated in the ledger as:
//
//   "`hipaa` mode cannot construct a non-covered vendor client INCLUDING WITH
//    THE BREAKER OPEN"
//
// The breaker clause is the interesting half. lib/voice/ttsStream.js already
// has three ways to end up on a different TTS provider — a per-business
// voice_provider column, a `forceFallback` argument, and a circuit breaker
// that flips providers mid-call — so a guard placed at provider SELECTION is a
// guard with three doors beside it. These tests exercise the constructor
// directly, in every breaker state, because that is where the guard actually
// is and the point is that no state can route around it.

const ENV = ["DEPLOYMENT_MODE", "ELEVENLABS_API_KEY", "DEEPGRAM_API_KEY", "BREVO_API_KEY"];
const saved = {};

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.resetModules();
});

async function load(mode) {
  for (const k of ENV) delete process.env[k];
  if (mode) process.env.DEPLOYMENT_MODE = mode;
  vi.resetModules();
  return {
    compliance: await import("../lib/compliance.js"),
    elevenlabs: await import("../services/elevenlabs.js"),
  };
}

describe("hipaa mode refuses non-covered vendors at construction", () => {
  it("createTtsConnection throws instead of opening a socket", async () => {
    const { elevenlabs } = await load("hipaa");

    expect(() => elevenlabs.createTtsConnection({ voiceId: "v1" })).toThrow(/ElevenLabs/);
  });

  it("the refusal is typed, so a caller cannot mistake it for a vendor outage", async () => {
    const { elevenlabs, compliance } = await load("hipaa");

    try {
      elevenlabs.createTtsConnection({ voiceId: "v1" });
      throw new Error("should have refused");
    } catch (err) {
      // A generic Error here would land in the circuit breaker's retry logic
      // and turn a hard stop into a delay, which is exactly wrong.
      expect(err).toBeInstanceOf(compliance.ComplianceViolationError);
      expect(err.compliance).toBe(true);
      expect(err.vendor).toBe("elevenlabs");
    }
  });

  // The clause the gate calls out. The breaker's whole job is to change which
  // provider runs, so it is the most plausible way for a guard to be bypassed.
  it.each([
    ["breaker closed (healthy)", true],
    ["breaker OPEN (ElevenLabs failing)", false],
  ])("refuses with the %s", async (_label, healthy) => {
    for (const k of ENV) delete process.env[k];
    process.env.DEPLOYMENT_MODE = "hipaa";
    vi.resetModules();

    const { ttsHealth } = await import("../lib/voice/ttsHealth.js");
    if (healthy) ttsHealth.recordSuccess();
    else {
      ttsHealth.recordFailure(new Error("quota exceeded"));
      expect(ttsHealth.isHealthy()).toBe(false);
    }

    const { createTtsConnection } = await import("../services/elevenlabs.js");
    expect(() => createTtsConnection({ voiceId: "v1" })).toThrow(/ElevenLabs/);
  });

  it("refuses even when an API key is present — a key is not permission", async () => {
    for (const k of ENV) delete process.env[k];
    process.env.DEPLOYMENT_MODE = "hipaa";
    process.env.ELEVENLABS_API_KEY = "sk-a-real-looking-key";
    vi.resetModules();

    const { createTtsConnection } = await import("../services/elevenlabs.js");
    expect(() => createTtsConnection({ voiceId: "v1" })).toThrow(/ElevenLabs/);
  });

  // Targets lib/voice/sttStream.js, the LIVE speech path. It used to target
  // services/deepgram.js, which A10 left with no consumers when it deleted
  // lib/mediaStream.js — so the guard was being proven on dead code while the
  // path that actually runs went untested.
  it("refuses Deepgram on the live STT path", async () => {
    for (const k of ENV) delete process.env[k];
    process.env.DEPLOYMENT_MODE = "hipaa";
    process.env.DEEPGRAM_API_KEY = "dg-key";
    vi.resetModules();

    const { createSttStream } = await import("../lib/voice/sttStream.js");
    await expect(createSttStream({ language: "en-US", callSid: "CA1" })).rejects.toThrow(/Deepgram/);
  });
});

describe("standard mode is untouched", () => {
  it("does not refuse ElevenLabs", async () => {
    const { compliance } = await load(undefined);
    expect(() => compliance.assertVendorAllowed("elevenlabs")).not.toThrow();
    expect(compliance.isVendorAllowed("elevenlabs")).toBe(true);
  });

  it("does not refuse a vendor it has never heard of, in either mode", async () => {
    const { compliance } = await load("hipaa");
    // Fails open for unknown names on purpose: this list is about vendors we
    // have decided about. An unknown string is a typo at the call site, and
    // throwing on it would turn a typo into an outage without protecting
    // anything.
    expect(() => compliance.assertVendorAllowed("some-new-vendor")).not.toThrow();
  });
});

describe("effectiveTier — the ratchet only tightens", () => {
  it("a hipaa deployment stays hipaa whatever the tenant row says", async () => {
    const { compliance } = await load("hipaa");
    expect(compliance.effectiveTier({ compliance_tier: "standard" })).toBe("hipaa");
    expect(compliance.effectiveTier(null)).toBe("hipaa");
  });

  it("a hipaa TENANT on a standard deployment is treated as covered", async () => {
    const { compliance } = await load(undefined);
    expect(compliance.effectiveTier({ compliance_tier: "hipaa" })).toBe("hipaa");
  });

  it("standard everywhere is standard", async () => {
    const { compliance } = await load(undefined);
    expect(compliance.effectiveTier({ compliance_tier: "standard" })).toBe("standard");
    expect(compliance.effectiveTier({})).toBe("standard");
  });
});

describe("nonCoveredCredentialsPresent", () => {
  it("finds every non-covered credential that is set", async () => {
    const { compliance } = await load("hipaa");
    const found = compliance.nonCoveredCredentialsPresent({
      ELEVENLABS_API_KEY: "x",
      DEEPGRAM_API_KEY: "y",
      GOOGLE_APPLICATION_CREDENTIALS: "/covered/vendor.json",
    });
    expect(found.map((f) => f.vendor).sort()).toEqual(["deepgram", "elevenlabs"]);
  });

  it("treats an empty string as absent, not as a credential", async () => {
    const { compliance } = await load("hipaa");
    expect(compliance.nonCoveredCredentialsPresent({ ELEVENLABS_API_KEY: "  " })).toEqual([]);
  });

  it("says nothing about Google — Vertex, STT and TTS are all covered by the GCP BAA", async () => {
    const { compliance } = await load("hipaa");
    expect(Object.keys(compliance.NON_COVERED_VENDORS)).not.toContain("google");
  });
});

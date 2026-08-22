import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDeepgramFactory, mockGoogleFactory } = vi.hoisted(() => ({
  mockDeepgramFactory: vi.fn(async () => ({ provider: "deepgram" })),
  mockGoogleFactory: vi.fn(async () => ({ provider: "google" })),
}));

vi.mock("../lib/voice/sttDeepgram.js", async (importActual) => ({
  ...(await importActual()),
  createDeepgramSttStream: mockDeepgramFactory,
}));

vi.mock("../lib/voice/sttGoogle.js", () => ({
  createGoogleSttStream: mockGoogleFactory,
  assertSttEncryption: vi.fn(),
  googleSttEnvironment: vi.fn(),
}));

vi.mock("../lib/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const ENV = ["DEPLOYMENT_MODE", "DEEPGRAM_API_KEY", "GOOGLE_CLOUD_PROJECT", "STT_PROVIDER"];

/** Load sttStream.js fresh under a given deployment mode. */
async function load(mode, extra = {}) {
  for (const k of ENV) delete process.env[k];
  if (mode) process.env.DEPLOYMENT_MODE = mode;
  Object.assign(process.env, extra);
  vi.resetModules();
  return import("../lib/voice/sttStream.js");
}

describe("sttStream.js — provider selection follows the compliance tier", () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    mockDeepgramFactory.mockClear();
    mockGoogleFactory.mockClear();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  // -------------------------------------------------------------------------
  // The pure decision
  // -------------------------------------------------------------------------

  it("1. a standard deployment with a standard tenant uses Deepgram", async () => {
    const { sttProviderFor } = await load("standard");
    expect(sttProviderFor("standard")).toBe("deepgram");
  });

  it("2. a hipaa deployment uses Google, because no BAA covers Deepgram", async () => {
    const { sttProviderFor } = await load("hipaa");
    expect(sttProviderFor("standard")).toBe("google");
  });

  it("3. a hipaa TENANT on a standard deployment uses Google — the ratchet tightens", async () => {
    const { sttProviderFor } = await load("standard");
    // effectiveTier() already returns the stricter of deployment and tenant.
    // Selection has to honour that or a covered tenant's audio reaches a
    // vendor with no BAA on a stack that is otherwise fine.
    expect(sttProviderFor("hipaa")).toBe("google");
  });

  it("4. a standard TENANT cannot relax a hipaa deployment", async () => {
    const { sttProviderFor } = await load("hipaa");
    expect(sttProviderFor("standard")).toBe("google");
  });

  it("5. an env flag CANNOT put Deepgram back into a hipaa process", async () => {
    // The ledger's rule: select by lane, never by a flag someone can get
    // wrong. A deployment variable is exactly the thing that gets copied
    // between environments in a hurry.
    const { sttProviderFor } = await load("hipaa", { STT_PROVIDER: "deepgram" });
    expect(sttProviderFor("standard")).toBe("google");
  });

  // -------------------------------------------------------------------------
  // The dispatch
  // -------------------------------------------------------------------------

  it("6. createSttStream builds a Deepgram stream in standard mode", async () => {
    const { createSttStream } = await load("standard", { DEEPGRAM_API_KEY: "dg-key" });
    await createSttStream({ language: "en-US", callSid: "CA1" });

    expect(mockDeepgramFactory).toHaveBeenCalledTimes(1);
    expect(mockGoogleFactory).not.toHaveBeenCalled();
  });

  it("7. createSttStream builds a Google stream in hipaa mode", async () => {
    const { createSttStream } = await load("hipaa", { GOOGLE_CLOUD_PROJECT: "vetra-us-prod" });
    await createSttStream({ language: "en-US", callSid: "CA2" });

    expect(mockGoogleFactory).toHaveBeenCalledTimes(1);
    expect(mockDeepgramFactory).not.toHaveBeenCalled();
  });

  it("8. createSttStream routes a hipaa TENANT to Google on a standard deployment", async () => {
    const { createSttStream } = await load("standard", {
      DEEPGRAM_API_KEY: "dg-key",
      GOOGLE_CLOUD_PROJECT: "vetra-us-prod",
    });
    await createSttStream({ language: "en-US", callSid: "CA3", tier: "hipaa" });

    expect(mockGoogleFactory).toHaveBeenCalledTimes(1);
    expect(mockDeepgramFactory).not.toHaveBeenCalled();
  });

  it("9. the six provider-agnostic callbacks are forwarded unchanged", async () => {
    const { createSttStream } = await load("hipaa", { GOOGLE_CLOUD_PROJECT: "vetra-us-prod" });
    const cbs = {
      onFinal: vi.fn(),
      onInterim: vi.fn(),
      onUtteranceEnd: vi.fn(),
      onSpeechStarted: vi.fn(),
      onError: vi.fn(),
      onReconnect: vi.fn(),
    };

    await createSttStream({ language: "en-US", callSid: "CA4", keyterms: ["Acme"], ...cbs });

    const passed = mockGoogleFactory.mock.calls[0][0];
    for (const name of Object.keys(cbs)) expect(passed[name]).toBe(cbs[name]);
    expect(passed.language).toBe("en-US");
    expect(passed.keyterms).toEqual(["Acme"]);
    expect(passed.callSid).toBe("CA4");
  });

  it("10. `tier` is not leaked to the provider — it is a routing decision, not config", async () => {
    const { createSttStream } = await load("standard", { DEEPGRAM_API_KEY: "dg-key" });
    await createSttStream({ language: "en-US", callSid: "CA5", tier: "standard" });

    expect(mockDeepgramFactory.mock.calls[0][0]).not.toHaveProperty("tier");
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { liveSurface, createLiveClient, connectLive, LIVE_MODEL_DEFAULT } from "../lib/voice/live/client.js";

// ---------------------------------------------------------------------------
// The model is decided and the client is still swappable, and those are not in
// tension: gemini-3.1-flash-live-preview is the tier-1 choice AND it is a
// preview model that exists only on AI Studio. Vertex serves exactly one Live
// model (gemini-live-2.5-flash-native-audio) and answers "Publisher model not
// found" for 3.1 in all three regions.
//
// So the surface will move -- when 3.1 reaches GA on Vertex, the trade this
// decision cost (US transfer, no Cloud Audit Logs, no VPC-SC, no CMEK on the
// model leg) disappears and it becomes a config change. Section 6 asks for
// exactly one branch so that day is a variable, not a rewrite.
//
// The hipaa refusal is the other half. AI Studio is the Gemini Developer API,
// which is NOT a Google Cloud service, and the Google Cloud BAA covers Google
// Cloud services. services/gemini.js already refuses it at client construction
// for the cascade; this path must refuse in the same place, or the front-end
// becomes the door beside the guard.
// ---------------------------------------------------------------------------

/** A stand-in for GoogleGenAI that records how it was constructed. */
function fakeGenAI(onConnect) {
  const built = [];
  class Fake {
    constructor(opts) {
      built.push(opts);
      this.live = { connect: onConnect || (async () => ({ close() {} })) };
    }
  }
  return { Fake, built };
}

const AISTUDIO_ENV = { GEMINI_API_KEY: "k" };

afterEach(() => vi.unstubAllEnvs());

describe("surface selection", () => {
  it("defaults to AI Studio, because that is the only place tier 1 exists", () => {
    expect(liveSurface({})).toBe("aistudio");
  });

  it("switches to Vertex on one variable", () => {
    expect(liveSurface({ LIVE_SURFACE: "vertex" })).toBe("vertex");
  });

  it("treats an unrecognised value as AI Studio rather than throwing mid-call", () => {
    expect(liveSurface({ LIVE_SURFACE: "azure" })).toBe("aistudio");
  });
});

describe("client construction", () => {
  it("builds the AI Studio client from the key and nothing else", () => {
    const { Fake, built } = fakeGenAI();
    createLiveClient(AISTUDIO_ENV, { GenAI: Fake });

    expect(built).toHaveLength(1);
    expect(built[0]).toEqual({ apiKey: "k" });
  });

  it("builds the Vertex client from ADC, with no key anywhere in it", () => {
    // Vertex authenticates with Application Default Credentials -- on Cloud Run
    // the runtime service account's metadata token, which cannot be copied out
    // of the project the way an API key can.
    const { Fake, built } = fakeGenAI();
    createLiveClient(
      { LIVE_SURFACE: "vertex", GOOGLE_CLOUD_PROJECT: "vetra-uk-edc8ca", VERTEX_LOCATION: "europe-west1" },
      { GenAI: Fake }
    );

    expect(built[0].vertexai).toBe(true);
    expect(built[0].project).toBe("vetra-uk-edc8ca");
    expect(built[0].apiKey).toBeUndefined();
  });

  it("refuses AI Studio without a key instead of failing on the first turn", () => {
    const { Fake } = fakeGenAI();
    expect(() => createLiveClient({}, { GenAI: Fake })).toThrow(/GEMINI_API_KEY/);
  });

  it("refuses Vertex without a project rather than silently falling back to the key", () => {
    // The fallback would be the silent-failure class this codebase keeps
    // finding: the operator asked for the covered backend and would get the
    // uncovered one.
    const { Fake } = fakeGenAI();
    expect(() =>
      createLiveClient({ LIVE_SURFACE: "vertex", GEMINI_API_KEY: "k" }, { GenAI: Fake })
    ).toThrow(/GOOGLE_CLOUD_PROJECT/);
  });
});

describe("hipaa mode", () => {
  it("refuses to construct an AI Studio client", async () => {
    // IS_HIPAA_MODE is read at module load, so the module graph is rebuilt
    // with the env in place rather than poked afterwards.
    vi.resetModules();
    vi.stubEnv("DEPLOYMENT_MODE", "hipaa");
    const { createLiveClient: guarded } = await import("../lib/voice/live/client.js");
    const { Fake } = fakeGenAI();

    expect(() => guarded(AISTUDIO_ENV, { GenAI: Fake })).toThrow(/hipaa/i);
    vi.resetModules();
  });

  it("still allows Vertex, which the Google Cloud BAA covers", async () => {
    vi.resetModules();
    vi.stubEnv("DEPLOYMENT_MODE", "hipaa");
    const { createLiveClient: guarded } = await import("../lib/voice/live/client.js");
    const { Fake, built } = fakeGenAI();

    guarded(
      { LIVE_SURFACE: "vertex", GOOGLE_CLOUD_PROJECT: "p", VERTEX_LOCATION: "europe-west1" },
      { GenAI: Fake }
    );
    expect(built[0].vertexai).toBe(true);
    vi.resetModules();
  });
});

describe("connectLive", () => {
  it("passes the model and reports the language as pinned when connect succeeds", async () => {
    // en-GB was accepted on 9 of 9 spike calls, contradicting the vendor-doc
    // claim that native audio refuses a language code. Accepted is not
    // honoured, so the fact is RECORDED per call rather than assumed.
    const seen = [];
    const { Fake } = fakeGenAI(async (args) => {
      seen.push(args);
      return { close() {} };
    });

    const out = await connectLive({
      env: AISTUDIO_ENV,
      config: { responseModalities: ["AUDIO"], speechConfig: { languageCode: "en-GB", voiceConfig: {} } },
      callbacks: {},
      deps: { GenAI: Fake },
    });

    expect(seen[0].model).toBe(LIVE_MODEL_DEFAULT);
    expect(out.languagePinned).toBe(true);
  });

  it("retries without the language code if the vendor rejects it, rather than dropping the call", async () => {
    // 3.1 is a preview model. It will move, change, or be withdrawn, and a
    // config key it accepts today is not a config key it accepts forever.
    const attempts = [];
    const { Fake } = fakeGenAI(async (args) => {
      attempts.push(args.config);
      if (attempts.length === 1) throw new Error("Invalid value at speechConfig.languageCode");
      return { close() {} };
    });

    const out = await connectLive({
      env: AISTUDIO_ENV,
      config: { speechConfig: { languageCode: "en-GB", voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } },
      callbacks: {},
      deps: { GenAI: Fake },
    });

    expect(attempts).toHaveLength(2);
    expect(attempts[1].speechConfig.languageCode).toBeUndefined();
    // The voice survives the retry: dropping it would silently change how the
    // assistant sounds mid-incident.
    expect(attempts[1].speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Kore");
    expect(out.languagePinned).toBe(false);
  });

  it("does not retry an unrelated failure, so a real outage surfaces as itself", async () => {
    const { Fake } = fakeGenAI(async () => {
      throw new Error("503 Service Unavailable");
    });

    await expect(
      connectLive({ env: AISTUDIO_ENV, config: {}, callbacks: {}, deps: { GenAI: Fake } })
    ).rejects.toThrow(/503/);
  });
});

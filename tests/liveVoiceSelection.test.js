import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";

// ---------------------------------------------------------------------------
// WHICH VOICE a Live call is answered in, and where that choice came from.
//
// The LANGUAGE became tenant-aware on 2026-09-04 (tests/liveLanguage.test.js).
// The VOICE NAME did not: it was one module-scope constant for every tenant on
// the platform, so a UK demo tenant and an American dental practice were
// answered by the same voice whatever their locale said.
//
// TWO defects, and the second is why the first had no test.
//
// LVX13: `LIVE_VOICE` and `LIVE_LANGUAGE_CODE` were read from `process.env` at
// MODULE LOAD, while everything else on this path (`LIVE_MODEL`,
// `LIVE_SURFACE`, `LIVE_BUSINESS_PHONE`, the turn-end arm) goes through the
// injected `deps.env`. So the two settings a call summary REPORTS were the two
// nothing could vary per session -- a test passing { env: { LIVE_VOICE: "Puck" } }
// silently got "Kore", and no assertion about the voice could ever fail.
//
// Fixing the seam is therefore part of fixing the voice, not a tidy-up
// alongside it.
// ---------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  deliver(msg) {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
}

const BASE = {
  businessName: "Brightwork Family Dental",
  mainPhone: "+18176011171",
  timezone: "America/Chicago",
  allowedTasks: ["general_question"],
  capabilities: {},
  businessHours: {},
};

function fakeDb(config) {
  return {
    isEnabled: () => true,
    lookupBusinessByPhone: async () => ({ id: "biz-1", name: config.businessName }),
    loadConfig: () => config,
    withTenantSafe: async (_id, fn) => fn(),
    createCall: async () => "call-1",
    listIntegrationsForBusiness: async () => [],
    fetchBusinessKnowledge: async () => [],
    fetchCallerContext: async () => null,
  };
}

/**
 * Boot one session and return the config actually handed to the Live API.
 *
 * `dialled` is the number the CALLER rang. When the tenant row carries no
 * locale that is what the language derives from -- not config.mainPhone, which
 * readiness.md records is a mobile for Digile Media rather than the line
 * callers ring.
 */
async function connectConfig(tenantConfig, { dialled = "+18176011171", env = {} } = {}) {
  const ws = new FakeSocket();
  const connect = vi.fn(async () => ({
    session: {
      sendRealtimeInput: () => {},
      sendClientContent: () => {},
      sendToolResponse: () => {},
      close: () => {},
    },
    languagePinned: true,
    surface: "aistudio",
    model: "m",
  }));

  await handleLiveSessionConnection(
    ws,
    {},
    { now: () => 0, connect, database: fakeDb(tenantConfig), env, execute: vi.fn() }
  );
  ws.deliver({
    event: "start",
    start: { callSid: "CA_voice", streamSid: "MZ1", customParameters: { businessPhone: dialled } },
  });
  await vi.waitFor(() => expect(connect).toHaveBeenCalled());
  return connect.mock.calls[0][0].config;
}

const voiceOf = (config) => config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName;
const c = () => getLatencyStats().turnTaking;

describe("the Live voice name follows the same ladder as the language", () => {
  beforeEach(() => clearStats());

  it("lets an injected LIVE_VOICE win — the seam LVX13 closed", async () => {
    // FAILS BEFORE THE FIX. `const VOICE = process.env.LIVE_VOICE || "Kore"` is
    // evaluated once at module load, so the injected env is never consulted and
    // this returns "Kore" no matter what a test passes.
    const config = await connectConfig({ ...BASE, locale: "en-US" }, { env: { LIVE_VOICE: "Puck" } });

    expect(voiceOf(config)).toBe("Puck");
    expect(c().live_voice_source_env).toBe(1);
    expect(c().live_voice_source_tenant).toBe(0);
    expect(c().live_voice_source_default).toBe(0);
  });

  it("uses the tenant's own configured voice when there is no override", async () => {
    // businesses.live_voice, added by migration 041 for exactly this. The
    // column is the reason "tenant-aware" means anything: without it every
    // tenant on the platform shares one voice and only an operator with shell
    // access can change it.
    const config = await connectConfig({ ...BASE, locale: "en-GB", liveVoice: "Charon" });

    expect(voiceOf(config)).toBe("Charon");
    expect(c().live_voice_source_tenant).toBe(1);
    expect(c().live_voice_source_env).toBe(0);
    expect(c().live_voice_source_default).toBe(0);
  });

  it("falls back per RESOLVED LANGUAGE, not per number, for a tenant with no voice", async () => {
    // Keyed on the language the ladder actually produced, so the two can never
    // disagree. A tenant whose row says en-GB but is dialled on a US number
    // gets the British default, because the LANGUAGE decided first.
    const config = await connectConfig({ ...BASE, locale: "en-GB" });

    expect(config.speechConfig.languageCode).toBe("en-GB");
    expect(voiceOf(config)).toBeTruthy();
    expect(c().live_voice_source_default).toBe(1);
    expect(c().live_voice_source_tenant).toBe(0);
  });

  it("leaves an American tenant on Kore — the six verified US calls are not disturbed", async () => {
    // The regression guard. Every call verified on 2026-09-04 ran on this
    // configuration; if this changes, those verifications stop applying and the
    // project pays the config-carries-across-environments trap a third time.
    const config = await connectConfig({ ...BASE, locale: "en-US" });

    expect(voiceOf(config)).toBe("Kore");
    expect(c().live_voice_source_default).toBe(1);
  });

  it("bumps exactly one source counter per session", async () => {
    // The positive-twin rule, applied to a choice rather than to a fault. All
    // three counters are positive: "the tenant's voice was used" and "this code
    // never ran" must not read the same, and a fault counter cannot say that
    // because choosing a voice is never a fault.
    await connectConfig({ ...BASE, locale: "en-US" });
    const stats = c();
    const total =
      stats.live_voice_source_env + stats.live_voice_source_tenant + stats.live_voice_source_default;

    expect(total).toBe(1);
  });
});

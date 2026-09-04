import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";

// ---------------------------------------------------------------------------
// Which language the Live voice is pinned to, and where that comes from.
//
// The owner asked why the accent kept changing between British and American
// mid-call, and whether that meant the call had fallen back to the cascade.
//
// It did not, and it cannot: the connect-time fallback decides before any TwiML
// is returned, so once <Connect><Stream> names /twilio/live-stream that one
// socket is the whole call. There is no mid-call fallback -- the <Connect
// action=...> hook is deliberately not built. A cascade call would also be
// ElevenLabs, a different voice entirely, not the same voice with a different
// accent.
//
// What it actually was: LANGUAGE_CODE was a module constant defaulting to
// en-GB, which is Digile Media's locale and was right while Digile Media was
// the only tenant. `businesses.locale` for Brightwork Family Dental reads
// "en-US", loadConfig has carried it as config.locale all along
// (services/db.js:543), and this front-end ignored it -- pinning a British voice
// on an American dental practice, on an American number, for an American
// caller, over content the model generates as American. One voice asked to hold
// an accent its own content disagrees with is a voice that drifts.
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

/** Boot one session and return the config handed to the Live API. */
async function connectConfig(tenantConfig) {
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
    { now: () => 0, connect, database: fakeDb(tenantConfig), env: {}, execute: vi.fn() }
  );
  ws.deliver({
    event: "start",
    start: { callSid: "CA_lang", streamSid: "MZ1", customParameters: { businessPhone: "+18176011171" } },
  });
  await vi.waitFor(() => expect(connect).toHaveBeenCalled());
  return connect.mock.calls[0][0].config;
}

describe("the Live voice follows the tenant's locale", () => {
  const saved = process.env.LIVE_LANGUAGE_CODE;
  beforeEach(() => {
    delete process.env.LIVE_LANGUAGE_CODE;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.LIVE_LANGUAGE_CODE;
    else process.env.LIVE_LANGUAGE_CODE = saved;
  });

  it("pins en-US for an American tenant", async () => {
    // The demo tenant. Before this, it got en-GB.
    const config = await connectConfig({ ...BASE, locale: "en-US" });
    expect(config.speechConfig.languageCode).toBe("en-US");
  });

  it("pins en-GB for a British tenant", async () => {
    // Digile Media, whose locale is what the old default silently encoded.
    const config = await connectConfig({
      ...BASE,
      businessName: "Digile Media",
      timezone: "Europe/London",
      locale: "en-GB",
    });
    expect(config.speechConfig.languageCode).toBe("en-GB");
  });

  it("keeps the old default for a tenant with no locale set", async () => {
    // Digile Media's row reads locale: null today, so this is not hypothetical.
    // A tenant that has never been given one must behave exactly as before
    // rather than being silently re-accented by this change.
    const config = await connectConfig({ ...BASE, locale: null });
    expect(config.speechConfig.languageCode).toBe("en-GB");
  });

  it("lets an explicit env override win over the tenant", async () => {
    // The rig seam. An operator who sets this is overriding on purpose.
    process.env.LIVE_LANGUAGE_CODE = "es-US";
    const config = await connectConfig({ ...BASE, locale: "en-US" });
    expect(config.speechConfig.languageCode).toBe("es-US");
  });

  it("still pins a voice name, so the accent is the only thing that moved", async () => {
    const config = await connectConfig({ ...BASE, locale: "en-US" });
    expect(config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBeTruthy();
  });
});

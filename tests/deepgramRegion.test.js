import { describe, it, expect } from "vitest";
import { deepgramEnvironment } from "../lib/voice/sttStream.js";

// Which Deepgram region a process talks to.
//
// Corrects a mistake that had been sitting on the owner's task list: EU access
// is NOT an account flag to request from Deepgram. It is a different base URL,
// and the same API keys work against it. So this was never an owner task — it
// was an engineering one nobody had been assigned.
//
// It matters because audio sent to the US endpoint is processed in the US
// whatever the DPA says. The UK stack pointing at the US endpoint would make
// the residency claim false while every other piece of the design — the
// separate project, the `in:eu-locations` org policy, the regional Cloud SQL —
// remained correct.

describe("deepgramEnvironment", () => {
  it("defaults to the US endpoint", () => {
    expect(deepgramEnvironment({})).toEqual({
      base: "https://api.deepgram.com",
      agent: "wss://agent.deepgram.com",
      production: "wss://api.deepgram.com",
    });
  });

  it("uses the EU endpoint for DEEPGRAM_REGION=eu", () => {
    const env = deepgramEnvironment({ DEEPGRAM_REGION: "eu" });
    // `production` is the one that matters: it is the WebSocket the live
    // streaming transcription actually opens. Getting `base` right and
    // `production` wrong would send audio to the US while looking configured.
    expect(env.production).toBe("wss://api.eu.deepgram.com");
    expect(env.base).toBe("https://api.eu.deepgram.com");
    expect(env.agent).toBe("wss://api.eu.deepgram.com");
  });

  it.each(["EU", " eu ", "Eu"])("accepts %o, since this is set by hand per service", (value) => {
    expect(deepgramEnvironment({ DEEPGRAM_REGION: value }).production).toBe("wss://api.eu.deepgram.com");
  });

  // Fails toward the US endpoint rather than refusing to start. A typo'd region
  // is a residency bug, not an outage — and B4 sets this per Cloud Run service,
  // where the UK service having a wrong value is caught by C8's residency
  // check rather than by the phone not answering.
  it("falls back to US for an unrecognised region", () => {
    expect(deepgramEnvironment({ DEEPGRAM_REGION: "uk" }).production).toBe("wss://api.deepgram.com");
  });

  it("never returns a US host when asked for eu", () => {
    const env = deepgramEnvironment({ DEEPGRAM_REGION: "eu" });
    for (const url of Object.values(env)) {
      expect(url).toContain("api.eu.deepgram.com");
    }
  });
});

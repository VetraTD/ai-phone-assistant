import { describe, it, expect } from "vitest";
import { PROFILES, getProfile } from "../lib/voice/localeProfiles.js";
import { resolveVoiceLocale, resolveSpeechLocale, resolveLocale } from "../lib/voice/voiceLocale.js";

const BRITISH_VOICE = "Xb7hH8MSUJpSbSDYk0k2"; // Alice, config/voices.js
const AMERICAN_VOICE = "EXAVITQu4vr4xnSDxMaL"; // Sarah

const REQUIRED = [
  "id", "sttLanguage", "googleVoice", "ringTone", "twimlSayVoice",
  "dateStyle", "intlLocale", "currency", "phone", "numberCountry",
];

describe("localeProfiles.js", () => {
  it("gives every shipped profile every field the pipeline reads", () => {
    for (const [id, p] of Object.entries(PROFILES)) {
      for (const field of REQUIRED) {
        expect(p[field], `${id} is missing ${field}`).toBeDefined();
      }
      expect(p.id).toBe(id);
    }
  });

  it("ships US, UK and US-Spanish", () => {
    expect(Object.keys(PROFILES).sort()).toEqual(["en-GB", "en-US", "es-US"]);
  });

  it("falls back to en-US for an unknown id rather than throwing", () => {
    expect(getProfile("xx-YY").id).toBe("en-US");
    expect(getProfile(null).id).toBe("en-US");
  });

  it("accepts a new region without any pipeline change", () => {
    // The extensibility claim, made falsifiable: a profile constructed here,
    // never registered anywhere, must work with every formatter.
    const enAU = { ...PROFILES["en-GB"], id: "en-AU", sttLanguage: "en-AU", ringTone: "au", numberCountry: "AU" };
    expect(enAU.dateStyle).toBe("DMY");
    expect(typeof enAU.phone.cc).toBe("string");
  });
});

describe("voiceLocale.js — speech locale follows the CALLER, voice follows the persona", () => {
  // The bug: resolveLocale checked the operator's chosen VOICE accent before
  // the timezone, and STT reused it. A London business whose operator picked an
  // American voice therefore ran en-US recognition on British callers — the
  // accent of the persona was deciding how the caller was heard.
  const londonUsVoice = {
    languagesSpoken: ["en"],
    timezone: "Europe/London",
    voiceProvider: "elevenlabs",
    voiceId: AMERICAN_VOICE,
  };

  it("recognises a UK caller as en-GB even when the business picked an American voice", () => {
    expect(resolveSpeechLocale(londonUsVoice, { callerNumber: "+447700900123" })).toBe("en-GB");
  });

  it("keeps the American voice for that same business", () => {
    // The persona is the operator's choice and must not move.
    expect(resolveVoiceLocale(londonUsVoice)).toBe("en-US");
  });

  it("recognises a US caller as en-US even when the business sounds British", () => {
    const usBritishVoice = {
      languagesSpoken: ["en"],
      timezone: "America/Chicago",
      voiceProvider: "elevenlabs",
      voiceId: BRITISH_VOICE,
    };
    expect(resolveSpeechLocale(usBritishVoice, { callerNumber: "+14155550123" })).toBe("en-US");
    expect(resolveVoiceLocale(usBritishVoice)).toBe("en-GB");
  });

  it("falls back to the business timezone when the caller number is unknown", () => {
    expect(resolveSpeechLocale(londonUsVoice, {})).toBe("en-GB");
    expect(resolveSpeechLocale(londonUsVoice, { callerNumber: "anonymous" })).toBe("en-GB");
  });

  it("lets an explicit business locale override every heuristic", () => {
    expect(resolveSpeechLocale({ ...londonUsVoice, locale: "en-US" }, { callerNumber: "+447700900123" })).toBe("en-US");
  });

  it("keeps resolveLocale working unchanged for existing callers of it", () => {
    expect(resolveLocale(londonUsVoice)).toBe("en-US");
  });
});

describe("mapLanguage — Deepgram follows the caller", () => {
  it("runs en-GB recognition for a UK caller of an American-voiced London business", async () => {
    const { mapLanguage } = await import("../lib/voice/session.js");
    const config = {
      languagesSpoken: ["en"],
      timezone: "Europe/London",
      voiceProvider: "elevenlabs",
      voiceId: AMERICAN_VOICE,
    };
    expect(mapLanguage(config, { callerNumber: "+447700900123" })).toBe("en-GB");
  });

  it("runs en-US recognition for a US caller of a British-voiced business", async () => {
    const { mapLanguage } = await import("../lib/voice/session.js");
    const config = {
      languagesSpoken: ["en"],
      timezone: "America/Chicago",
      voiceProvider: "elevenlabs",
      voiceId: BRITISH_VOICE,
    };
    expect(mapLanguage(config, { callerNumber: "+14155550123" })).toBe("en-US");
  });

  it("still returns multi and bare codes exactly as before", async () => {
    const { mapLanguage } = await import("../lib/voice/session.js");
    expect(mapLanguage({ languagesSpoken: ["en", "es"] })).toBe("multi");
    expect(mapLanguage({ languagesSpoken: ["es"] })).toBe("es");
    expect(mapLanguage({ languagesSpoken: ["en-GB"] })).toBe("en-GB");
  });
});

describe("locale-aware speech", () => {
  it("says a UK date the way a British receptionist says it", async () => {
    const { speakableDateTime } = await import("../lib/capabilities/datetime.js");
    const iso = "2026-08-06T13:00:00Z"; // 2 PM BST
    expect(speakableDateTime(iso, "Europe/London", getProfile("en-GB"))).toBe(
      "Thursday the 6th of August at 2:00 PM"
    );
  });

  it("leaves the US phrasing exactly as it was", async () => {
    const { speakableDateTime } = await import("../lib/capabilities/datetime.js");
    const iso = "2026-08-06T19:00:00Z"; // 2 PM CDT
    expect(speakableDateTime(iso, "America/Chicago")).toBe("Thursday, August 6 at 2:00 PM");
    expect(speakableDateTime(iso, "America/Chicago", getProfile("en-US"))).toBe(
      "Thursday, August 6 at 2:00 PM"
    );
  });

  it("groups a UK number the way it is written, not in threes", async () => {
    const { toSpeakable } = await import("../lib/voice/speakableText.js");
    // Today: "442 079 460 958", an unintelligible mumble.
    const spoken = toSpeakable("+442079460958", { profile: getProfile("en-GB") });
    expect(spoken).toBe("020 7946 0958");
  });

  it("groups a UK mobile as 5 then 6", async () => {
    const { toSpeakable } = await import("../lib/voice/speakableText.js");
    expect(toSpeakable("+447700900123", { profile: getProfile("en-GB") })).toBe("07700 900123");
  });

  it("leaves US numbers byte-identical", async () => {
    const { toSpeakable } = await import("../lib/voice/speakableText.js");
    expect(toSpeakable("+18175803291")).toBe("817 580 3291");
    expect(toSpeakable("+18175803291", { profile: getProfile("en-US") })).toBe("817 580 3291");
  });

  it("reads pounds and euros, not just dollars", async () => {
    const { toSpeakable } = await import("../lib/voice/speakableText.js");
    expect(toSpeakable("That's £85.50 including parts.")).toBe("That's 85 pounds 50 including parts.");
    expect(toSpeakable("It's €40.")).toBe("It's 40 euros.");
    expect(toSpeakable("That's $85.50.")).toBe("That's 85 dollars 50.");
  });
});

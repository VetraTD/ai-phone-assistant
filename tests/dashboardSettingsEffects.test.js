/**
 * THE GUARANTEE: every setting the dashboard can save either changes what a
 * call gets, changes what happens after a call, or is not shown on screen.
 *
 * tests/capabilityConfigEffects.test.js does this for capability settings. This
 * file does it for the business columns the dashboard writes through
 * PUT /api/business/:id/settings, whose write whitelist is
 * SETTINGS_FIELD_VALIDATORS (one key per column).
 *
 *   1. TRIPWIRE: every writable key sits in exactly one register below. Add a
 *      writable column without registering it and this fails.
 *   2. EFFECTS: every ON_A_CALL key has a test that sets it to a sentinel and
 *      finds the sentinel (or its effect) in what the LIVE call path builds.
 *      Live serves every production call; it builds its prompt with
 *      services/gemini.js buildSystemInstruction (lib/voice/live/index.js), its
 *      greeting with lib/voice/greeting.js, and its voice and language with
 *      resolveLiveVoice / resolveLiveLanguage.
 *
 * A setting shown on screen with no consumer on a call is a defect. It goes in
 * KNOWN_UNWIRED with a reason and is reported, not wired here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { buildSystemInstruction } from "../services/gemini.js";
import { loadConfig } from "../services/db.js";
import { greetingTextFor } from "../lib/voice/greeting.js";
import { resolveTransferAllowed } from "../lib/voice/session.js";
import { resolveLiveVoice, resolveLiveLanguage } from "../lib/voice/live/index.js";

const require = createRequire(import.meta.url);
const { SETTINGS_FIELD_VALIDATORS } = require("../AI-phone-dashboard/backend/src/settingsValidation.js");

// --- registers -------------------------------------------------------------

/** Keys whose value reaches the call itself. Each has an effect test below. */
const ON_A_CALL = [
  "name",
  "timezone",
  "greeting",
  "custom_instructions",
  "general_info",
  "main_phone",
  "business_hours",
  "after_hours_policy",
  "transfer_policy",
  "transfer_phone_number",
  "languages_spoken",
  "recording_disclosure_enabled",
  "recording_disclosure_text",
  "live_voice",
  "locale",
];

/**
 * Keys read after the call ends: the code that reads the column, and the
 * real-database test that drives that code end to end.
 */
const OWNER_EMAIL = { reader: "services/notifications.js", proof: "tests/db/ownerNotifications.test.js" };
const AFTER_A_CALL = {
  notification_email: OWNER_EMAIL,
  notifications_enabled: OWNER_EMAIL,
};

/** Writable keys the dashboard does not show, and why. */
const NOT_SHOWN = {
  notification_phone: "texts are off in production",
  sms_followup_enabled: "texts are off in production",
  sms_templates: "texts are off in production",
  allowed_tasks: "legacy; business_capabilities replaced it",
  voice_provider:
    "cascade-only (ElevenLabs/Google TTS); the picker shows it only when /api/live-voices declares the cascade front-end, which serves no production call",
  voice_id:
    "cascade-only (ElevenLabs/Google TTS); the picker shows it only when /api/live-voices declares the cascade front-end, which serves no production call",
};

/** Shown on screen but read by nothing on a call. Each is a defect, reported. */
const KNOWN_UNWIRED = {};

// --- tripwire --------------------------------------------------------------

describe("TRIPWIRE: every writable dashboard setting has a home", () => {
  it("every writable dashboard setting is registered exactly once", () => {
    const registers = [ON_A_CALL, Object.keys(AFTER_A_CALL), Object.keys(NOT_SHOWN), Object.keys(KNOWN_UNWIRED)];
    const all = registers.flat();
    const dupes = all.filter((k, i) => all.indexOf(k) !== i);
    expect(dupes, "a key may sit in only one register").toEqual([]);
    expect([...all].sort()).toEqual(Object.keys(SETTINGS_FIELD_VALIDATORS).sort());
  });

  it("no shown setting is unwired", () => {
    // A non-empty KNOWN_UNWIRED is a defect list for the owner, not a pass.
    expect(KNOWN_UNWIRED).toEqual({});
  });

  for (const [key, { reader, proof }] of Object.entries(AFTER_A_CALL)) {
    it(`${key} is read by the owner email (${reader}, proved in ${proof})`, () => {
      expect(readFileSync(new URL(`../${reader}`, import.meta.url), "utf8")).toContain(`business.${key}`);
      expect(readFileSync(new URL(`../${proof}`, import.meta.url), "utf8")).toContain(key);
    });
  }
});

// --- effects ---------------------------------------------------------------

const WEEKLY = {
  mon: { open: "06:47", close: "17:00", closed: false },
  tue: { open: "09:00", close: "17:00", closed: false },
  wed: { open: "09:00", close: "17:00", closed: false },
  thu: { open: "09:00", close: "17:00", closed: false },
  fri: { open: "09:00", close: "17:00", closed: false },
  sat: { open: null, close: null, closed: true },
  sun: { open: null, close: null, closed: true },
};

const business = (over = {}) => ({
  id: "b1",
  name: "Brightwork Family Dental",
  timezone: "America/Chicago",
  business_hours: WEEKLY,
  business_capabilities: [],
  ...over,
});
const configOf = (over) => loadConfig(business(over));
const promptOf = (over, extras = {}) =>
  buildSystemInstruction("greeting", null, configOf(over), { knowledge: [], integrations: [], transferAllowed: true, ...extras });

describe("ON_A_CALL: each setting changes what the call gets", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T16:00:00Z")); // Mon 10:00 Chicago, open
  });
  afterEach(() => vi.useRealTimers());

  it("covers exactly the ON_A_CALL register", () => {
    // Each `${key} changes what the call gets` test below is listed here, so a
    // key added to ON_A_CALL without an effect test fails.
    expect([...EFFECT_TESTED].sort()).toEqual([...ON_A_CALL].sort());
  });

  it("name changes what the call gets", () => {
    expect(promptOf({ name: "Sentinel Dental Studio" })).toContain("Sentinel Dental Studio");
  });

  it("timezone changes what the call gets", () => {
    // 16:00 UTC is still Monday in Pago Pago and already Tuesday in Kiritimati.
    expect(promptOf({ timezone: "Pacific/Kiritimati" })).not.toEqual(promptOf({ timezone: "Pacific/Pago_Pago" }));
    expect(promptOf({ timezone: "Pacific/Kiritimati" })).toMatch(/Tuesday/);
  });

  it("greeting changes what the call gets", () => {
    expect(greetingTextFor(configOf({ greeting: "Sentinel greeting, how can I help?" }))).toContain("Sentinel greeting, how can I help?");
  });

  it("custom_instructions changes what the call gets", () => {
    expect(promptOf({ custom_instructions: "SENTINEL-HOUSE-RULE" })).toContain("SENTINEL-HOUSE-RULE");
  });

  it("general_info changes what the call gets", () => {
    expect(promptOf({ general_info: "SENTINEL-GENERAL-INFO" })).toContain("SENTINEL-GENERAL-INFO");
  });

  it("main_phone changes what the call gets", () => {
    expect(promptOf({ main_phone: "+15550109876" })).toContain("+15550109876");
  });

  it("business_hours changes what the call gets", () => {
    expect(promptOf({})).toMatch(/0?6:47/);
    expect(promptOf({ business_hours: { ...WEEKLY, mon: { open: "09:00", close: "17:00", closed: false } } })).not.toMatch(/0?6:47/);
  });

  it("after_hours_policy changes what the call gets", () => {
    vi.setSystemTime(new Date("2026-11-29T18:00:00Z")); // Sunday, closed
    const message = promptOf({ after_hours_policy: "take_message" });
    const callback = promptOf({ after_hours_policy: "offer_callback" });
    expect(message).toMatch(/AFTER-HOURS BEHAVIOR/);
    expect(message).not.toEqual(callback);
  });

  it("transfer_policy changes what the call gets", () => {
    expect(resolveTransferAllowed(configOf({ transfer_policy: "always" }))).toBe(true);
    expect(resolveTransferAllowed(configOf({ transfer_policy: "never" }))).toBe(false);
  });

  it("transfer_phone_number changes what the call gets", () => {
    expect(configOf({ transfer_phone_number: "+15550104444" }).transferPhoneNumber).toBe("+15550104444");
    // Live gates the transfer on it and dials it. The dial itself is driven end
    // to end in tests/livePendingDial.test.js; this pins that both Live reads
    // are of the tenant's own column.
    const live = readFileSync(new URL("../lib/voice/live/index.js", import.meta.url), "utf8");
    expect(live).toContain("transferAllowed: Boolean(config?.transferPhoneNumber || process.env.TRANSFER_NUMBER) && resolveTransferAllowed(config)");
    expect(live).toContain("return state.config?.transferPhoneNumber || process.env.TRANSFER_NUMBER || null;");
  });

  it("languages_spoken changes what the call gets", () => {
    expect(promptOf({ languages_spoken: ["en", "es"] })).toContain("You can speak: en, es");
    expect(promptOf({ languages_spoken: ["en"] })).not.toContain("You can speak:");
  });

  it("recording_disclosure_enabled changes what the call gets", () => {
    const on = greetingTextFor(configOf({ recording_disclosure_enabled: true, recording_disclosure_text: "SENTINEL-NOTICE." }));
    const off = greetingTextFor(configOf({ recording_disclosure_enabled: false, recording_disclosure_text: "SENTINEL-NOTICE." }));
    expect(on).toContain("SENTINEL-NOTICE.");
    expect(off).not.toContain("SENTINEL-NOTICE.");
  });

  it("recording_disclosure_text changes what the call gets", () => {
    expect(greetingTextFor(configOf({ recording_disclosure_enabled: true, recording_disclosure_text: "SENTINEL-TEXT." }))).toContain("SENTINEL-TEXT.");
  });

  it("live_voice changes what the call gets", () => {
    expect(resolveLiveVoice(configOf({ live_voice: "Sentinelvoice" }), "en-US", {})).toEqual({ name: "Sentinelvoice", source: "tenant" });
  });

  it("locale changes what the call gets", () => {
    expect(resolveLiveLanguage(configOf({ locale: "fr-FR" }), "+15550100000", {})).toMatchObject({ code: "fr-FR", source: "tenant" });
  });
});

const EFFECT_TESTED = [
  "name",
  "timezone",
  "greeting",
  "custom_instructions",
  "general_info",
  "main_phone",
  "business_hours",
  "after_hours_policy",
  "transfer_policy",
  "transfer_phone_number",
  "languages_spoken",
  "recording_disclosure_enabled",
  "recording_disclosure_text",
  "live_voice",
  "locale",
];

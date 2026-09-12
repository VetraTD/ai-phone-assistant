// Constants duplicated from the root voice-server repo (this dashboard
// backend is a separate deployable app and cannot import across apps/
// package boundaries — keep these in sync by hand when the source files
// change).

// Source of truth: root repo services/db.js (Phase 2A task model).
// CORE tasks are always available on every call and are never stored in
// businesses.allowed_tasks; MODULE tasks are the opt-in set a business can
// enable, and are exactly what businesses.allowed_tasks stores.
const CORE_TASKS = ["general_question", "take_message", "callback_request", "transfer_human"];
const MODULE_TASKS = [
  "book_appointment",
  "check_appointment",
  "cancel_reschedule",
  "quote_request",
];

// Source of truth: root repo services/db.js loadConfig() /
// config.languagesSpoken consumers (services/gemini.js, lib/voice/session.js,
// lib/voice/session.js).
const ALLOWED_LANGUAGES = ["en", "es", "fr"];

// Source of truth: root repo services/db.js AFTER_HOURS_POLICIES /
// TRANSFER_POLICIES.
const AFTER_HOURS_POLICIES = ["take_message", "offer_callback", "book_later", "transfer_if_possible"];
const TRANSFER_POLICIES = ["always", "business_hours_only", "never"];

// Source of truth: database/015_voice_settings.sql / root repo
// lib/voice/session.js resolveVoice().
const VOICE_PROVIDERS = ["elevenlabs", "google"];

// Source of truth: root repo config/voices.js VOICE_CATALOG[].elevenVoiceId.
// Keep this list in sync when the catalog changes.
const ELEVENLABS_VOICE_IDS = [
  "hpp4J3VqNfWAUOO0d1Us", // Bella
  "EXAVITQu4vr4xnSDxMaL", // Sarah
  "XrExE9yKIg1WjnnlVkGX", // Matilda
  "Xb7hH8MSUJpSbSDYk0k2", // Alice
  "cjVigY5qzO86Huf0OWal", // Eric
  "CwhRBWXzGAHq8TQ4Fs17", // Roger
  "onwK4e9ZLuTAKqWW03F9", // Daniel
  "SAz9YHcvj6GT2YYXdXww", // River
];

// ---------------------------------------------------------------------------
// THE LIVE FRONT-END'S TWO SETTINGS, which are not the two above.
//
// voice_provider / voice_id are ElevenLabs, and only the cascade reads them.
// Every production call is served by the Live front-end, which reads
// businesses.live_voice and businesses.locale. That mismatch is LVX84: a
// business could change its voice, watch it save, and hear nothing different.
// ---------------------------------------------------------------------------

// Source of truth: the CHECK constraint on businesses.locale (root repo
// database/025_business_locale.sql, materialised in database/schema.sql), which
// in turn mirrors lib/voice/localeProfiles.js PROFILE_IDS. Adding an id here is
// NOT enough to add a language: each one needs a profile carrying its STT
// language, date style, currency, phone grouping and ringback, plus a migration
// widening the CHECK. src/__tests__/liveVoiceSettings.test.js asserts this list
// against the schema so the drift cannot happen quietly.
const LOCALES = ["en-US", "en-GB", "es-US"];

// Source of truth: root repo scripts/voice-compare.js, whose own comment says
// this list is "a starting point to be disproved, not an authority".
//
// It is not a vendor-published set and this repository has never established
// which prebuilt names the Live API accepts, nor what it does with one it does
// not recognise. That is exactly why migration 041 gives live_voice NO CHECK
// constraint — a stale constraint would refuse a name that is perfectly valid
// at the vendor. Validation lives here instead, where widening it is a deploy
// rather than a migration.
const LIVE_VOICES = ["Kore", "Puck", "Charon", "Aoede", "Leda"];

// Source of truth: root repo services/notifications.js DEFAULT_SMS_TEMPLATES
// (and database/017_followups_and_metrics.sql's businesses.sms_templates
// comment). A business may override the copy for any of these kinds; any
// other key would be dead data the voice server never reads.
const SMS_TEMPLATE_KINDS = [
  "appointment_confirmation",
  "appointment_cancelled",
  "message_received",
  "missed_call",
  "appointment_request_pending",
];

// A single SMS segment is 160 GSM-7 characters; 320 keeps an override to at
// most two segments after placeholder interpolation is roughly accounted for.
const SMS_TEMPLATE_MAX_LENGTH = 320;

// Which {placeholders} each template kind may use. Source of truth: root repo
// lib/smsConsent.js SMS_TEMPLATE_PLACEHOLDERS, and tests/smsTemplateParity.test.js
// in the ROOT suite fails when these two copies drift.
//
// This is NOT a PHI detector, and calling it one would be the dangerous
// mistake. No check can tell that "your chemotherapy appointment" discloses
// more than "your appointment", and a clinical-keyword denylist would be false
// confidence in the one message that leaves this system addressed to a patient.
// What it CAN do is bound the identifiers the system itself substitutes in, so
// an override cannot pull a field into a message that never carried one.
//
// The guard that actually protects the caller is consent (ledger O25,
// database/037_sms_consent.sql): nothing is sent to anyone who has not asked
// for it, whatever the owner typed into the template.
const SMS_TEMPLATE_PLACEHOLDERS = {
  appointment_confirmation: ["name", "business", "datetime"],
  appointment_cancelled: ["name", "business", "datetime"],
  message_received: ["name_part", "business", "sla"],
  // A booking the call owed and never wrote. {business} AND NOTHING ELSE: no
  // {datetime}, because there is no confirmed row and a time here would assert the
  // booking this message exists to deny; no {name}, because a name is the field
  // most likely to be the thing that went wrong. Kept identical to
  // lib/smsConsent.js -- tests/smsTemplateParity.test.js fails on drift.
  appointment_request_pending: ["business"],
  missed_call: ["business"],
};

// Source of truth: database/014_business_hours_weekly.sql.
const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const ALLOWED_TIMEZONES = [
  "America/Chicago",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
];

module.exports = {
  CORE_TASKS,
  MODULE_TASKS,
  ALLOWED_LANGUAGES,
  AFTER_HOURS_POLICIES,
  TRANSFER_POLICIES,
  VOICE_PROVIDERS,
  ELEVENLABS_VOICE_IDS,
  LOCALES,
  LIVE_VOICES,
  SMS_TEMPLATE_KINDS,
  SMS_TEMPLATE_MAX_LENGTH,
  SMS_TEMPLATE_PLACEHOLDERS,
  DAY_KEYS,
  ALLOWED_TIMEZONES,
};

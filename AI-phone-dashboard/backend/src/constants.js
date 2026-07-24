// Constants duplicated from the root voice-server repo (this dashboard
// backend is a separate deployable app and cannot import across apps/
// package boundaries — keep these in sync by hand when the source files
// change).

// Source of truth: root repo services/supabase.js (Phase 2A task model).
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

// Source of truth: root repo services/supabase.js loadConfig() /
// config.languagesSpoken consumers (services/gemini.js, lib/voice/session.js,
// lib/mediaStream.js).
const ALLOWED_LANGUAGES = ["en", "es", "fr"];

// Source of truth: root repo services/supabase.js AFTER_HOURS_POLICIES /
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

// Source of truth: root repo services/notifications.js DEFAULT_SMS_TEMPLATES
// (and database/017_followups_and_metrics.sql's businesses.sms_templates
// comment). A business may override the copy for any of these kinds; any
// other key would be dead data the voice server never reads.
const SMS_TEMPLATE_KINDS = ["appointment_confirmation", "message_received", "missed_call"];

// A single SMS segment is 160 GSM-7 characters; 320 keeps an override to at
// most two segments after placeholder interpolation is roughly accounted for.
const SMS_TEMPLATE_MAX_LENGTH = 320;

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
  SMS_TEMPLATE_KINDS,
  SMS_TEMPLATE_MAX_LENGTH,
  DAY_KEYS,
  ALLOWED_TIMEZONES,
};

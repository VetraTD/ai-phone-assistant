// Mirrored by hand from AI-phone-dashboard/backend/src/constants.js (the
// write whitelist source of truth is settingsValidation.js's
// SETTINGS_FIELD_VALIDATORS, which constants.js's enum lists feed). Keep in
// sync whenever the backend enum lists change — a mismatch here just means a
// stale label, but a value not present in the backend's list will 400 on
// save.

export const TIMEZONES = [
  "America/Chicago",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
];

// CORE tasks are always available on every call and are never stored in
// businesses.allowed_tasks. MODULE tasks are the opt-in set a business can
// enable — allowed_tasks stores exactly this set (array of keys).
export const CORE_TASKS = [
  { key: "general_question", label: "Answer questions" },
  { key: "take_message", label: "Take messages" },
  { key: "callback_request", label: "Callbacks" },
  { key: "transfer_human", label: "Transfer to human" },
];

export const MODULE_TASKS = [
  { key: "book_appointment", label: "Book appointments" },
  { key: "check_appointment", label: "Check appointments" },
  { key: "cancel_reschedule", label: "Cancel / reschedule" },
  { key: "quote_request", label: "Quotes" },
  { key: "directions_location", label: "Directions" },
  { key: "form_document_request", label: "Forms" },
];

export const LANGUAGES = [
  { key: "en", label: "English" },
  { key: "es", label: "Spanish" },
  { key: "fr", label: "French" },
];

export const AFTER_HOURS_POLICIES = [
  { key: "take_message", label: "Take a message" },
  { key: "offer_callback", label: "Offer a callback" },
  { key: "book_later", label: "Offer to book for later" },
  { key: "transfer_if_possible", label: "Transfer if possible" },
];

export const TRANSFER_POLICIES = [
  { key: "always", label: "Always transfer" },
  { key: "business_hours_only", label: "Business hours only" },
  { key: "never", label: "Never transfer" },
];

export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

// Caller-facing SMS follow-up kinds. Mirrors the backend's
// constants.js SMS_TEMPLATE_KINDS / SMS_TEMPLATE_MAX_LENGTH (itself mirrored
// from the root repo's services/notifications.js DEFAULT_SMS_TEMPLATES) — a
// kind not in the backend's list is rejected with a 400 on save.
export const SMS_TEMPLATE_KINDS = ["appointment_confirmation", "message_received", "missed_call"];

export const SMS_TEMPLATE_MAX_LENGTH = 320;

export const SMS_TEMPLATE_META = {
  appointment_confirmation: {
    label: "Appointment confirmation",
    hint: "Sent after the AI books an appointment. Placeholders: {name}, {business}, {datetime}.",
    placeholder:
      "Hi {name}, your appointment with {business} is confirmed for {datetime}. Reply to this number if you need to change it.",
  },
  message_received: {
    label: "Message received",
    hint: "Sent after the AI takes a message. Placeholders: {name_part}, {business}, {sla}.",
    placeholder:
      "Hi{name_part}, we got your message at {business} — someone will get back to you {sla}. Thanks for calling!",
  },
  missed_call: {
    label: "Missed call",
    hint: "Sent when a call goes unanswered. Placeholder: {business}.",
    placeholder:
      "Sorry we missed your call at {business}! Reply here or call back anytime and we'll help you right away.",
  },
};

export const DAY_LABELS = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

// Personality presets for AIBehaviorSection. Selecting one inserts a
// `[Tone] ...` line at the top of custom_instructions (see
// AIBehaviorSection.jsx), replacing any prior `[Tone]` line.
export const PERSONALITY_PRESETS = [
  {
    key: "professional",
    label: "Professional",
    instruction: "Speak in a polished, professional tone — concise, formal, and efficient.",
  },
  {
    key: "friendly",
    label: "Friendly",
    instruction: "Speak in a warm, friendly tone — approachable and conversational, like a helpful neighbor.",
  },
  {
    key: "casual",
    label: "Casual",
    instruction: "Speak in a relaxed, casual tone — easygoing and informal, while staying respectful.",
  },
];

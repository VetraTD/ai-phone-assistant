/**
 * Named presets of the campaign config (spec §7). Part 1 ships speed_to_lead
 * only; the rest arrive with Part 3. caller_id is deliberately blank -- it
 * must be a number on the service's Twilio account, so a template cannot
 * guess it, and a blank one is refused at save.
 */
export const TEMPLATES = Object.freeze({
  speed_to_lead: Object.freeze({
    persona_name: "Ava",
    caller_id: "",
    calling_window: { mon_fri: "09:00-20:00", sat: "10:00-16:00", sun: null, outside_window: "queue" },
    // The SHORT backstop line (spec §9.3, 120-char budget). The reason for the
    // call ({topic}) comes in Ava's next sentence, spoken live.
    opener: "Hi, is that {first_name}? It's {persona_name}, an AI assistant from {business_name}.",
    // NEUTRAL defaults (owner 2026-09-30: outbound is for ANY business). A
    // campaign's own business-specific wording (its own questions, its own
    // reason) lives in THAT campaign's config, never here.
    topic: "your recent enquiry",
    objective: "Follow up on their enquiry, ask the questions, and offer a time to talk.",
    // Spoken once to the confirmed person (lib/outbound/prompt.js callReasonFor).
    call_reason: "You recently got in touch with us, and I'm following up on that.",
    notes: "",
    questions: [{ key: "need", ask: "What were you hoping we could help with?", required: true, type: "text" }],
    capabilities: ["qualification", "appointments", "transfer", "callback", "opt_out", "outcome"],
    booking: { adapter: "internal", length_min: 30 },
    transfer: null,
    retries: { schedule: ["now", "+10m", "+3h", "next_day 10:00", "day_3 17:30"], voicemail_on: [1, 5], text_after_missed: [1], give_up_after_days: 7 },
    voicemail: "Hi {first_name}, it's {persona_name}, the AI assistant from {business_name}, about your enquiry. We'll try again later, or call us back on {caller_id_spoken}.",
    consent_window_days: 30,
    max_call_minutes: 10,
    // S3-6 (spec §19, S3-D4): required. The objective above is
    // qualify_then_book, and the capabilities list already carries both
    // capabilities that goal requires (qualification, appointments).
    goal: "qualify_then_book",
    why_allowed: "Every contact submitted our own enquiry form; this call follows up on that enquiry.",
  }),
});

/** Which consent purpose each template needs (spec §13.1 "a matching purpose"). */
export const PURPOSE_BY_TEMPLATE = Object.freeze({
  speed_to_lead: "enquiry_followup",
  missed_call_callback: "callback_request",
  reminder: "appointment_service",
  no_show: "appointment_service",
  aftercare: "appointment_service",
  review_request: "review",
  reactivation: "marketing",
  // S3-6 (spec §19, S3-D4): custom's only solicited-class basis is
  // asked_to_be_contacted (validateCampaign pins that pairing) -- its
  // existing_customer basis is compliance_class "service", which
  // consentSatisfies never checks a purpose for, so this is the only value
  // this lookup ever needs for template_key "custom".
  custom: "enquiry_followup",
});

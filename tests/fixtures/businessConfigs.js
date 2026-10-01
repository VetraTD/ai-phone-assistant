/**
 * Shared business-config fixtures.
 *
 * Extracted verbatim from tests/promptSnapshot.test.js so more than one suite
 * (the golden prompt snapshots, and the text-session/eval harness) can drive the
 * REAL prompt builder and tool dispatch against the same set of representative
 * businesses. The values MUST NOT change: the prompt snapshots are byte-exact,
 * so any edit here would move a snapshot and mask a real prompt regression.
 *
 * FROZEN_NOW deliberately stays in promptSnapshot.test.js — it is a test concern
 * (the fake clock the dynamic tail renders against), not a property of a business.
 */

import { normalizeAllowedTasks } from "../../services/db.js";

export const WEEKLY_HOURS = {
  mon: { open: "09:00", close: "17:00", closed: false },
  tue: { open: "09:00", close: "17:00", closed: false },
  wed: { open: "09:00", close: "17:00", closed: false },
  thu: { open: "09:00", close: "17:00", closed: false },
  fri: { open: "09:00", close: "16:00", closed: false },
  sat: { open: null, close: null, closed: true },
  sun: { open: null, close: null, closed: true },
};

/**
 * Fixtures span the distinct shapes the prompt builder can produce. Each pairs
 * a business config with the `extras` bag getReplyStreaming would pass.
 */
export const FIXTURES = {
  // Full appointment stack behind an EHR — exercises ATHENA_FUNCTION_DECLARATIONS,
  // the EHR fork in step guidance, and suppression of the DB appointment tools.
  "clinic-athena": {
    config: {
      businessName: "Riverside Family Clinic",
      greeting: "Thanks for calling Riverside Family Clinic.",
      _hasCustomGreeting: true,
      timezone: "America/Chicago",
      businessHours: WEEKLY_HOURS,
      // The ONE archetype that texts, added 2026-09-04 with LVX52.
      //
      // record_sms_consent is now withheld from a tenant that cannot send texts
      // at all, and none of these five fixtures set the flag -- so without this
      // line, regenerating the snapshots would silently delete every trace of
      // that declaration and its protocol section from the golden files, and
      // the drift guard would have nothing left to guard. A clinic that texts
      // appointment confirmations is also the realistic shape for it.
      smsFollowupEnabled: true,
      transferPhoneNumber: "+15551230000",
      allowedTasks: normalizeAllowedTasks([
        "book_appointment",
        "check_appointment",
        "cancel_reschedule",
      ]),
      mainPhone: "555-0100",
      generalInfo: "We are a family practice serving the Riverside area since 1998.",
      afterHoursPolicy: "take_message",
      transferPolicy: "always",
      languagesSpoken: ["en", "es"],
      customInstructions: "Never quote prices. New patients need a 40-minute slot.",
    },
    extras: {
      knowledge: [
        { question: "Do you take insurance?", answer: "Yes, most major plans.", category: "billing" },
        { question: "Where do I park?", answer: "Free lot behind the building.", category: null },
      ],
      callerContext: {
        callCount: 2,
        lastCallSummary: "booked a cleaning",
        upcomingAppointments: [{ scheduled_at: "2026-08-01T10:00:00Z", client_name: "Jane Doe" }],
      },
      transferAllowed: true,
      integrations: [
        { enabled: true, provider: "athenahealth", name: "athena", config: { practice_id: "195900" } },
      ],
    },
  },

  // Same appointment modules, NO EHR — exercises DB_APPOINTMENT_DECLARATIONS and
  // the non-EHR cancel/reschedule guidance with its identity-check paragraph.
  "appointments-db": {
    config: {
      businessName: "Acme Dental",
      greeting: "Thanks for calling Acme Dental.",
      _hasCustomGreeting: true,
      timezone: "America/Chicago",
      businessHours: { open_time: "09:00", close_time: "17:00" },
      transferPhoneNumber: null,
      allowedTasks: normalizeAllowedTasks(["book_appointment", "cancel_reschedule"]),
      mainPhone: "555-1234",
      generalInfo: null,
      afterHoursPolicy: "offer_callback",
      transferPolicy: "never",
      languagesSpoken: ["en"],
      customInstructions: null,
    },
    extras: {
      knowledge: [],
      callerContext: null,
      transferAllowed: false,
      integrations: [],
    },
  },

  // Core tasks only, no modules — and now it genuinely is.
  //
  // This fixture used to register book_appointment despite asking for nothing:
  // normalizeAllowedTasks treated an empty array and an unset value alike, both
  // defaulting to ["book_appointment"], so a business that does not do
  // appointments was unrepresentable. The snapshot captured that faithfully
  // rather than hiding it, and its change when the fix landed IS the evidence
  // the fix works: no appointment tool, no appointment clause in CAPABILITIES.
  "messages-only": {
    config: {
      businessName: "Dave's Plumbing",
      greeting: "Dave's Plumbing, how can I help?",
      _hasCustomGreeting: true,
      timezone: "America/New_York",
      businessHours: WEEKLY_HOURS,
      transferPhoneNumber: "+15559990000",
      allowedTasks: normalizeAllowedTasks([]),
      mainPhone: null,
      generalInfo: "Emergency callouts available 24/7.",
      afterHoursPolicy: "transfer_if_possible",
      transferPolicy: "always",
      languagesSpoken: ["en"],
      customInstructions: null,
    },
    extras: {
      knowledge: [],
      callerContext: null,
      transferAllowed: true,
      integrations: [],
    },
  },

  // Appointments with availability ON, a built-in DOB requirement, and an
  // operator note — locks the check-first booking guidance, the
  // check_appointment_availability tool, and the CAPABILITY NOTES section.
  "appointments-availability": {
    config: {
      businessName: "Brightwork Family Dental",
      greeting: "Thanks for calling Brightwork Family Dental.",
      _hasCustomGreeting: true,
      timezone: "America/Chicago",
      businessHours: WEEKLY_HOURS,
      transferPhoneNumber: "+15551230000",
      allowedTasks: normalizeAllowedTasks(["book_appointment", "check_appointment", "cancel_reschedule"]),
      mainPhone: "555-0100",
      generalInfo: null,
      afterHoursPolicy: "take_message",
      transferPolicy: "always",
      languagesSpoken: ["en"],
      customInstructions: null,
      capabilities: {
        appointments: {
          enabled: true,
          adapter: "internal",
          availability: { length: 30, capacity: 1 },
          require: { identity: { builtin: ["name", "dob"] } },
          notes: "Ask whether they are a new or existing patient first.",
        },
      },
    },
    extras: {
      knowledge: [],
      callerContext: null,
      transferAllowed: true,
      integrations: [],
    },
  },

  // The non-appointment modules plus a custom webhook tool — exercises the
  // remaining CAPABILITIES branches and buildIntegrationTools' webhook path.
  "modules-and-webhook": {
    config: {
      businessName: "Northside Law",
      greeting: "Northside Law, how may I direct your call?",
      _hasCustomGreeting: true,
      timezone: "America/Los_Angeles",
      businessHours: null,
      transferPhoneNumber: "+15557778888",
      allowedTasks: normalizeAllowedTasks(["quote_request"]),
      mainPhone: "555-4321",
      generalInfo: null,
      afterHoursPolicy: "book_later",
      transferPolicy: "business_hours_only",
      languagesSpoken: ["es"],
      customInstructions: "Never give legal advice. Always route to an attorney.",
    },
    extras: {
      knowledge: [],
      callerContext: null,
      transferAllowed: true,
      integrations: [
        {
          enabled: true,
          provider: "webhook",
          name: "open_case_file",
          config: {
            url: "https://example.test/hook",
            method: "POST",
            description: "Open a new case file in the practice management system.",
            params_schema: {
              type: "object",
              properties: { matter_type: { type: "string" } },
              required: ["matter_type"],
            },
          },
        },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// OUTBOUND FIXTURES (Task 16, spec §9.5) -- kept SEPARATE from FIXTURES above.
// tests/promptSnapshot.test.js iterates FIXTURES only and never sees these;
// tests/outboundPromptSnapshot.test.js iterates OUTBOUND_FIXTURES only, with
// its own snapshot directory (tests/__snapshots__/prompts/outbound/).
//
// Each entry is `{ config, extras }`, same shape as FIXTURES, except `extras`
// carries `outboundCall` -- the object lib/voice/live/index.js builds at
// onStart from lib/outbound/callContext.js's `resolveOutboundContext` (with
// the `business` field stripped out; Task 14). `extras.callerPhone` stays ""
// and `extras.greetingSpoken` stays `false`, matching what the Live front-end
// actually passes on an outbound call (D-b, P-3).
// ---------------------------------------------------------------------------

/** The tenant's own business config -- unrelated to the campaign. */
const OUTBOUND_TENANT_CONFIG = {
  businessName: "Riverside Family Clinic",
  greeting: "Thanks for calling Riverside Family Clinic.",
  _hasCustomGreeting: true,
  timezone: "America/Chicago",
  businessHours: WEEKLY_HOURS,
  transferPhoneNumber: "+15551230000",
  // book_appointment/check_appointment/cancel_reschedule give "appointments" a
  // real tool to filter; take_message gives "messages" one too -- messages is
  // CORE and always registered on inbound (capabilities/messages.js), so
  // including it here is what proves the campaign intersection (D-c) actually
  // excludes a capability the campaign itself never listed, not merely one the
  // tenant never turned on.
  allowedTasks: normalizeAllowedTasks(["book_appointment", "check_appointment", "cancel_reschedule", "take_message"]),
  mainPhone: "555-0100",
  generalInfo: "We are a family practice serving the Riverside area since 1998.",
  afterHoursPolicy: "take_message",
  transferPolicy: "always",
  languagesSpoken: ["en"],
  customInstructions: null,
  recordingDisclosureEnabled: false,
  recordingDisclosureText: null,
};

/**
 * The campaign config (spec §7), as it lives on `outboundCall.config`. Values
 * match the shipped `speed_to_lead` template (lib/outbound/templates.js) --
 * literal here, not imported, so these fixtures do not silently drift the day
 * that template's defaults change.
 */
const SPEED_TO_LEAD_CAMPAIGN = {
  persona_name: "Ava",
  caller_id: "+441372656055",
  calling_window: { mon_fri: "09:00-20:00", sat: "10:00-16:00", sun: null, outside_window: "queue" },
  opener: "Hi, is that {first_name}? It's {persona_name}, an AI assistant from {business_name}.",
  topic: "your recent enquiry",
  objective: "Qualify the clinic and book a 30-minute discovery call.",
  notes: "",
  questions: [{ key: "clinic_name", ask: "What's the clinic called?", required: true, type: "text" }],
  // The shipped template's list verbatim. qualification/callback/opt_out/
  // outcome have no capability pack yet (spec §12.2 is stage 3) and
  // contribute no tool either way -- see the D-c intersection test.
  capabilities: ["qualification", "appointments", "transfer", "callback", "opt_out", "outcome"],
  booking: { adapter: "internal", length_min: 30 },
  transfer: null,
  retries: { schedule: ["now", "+10m", "+3h"], voicemail_on: [1], text_after_missed: [], give_up_after_days: 7 },
  voicemail:
    "Hi {first_name}, it's {persona_name}, the AI assistant from {business_name}, about your enquiry. " +
    "We'll try again later, or call us back on {caller_id_spoken}.",
  consent_window_days: 30,
  max_call_minutes: 10,
  // S3-6 goal + why_allowed (validateCampaign requires both). No call_reason
  // here on purpose: this fixture pins the neutral fallback sentence
  // (lib/outbound/prompt.js callReasonFor); speed-to-lead-call-reason sets one.
  goal: "qualify_then_book",
  why_allowed: "Every contact submitted our own enquiry form; this call follows up on that enquiry.",
};

/** `extras.outboundCall` (Task 14's key; also `state.outboundCall`). */
function outboundCallContext({
  campaignConfig = SPEED_TO_LEAD_CAMPAIGN,
  firstName = "Priya",
  templateKey = "speed_to_lead",
  triggerSummary = "source: web-form; service: teeth cleaning",
} = {}) {
  return {
    attemptId: "att-fixture-1",
    outreachId: "out-fixture-1",
    campaignId: "camp-fixture-1",
    campaignVersion: 1,
    contactId: "contact-fixture-1",
    attemptNo: 1,
    config: campaignConfig,
    campaign: { templateKey, complianceClass: "solicited", audience: "business" },
    contact: { firstName, timezone: "America/Chicago", phone: "+15559876543" },
    triggerSummary,
    openerText: firstName
      ? `Hi, is that ${firstName}? It's ${campaignConfig.persona_name}, an AI assistant from ${OUTBOUND_TENANT_CONFIG.businessName}.`
      : `It's ${campaignConfig.persona_name}, an AI assistant from ${OUTBOUND_TENANT_CONFIG.businessName}.`,
    openerAudio: null,
    openerRefused: false,
  };
}

const OUTBOUND_BASE_EXTRAS = {
  knowledge: [],
  callerContext: null,
  // D-b / P-3: always empty on outbound, whatever the stream sent.
  callerPhone: "",
  // The Live front-end has no TTS leg, so this is always false on every call
  // it makes -- inbound and outbound alike (see lib/voice/live/index.js).
  greetingSpoken: false,
  transferAllowed: true,
  integrations: [],
};

export const OUTBOUND_FIXTURES = {
  "speed-to-lead": {
    config: OUTBOUND_TENANT_CONFIG,
    extras: { ...OUTBOUND_BASE_EXTRAS, outboundCall: outboundCallContext() },
  },
  // 2026-10-01: the CLIP first-speaker mode (the rollback). Its snapshots are
  // byte-for-byte the pre-2026-10-01 speed-to-lead ones: clip mode's prompt and
  // tools must not change (spec 2026-10-01-outbound-live-first-line §6). The
  // fixtures without firstSpeaker are the live mode, the default.
  "speed-to-lead-clip": {
    config: OUTBOUND_TENANT_CONFIG,
    extras: { ...OUTBOUND_BASE_EXTRAS, outboundCall: { ...outboundCallContext(), firstSpeaker: "clip" } },
  },
  // O-2, disclosure flag ON: the tenant wants the transcription notice, and
  // (spec §9.3) the opener line above is exactly the line that gets played as
  // the backstop and seeded as Ava's own first turn -- so when that has
  // already happened, the OUTBOUND CALL block must defer the notice to her
  // NEXT reply rather than double up on a turn she never actually spoke.
  "speed-to-lead-disclosure-on": {
    config: { ...OUTBOUND_TENANT_CONFIG, recordingDisclosureEnabled: true },
    extras: { ...OUTBOUND_BASE_EXTRAS, outboundCall: outboundCallContext() },
  },
  // O-9: contacts.first_name is optional. With none on file, Ava must ask who
  // she is speaking to before she shares why she is calling.
  "speed-to-lead-no-first-name": {
    config: OUTBOUND_TENANT_CONFIG,
    extras: { ...OUTBOUND_BASE_EXTRAS, outboundCall: outboundCallContext({ firstName: null }) },
  },
  // Part 3's template (spec §7: "missed_call_callback ... arrives with Part
  // 3"). SHAPE ONLY -- the fields are plausible, not validated by
  // lib/outbound/campaignSchema.js. Its capabilities list only stage-3 names
  // no pack implements yet, so this also proves the D-c intersection degrades
  // safely: the model is left with exactly the two engine tools, never a
  // phantom one.
  // 2026-09-30: the campaign's own caller-facing reason and campaign notes
  // (the outbound stand-in for the tenant's inbound custom rules).
  "speed-to-lead-call-reason": {
    config: { ...OUTBOUND_TENANT_CONFIG, customInstructions: "INBOUND-ONLY RULE: ask every caller what they are coming in for." },
    extras: {
      ...OUTBOUND_BASE_EXTRAS,
      outboundCall: outboundCallContext({
        campaignConfig: {
          ...SPEED_TO_LEAD_CAMPAIGN,
          call_reason: "You asked us to call you back about a cleaning appointment.",
          notes: "Our new-patient special ends on Friday; mention it only if they ask about prices.",
        },
      }),
    },
  },
  "missed-call-callback": {
    config: OUTBOUND_TENANT_CONFIG,
    extras: {
      ...OUTBOUND_BASE_EXTRAS,
      outboundCall: outboundCallContext({
        templateKey: "missed_call_callback",
        triggerSummary: "source: missed-call",
        campaignConfig: {
          ...SPEED_TO_LEAD_CAMPAIGN,
          topic: "the call we missed from them",
          objective: "Find out what they needed and offer to help or book them in.",
          capabilities: ["qualification", "callback", "opt_out", "outcome"],
        },
      }),
    },
  },
};

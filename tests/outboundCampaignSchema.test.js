import { describe, it, expect } from "vitest";
import {
  validateCampaign,
  renderTemplate,
  spokenNumber,
  AI_DISCLOSURE_RE,
  buildCampaignSchemaExport,
  REFUSED_IN_PART1,
  TEMPLATE_PLACEHOLDERS,
} from "../lib/outbound/campaignSchema.js";
import { TEMPLATES, PURPOSE_BY_TEMPLATE } from "../lib/outbound/templates.js";

const META = { name: "Speed to lead", template_key: "speed_to_lead", compliance_class: "solicited", audience: "business" };
const good = () => ({ ...structuredClone(TEMPLATES.speed_to_lead), caller_id: "+441372656055" });
const v = (cfg, meta = META) => validateCampaign(meta, cfg, { businessName: "Digile Media" });
const errPaths = (r) => r.errors.map((e) => e.path);

describe("validateCampaign: the template is valid once a caller ID is set", () => {
  it("accepts speed_to_lead + caller_id", () => expect(v(good())).toEqual({ ok: true, value: good() }));
  it("rejects speed_to_lead as shipped, because caller_id is blank", () => expect(errPaths(v(TEMPLATES.speed_to_lead))).toContain("caller_id"));
  it("maps speed_to_lead to the enquiry_followup consent purpose", () => expect(PURPOSE_BY_TEMPLATE.speed_to_lead).toBe("enquiry_followup"));
});

describe("validateCampaign: every refusal (each one is a coded rule because ignoring it hurts someone)", () => {
  it("unknown keys are rejected (strict), not dropped", () => expect(errPaths(v({ ...good(), surprise: 1 }))).toContain("surprise"));
  it("opener without {business_name}", () =>
    expect(errPaths(v({ ...good(), opener: "Hi {first_name}, it's {persona_name}, an AI assistant. Got a minute?" }))).toContain("opener"));
  it("opener without an AI disclosure", () =>
    expect(errPaths(v({ ...good(), opener: "Hi {first_name}, it's {persona_name} from {business_name}. Got a minute?" }))).toContain("opener"));
  it("voicemail without an AI disclosure", () =>
    expect(errPaths(v({ ...good(), voicemail: "Hi {first_name}, {business_name} here, call us back." }))).toContain("voicemail"));
  it("opener that renders over 120 characters with a 30-character first name is refused, never truncated (it is the backstop line)", () =>
    expect(errPaths(v({ ...good(), opener: "Hi {first_name}, {business_name} AI " + "x".repeat(80) }))).toContain("opener"));
  it("voicemail that renders over 300 characters is refused", () =>
    expect(errPaths(v({ ...good(), voicemail: "Hi {first_name}, the AI assistant from {business_name}. " + "x".repeat(260) }))).toContain("voicemail"));
  it("the shipped demo opener fits the 120-character budget with a 30-character first name", () =>
    expect(v(good()).ok).toBe(true));
  it("an unknown placeholder is refused", () =>
    expect(errPaths(v({ ...good(), opener: "Hi {firstname}, AI from {business_name}" }))).toContain("opener"));
  it("a calling window starting before 08:00 is refused", () =>
    expect(errPaths(v({ ...good(), calling_window: { ...good().calling_window, mon_fri: "07:30-20:00" } }))).toContain("calling_window.mon_fri"));
  it("a calling window ending after 21:00 is refused", () =>
    expect(errPaths(v({ ...good(), calling_window: { ...good().calling_window, sat: "10:00-21:30" } }))).toContain("calling_window.sat"));
  it("a window with no open day at all is refused", () =>
    expect(errPaths(v({ ...good(), calling_window: { mon_fri: null, sat: null, sun: null, outside_window: "queue" } }))).toContain("calling_window"));
  // O-24/a9 (post-2c): a calling-window entry under 30 minutes is refused.
  it("a 1-minute window (20:59-21:00) is refused", () =>
    expect(errPaths(v({ ...good(), calling_window: { ...good().calling_window, sat: "20:59-21:00" } }))).toContain("calling_window.sat"));
  it("a 29-minute window (09:00-09:29) is refused", () =>
    expect(errPaths(v({ ...good(), calling_window: { ...good().calling_window, sat: "09:00-09:29" } }))).toContain("calling_window.sat"));
  it("exactly 30 minutes (09:00-09:30) is allowed", () =>
    expect(v({ ...good(), calling_window: { ...good().calling_window, sat: "09:00-09:30" } }).ok).toBe(true));
  it("the shipped speed_to_lead template's own windows (11h, 6h) are still valid", () => expect(v(good()).ok).toBe(true));
  it("marketing_consented is refused in Part 1 with a message naming Part 3", () => {
    const r = v(good(), { ...META, compliance_class: "marketing_consented" });
    expect(r.errors.find((e) => e.path === "compliance_class").message).toMatch(/Part 3/);
  });
  it("audience patient is refused in Part 1", () => expect(errPaths(v(good(), { ...META, audience: "patient" }))).toContain("audience"));
  it("more than 6 retry entries", () =>
    expect(errPaths(v({ ...good(), retries: { ...good().retries, schedule: ["now", "+10m", "+1h", "+2h", "+3h", "+4h", "+5h"] } }))).toContain("retries.schedule"));
  it("a malformed retry entry", () =>
    expect(errPaths(v({ ...good(), retries: { ...good().retries, schedule: ["now", "+10s"] } }))).toContain("retries.schedule[1]"));
  it("give_up_after_days over 30", () =>
    expect(errPaths(v({ ...good(), retries: { ...good().retries, give_up_after_days: 31 } }))).toContain("retries.give_up_after_days"));
  it("voicemail_on naming an attempt the schedule does not have", () =>
    expect(errPaths(v({ ...good(), retries: { ...good().retries, voicemail_on: [9] } }))).toContain("retries.voicemail_on"));
  it("consent_window_days over 90", () => expect(errPaths(v({ ...good(), consent_window_days: 91 }))).toContain("consent_window_days"));
  it("notes over 2000 characters are refused, never sliced", () => expect(errPaths(v({ ...good(), notes: "n".repeat(2001) }))).toContain("notes"));
  it("persona_name over 30 characters", () => expect(errPaths(v({ ...good(), persona_name: "p".repeat(31) }))).toContain("persona_name"));
  it("a caller_id that is not E.164", () => expect(errPaths(v({ ...good(), caller_id: "01372 656055" }))).toContain("caller_id"));
  it("opt_out cannot be switched off -- a stop request must always work", () =>
    expect(errPaths(v({ ...good(), capabilities: ["qualification", "appointments"] }))).toContain("capabilities"));
  it("an unknown capability", () => expect(errPaths(v({ ...good(), capabilities: [...good().capabilities, "telepathy"] }))).toContain("capabilities"));
  it("a question key that is not snake_case", () =>
    expect(errPaths(v({ ...good(), questions: [{ key: "Clinic Name", ask: "?", required: true, type: "text" }] }))).toContain("questions[0].key"));
});

describe("renderTemplate / spokenNumber", () => {
  it("fills known placeholders and leaves nothing else changed", () =>
    expect(renderTemplate("Hi {first_name}, {business_name}", { first_name: "Sam", business_name: "Digile" })).toBe("Hi Sam, Digile"));
  it("reads a UK number in national form, grouped for speech", () => expect(spokenNumber("+441372656055")).toBe("01372 656 055"));
  it("AI_DISCLOSURE_RE is the spec's regex", () => expect(AI_DISCLOSURE_RE.source).toBe("\\b(AI|artificial intelligence|automated assistant|virtual assistant)\\b"));
});

// O-24/a8 (post-2c): 02x numbers (020 London, and 023/024/028/029, which
// share the shape) are spoken 3+4+4, never the generic 5+3+3 grouping.
describe("O-24/a8: spokenNumber groups UK 02x numbers as 02X XXXX XXXX", () => {
  it("020 (London)", () => expect(spokenNumber("+442071234567")).toBe("020 7123 4567"));
  it("029 (Cardiff)", () => expect(spokenNumber("+442920123456")).toBe("029 2012 3456"));
  it("023 (Southampton/Portsmouth)", () => expect(spokenNumber("+442380123456")).toBe("023 8012 3456"));
  it("024 (Coventry)", () => expect(spokenNumber("+442476123456")).toBe("024 7612 3456"));
  it("028 (Northern Ireland)", () => expect(spokenNumber("+442890123456")).toBe("028 9012 3456"));
  it("a mobile (07x) is unaffected", () => expect(spokenNumber("+447700900333")).toBe("07700 900 333"));
  it("a standard landline (01x) is unaffected", () => expect(spokenNumber("+441372656055")).toBe("01372 656 055"));
});

// Fix round 1 (opus review): four silent-pass holes in validateCampaign, each
// one a bad campaign that used to save with NO error.
describe("fix round 1 -- IMPORTANT 1: the disclosure check cannot be beaten by gluing AI onto a placeholder", () => {
  it("{persona_name}AI glued with no space is refused, even though it renders as e.g. 'AvaAI'", () =>
    expect(errPaths(v({ ...good(), opener: "Hi {first_name}, it's {persona_name}AI from {business_name}." }))).toContain("opener"));
  it("AI{business_name} glued with no space is refused", () =>
    expect(errPaths(v({ ...good(), opener: "Hi {first_name}, AI{business_name} calling." }))).toContain("opener"));
  it("a voicemail with {caller_id_spoken}AI glued is refused", () =>
    expect(errPaths(v({ ...good(), voicemail: "Hi {first_name}, {business_name} here. Ring {caller_id_spoken}AI now." }))).toContain("voicemail"));
  it("the shipped template's real 'an AI assistant' (bounded by spaces, not a placeholder) still passes", () => expect(v(good()).ok).toBe(true));
});

describe("fix round 1 -- IMPORTANT 2: a missing business name cannot pass", () => {
  it("no businessName argument at all is refused, not silently ok", () => {
    const r = validateCampaign(META, good());
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.path)).toContain("business_name");
  });
  it("a null options argument does not throw, and is refused for a missing business_name", () => {
    expect(() => validateCampaign(META, good(), null)).not.toThrow();
    expect(errPaths(validateCampaign(META, good(), null))).toContain("business_name");
  });
  it("an empty-string businessName is refused", () => expect(errPaths(validateCampaign(META, good(), { businessName: "" }))).toContain("business_name"));
  it("a whitespace-only businessName is refused", () => expect(errPaths(validateCampaign(META, good(), { businessName: "   " }))).toContain("business_name"));
});

describe("fix round 1 -- IMPORTANT 3 (ruling): template_key is validated, and only speed_to_lead ships in Part 1", () => {
  it("an unknown template_key is refused", () => expect(errPaths(v(good(), { ...META, template_key: "bogus" }))).toContain("template_key"));
  it("reactivation is a real template_key but refused in Part 1, naming Part 3 (it would otherwise dodge the marketing_consented refusal)", () => {
    const r = v(good(), { ...META, template_key: "reactivation" });
    expect(r.errors.find((e) => e.path === "template_key").message).toMatch(/Part 3/);
  });
});

describe("fix round 1 -- IMPORTANT 4: unknown nested keys are refused, not silently accepted", () => {
  it("an unknown calling_window key (sunday) is refused at calling_window.sunday", () =>
    expect(errPaths(v({ ...good(), calling_window: { ...good().calling_window, sunday: "07:00-23:00" } }))).toContain("calling_window.sunday"));
  it("the typo mon-fri (hyphen) is an unknown key, not a silently-ignored alias for mon_fri", () =>
    expect(errPaths(v({ ...good(), calling_window: { ...good().calling_window, "mon-fri": "09:00-18:00" } }))).toContain("calling_window.mon-fri"));
  it("an unknown retries key (max_attempts) is refused at retries.max_attempts", () =>
    expect(errPaths(v({ ...good(), retries: { ...good().retries, max_attempts: 50 } }))).toContain("retries.max_attempts"));
  it("an unknown booking key is refused at booking.x", () => expect(errPaths(v({ ...good(), booking: { ...good().booking, x: 1 } }))).toContain("booking.x"));
  it("an unknown question key (options) is refused at questions[0].options", () =>
    expect(errPaths(v({ ...good(), questions: [{ key: "clinic_name", ask: "What's the clinic called?", required: true, type: "text", options: ["a", "b"] }] })))
      .toContain("questions[0].options"));
});

describe("fix round 1 -- Minor M1: the export derives windowBounds/refusedInPart1 from the same constants the validator reads", () => {
  it("the export carries the disclosure regex's flags, not just its source", () => expect(buildCampaignSchemaExport().aiDisclosureFlags).toBe("i"));
});

describe("fix round 1 -- Minor M3: a missing meta object refuses every required meta field, rather than passing", () => {
  it("meta = {} refuses name, template_key, compliance_class and audience", () => {
    const paths = errPaths(v(good(), {}));
    expect(paths).toEqual(expect.arrayContaining(["name", "template_key", "compliance_class", "audience"]));
  });
  it("meta = null does the same, without throwing", () => {
    expect(() => v(good(), null)).not.toThrow();
    const paths = errPaths(v(good(), null));
    expect(paths).toEqual(expect.arrayContaining(["name", "template_key", "compliance_class", "audience"]));
  });
});

describe("fix round 1 -- Minor M4: bounded fields must be whole numbers, capped, and 'required' when absent", () => {
  it("a fractional consent_window_days is refused", () => expect(errPaths(v({ ...good(), consent_window_days: 30.5 }))).toContain("consent_window_days"));
  it("a fractional retries.give_up_after_days is refused", () =>
    expect(errPaths(v({ ...good(), retries: { ...good().retries, give_up_after_days: 7.5 } }))).toContain("retries.give_up_after_days"));
  it("a fractional max_call_minutes is refused", () => expect(errPaths(v({ ...good(), max_call_minutes: 10.5 }))).toContain("max_call_minutes"));
  it("a fractional booking.length_min is refused", () => expect(errPaths(v({ ...good(), booking: { ...good().booking, length_min: 30.5 } }))).toContain("booking.length_min"));
  it("booking.length_min over the 240-minute cap is refused", () => expect(errPaths(v({ ...good(), booking: { ...good().booking, length_min: 241 } }))).toContain("booking.length_min"));
  it("a missing consent_window_days gets a 'required' message, not a bound message", () => {
    const r = v({ ...good(), consent_window_days: undefined });
    const e = r.errors.find((e) => e.path === "consent_window_days");
    expect(e.message).toMatch(/required/i);
    expect(e.message).not.toMatch(/at most/i);
  });
});

describe("fix round 1 -- Minor M5: the retry schedule must have at least one entry", () => {
  it("an empty retry schedule is refused", () => expect(errPaths(v({ ...good(), retries: { ...good().retries, schedule: [] } }))).toContain("retries.schedule"));
});

// O-24/a7 (post-2c): a persona_name that is only the AI disclosure itself
// (after the shared foldDottedAI fold) must not save -- "It's AI, an AI
// assistant from..." tells the caller nothing a real name would.
describe("O-24/a7: persona_name must not double as the AI disclosure", () => {
  it.each(["AI", "Ai", "A.I.", "a. i."])("persona_name %j is refused", (persona_name) =>
    expect(errPaths(v({ ...good(), persona_name }))).toContain("persona_name"));
  it.each(["Aiden", "Aisha", "Kai"])("persona_name %j is allowed", (persona_name) =>
    expect(v({ ...good(), persona_name }).ok).toBe(true));
});

// ---------------------------------------------------------------------------
// S3-6 (spec §19, S3-D4): goal-driven campaign fields + the `custom` template.
// ---------------------------------------------------------------------------

describe("S3-6: goal is required, and each goal needs its capabilities (named risk 2)", () => {
  it("goal is required", () => expect(errPaths(v({ ...good(), goal: undefined }))).toContain("goal"));
  it("an unknown goal value is refused, naming the real ones", () => {
    const r = v({ ...good(), goal: "sell_stuff" });
    const e = r.errors.find((e) => e.path === "goal");
    expect(e).toBeTruthy();
    expect(e.message).toMatch(/book/);
  });

  it("book requires the appointments capability, and is refused naming it when missing", () => {
    const r = v({ ...good(), goal: "book", capabilities: ["opt_out"] });
    const e = r.errors.find((e) => e.path === "capabilities");
    expect(e).toBeTruthy();
    expect(e.message).toMatch(/\bappointments\b/);
  });
  it("book with appointments (and opt_out) passes", () =>
    expect(v({ ...good(), goal: "book", capabilities: ["appointments", "opt_out"] }).ok).toBe(true));

  it("qualify_then_book requires BOTH qualification and appointments, naming both when missing", () => {
    const r = v({ ...good(), goal: "qualify_then_book", capabilities: ["opt_out"] });
    const e = r.errors.find((e) => e.path === "capabilities");
    expect(e).toBeTruthy();
    expect(e.message).toMatch(/qualification/);
    expect(e.message).toMatch(/appointments/);
  });
  it("qualify_then_book missing only appointments names only appointments", () => {
    const r = v({ ...good(), goal: "qualify_then_book", capabilities: ["qualification", "opt_out"] });
    const e = r.errors.find((e) => e.path === "capabilities");
    expect(e.message).toMatch(/appointments/);
    expect(e.message).not.toMatch(/qualification/);
  });
  it("the shipped speed_to_lead template (qualify_then_book) already carries both capabilities", () =>
    expect(v(good()).ok).toBe(true));

  it("confirm_or_move requires appointments", () =>
    expect(errPaths(v({ ...good(), goal: "confirm_or_move", capabilities: ["opt_out"] }))).toContain("capabilities"));
  it("confirm_or_move with appointments passes", () =>
    expect(v({ ...good(), goal: "confirm_or_move", capabilities: ["appointments", "opt_out"] }).ok).toBe(true));

  it("get_review needs no extra capability, just its own required field", () =>
    expect(v({ ...good(), goal: "get_review", review_url: "https://example.test/review", capabilities: ["opt_out"] }).ok).toBe(true));
  it("pass_message needs no extra capability, just its own required field", () =>
    expect(v({ ...good(), goal: "pass_message", message_text: "They called about their invoice.", capabilities: ["opt_out"] }).ok).toBe(true));
  it("find_need needs no extra capability at all", () =>
    expect(v({ ...good(), goal: "find_need", capabilities: ["opt_out"] }).ok).toBe(true));
});

describe("S3-6: why_allowed is required, <= 300 characters, never spoken", () => {
  it("why_allowed is required", () => expect(errPaths(v({ ...good(), why_allowed: undefined }))).toContain("why_allowed"));
  it("an empty why_allowed is refused", () => expect(errPaths(v({ ...good(), why_allowed: "   " }))).toContain("why_allowed"));
  it("why_allowed over 300 characters is refused", () => expect(errPaths(v({ ...good(), why_allowed: "x".repeat(301) }))).toContain("why_allowed"));
  it("exactly 300 characters is allowed", () => expect(v({ ...good(), why_allowed: "x".repeat(300) }).ok).toBe(true));
});

describe("S3-6: language is optional, en-GB or en-US when set", () => {
  it("absent is fine -- the tenant's own default applies at runtime", () => expect(v(good()).ok).toBe(true));
  it("an unrecognised language is refused", () => expect(errPaths(v({ ...good(), language: "fr-FR" }))).toContain("language"));
  it("en-US is allowed", () => expect(v({ ...good(), language: "en-US" }).ok).toBe(true));
  it("en-GB is allowed", () => expect(v({ ...good(), language: "en-GB" }).ok).toBe(true));
});

describe("S3-6: review_url (https only, required iff goal get_review) and message_text (<=300, required iff goal pass_message)", () => {
  it("review_url is required when goal is get_review", () => expect(errPaths(v({ ...good(), goal: "get_review" }))).toContain("review_url"));
  it("review_url must be https, not http", () =>
    expect(errPaths(v({ ...good(), goal: "get_review", review_url: "http://example.test/review" }))).toContain("review_url"));
  it("a well-formed https review_url passes", () =>
    expect(v({ ...good(), goal: "get_review", review_url: "https://example.test/review" }).ok).toBe(true));
  it("review_url, if present on a non-get_review campaign, is still validated for shape", () =>
    expect(errPaths(v({ ...good(), review_url: "not-a-url" }))).toContain("review_url"));

  it("message_text is required when goal is pass_message", () => expect(errPaths(v({ ...good(), goal: "pass_message" }))).toContain("message_text"));
  it("message_text over 300 characters is refused", () =>
    expect(errPaths(v({ ...good(), goal: "pass_message", message_text: "x".repeat(301) }))).toContain("message_text"));
  it("a well-formed message_text passes", () =>
    expect(v({ ...good(), goal: "pass_message", message_text: "Please call the office back." }).ok).toBe(true));
});

describe("S3-6: details_fields (<=10 entries of {key, label}), and never a placeholder the opener/voicemail can reach (named risk 3)", () => {
  it("absent is fine", () => expect(v(good()).ok).toBe(true));
  it("a valid entry passes", () => expect(v({ ...good(), details_fields: [{ key: "appt_date", label: "Appointment date" }] }).ok).toBe(true));
  it("more than 10 entries is refused", () => {
    const fields = Array.from({ length: 11 }, (_, i) => ({ key: `field_${i}`, label: `Field ${i}` }));
    expect(errPaths(v({ ...good(), details_fields: fields }))).toContain("details_fields");
  });
  it("a key that is not snake_case is refused", () =>
    expect(errPaths(v({ ...good(), details_fields: [{ key: "Appt Date", label: "Appointment date" }] }))).toContain("details_fields[0].key"));
  it("a key over 32 characters is refused", () =>
    expect(errPaths(v({ ...good(), details_fields: [{ key: "a".repeat(33), label: "x" }] }))).toContain("details_fields[0].key"));
  it("a duplicate key is refused", () =>
    expect(errPaths(v({ ...good(), details_fields: [{ key: "appt_date", label: "A" }, { key: "appt_date", label: "B" }] }))).toContain("details_fields[1].key"));
  it("a label over 40 characters is refused", () =>
    expect(errPaths(v({ ...good(), details_fields: [{ key: "appt_date", label: "x".repeat(41) }] }))).toContain("details_fields[0].label"));
  it("an unknown nested key is refused, not silently accepted", () =>
    expect(errPaths(v({ ...good(), details_fields: [{ key: "appt_date", label: "Date", extra: 1 }] }))).toContain("details_fields[0].extra"));

  // Named risk 3's structural half: renderCampaignLine (the ONE function that
  // renders the opener/voicemail) only ever fills TEMPLATE_PLACEHOLDERS, so a
  // details_fields key can never reach the opener/voicemail even if someone
  // writes {appt_date} into one -- it is refused at save as an unknown
  // placeholder, the same as any other made-up token.
  it("a details_fields key used as an opener placeholder is refused as unknown -- it can never reach the spoken line", () =>
    expect(errPaths(v({ ...good(), details_fields: [{ key: "appt_date", label: "Appointment date" }], opener: "Hi {first_name}, it's {persona_name}, an AI assistant from {business_name}. Your date: {appt_date}." })))
      .toContain("opener"));
  it("TEMPLATE_PLACEHOLDERS never includes a details-shaped name", () => {
    expect(TEMPLATE_PLACEHOLDERS).not.toContain("details");
    expect(TEMPLATE_PLACEHOLDERS.some((p) => p.startsWith("detail"))).toBe(false);
  });
});

describe("S3-6: caller_id becomes optional (defaults to the business number at dispatch; named risk 6)", () => {
  it("absent is fine at save -- dispatch.js fills in the business's own number", () => {
    const cfg = good();
    delete cfg.caller_id;
    expect(v(cfg).ok).toBe(true);
  });
  it("present, it is still validated as a real E.164 number", () => expect(errPaths(v({ ...good(), caller_id: "01372 656055" }))).toContain("caller_id"));
  it("the shipped template's own blank placeholder (\"\") is still refused -- optional means absent, not blank", () =>
    expect(errPaths(v({ ...good(), caller_id: "" }))).toContain("caller_id"));
});

describe("S3-6: unknown-key strictness still holds with the 7 new keys added", () => {
  it("a near-miss of a real key (goals, plural) is still rejected", () => expect(errPaths(v({ ...good(), goals: ["book"] }))).toContain("goals"));
  it("ALLOWED_KEYS strictness is unchanged in kind -- ALL 7 new keys accepted, one bogus key still refused", () => {
    const cfg = {
      ...good(),
      details_fields: [{ key: "appt_date", label: "Appointment date" }],
      language: "en-US",
      review_url: "https://example.test/review", // unused outside get_review, but shape-valid
      message_text: "A message.",
      bogus_field: 1,
    };
    expect(errPaths(v(cfg))).toEqual(["bogus_field"]);
  });
});

describe("S3-6: the custom template is allowed, and custom_basis maps to compliance_class at save (3 cases)", () => {
  const customMeta = (complianceClass) => ({ name: "Custom outreach", template_key: "custom", compliance_class: complianceClass, audience: "business" });

  it("custom is no longer in REFUSED_IN_PART1.template_key", () => expect(REFUSED_IN_PART1.template_key).not.toContain("custom"));
  it("every other template_key is still refused (the filter did not over-widen)", () => {
    expect(REFUSED_IN_PART1.template_key).toEqual(
      expect.arrayContaining(["missed_call_callback", "reminder", "no_show", "aftercare", "review_request", "reactivation"])
    );
    expect(REFUSED_IN_PART1.template_key).toHaveLength(6);
  });
  it("custom_basis is required when template_key is custom", () =>
    expect(errPaths(v(good(), customMeta("solicited")))).toContain("custom_basis"));
  it("custom_basis absent is fine for other template_keys (nothing to check)", () => expect(v(good()).ok).toBe(true));

  // C4 (review): off template_key "custom", custom_basis previously did
  // NOTHING -- silently ignored, no feedback that the value did not matter.
  it("C4: custom_basis SET on a non-custom template_key is refused at save (was silently inert before this fix)", () => {
    const r = v({ ...good(), custom_basis: "asked_to_be_contacted" }); // good() defaults to speed_to_lead
    const e = r.errors.find((e) => e.path === "custom_basis");
    expect(e).toBeTruthy();
    expect(e.message).toMatch(/only meaningful when template_key is "custom"/);
  });

  it("case 1: asked_to_be_contacted + compliance_class solicited passes, and maps to purpose enquiry_followup", () => {
    expect(v({ ...good(), custom_basis: "asked_to_be_contacted" }, customMeta("solicited")).ok).toBe(true);
    expect(PURPOSE_BY_TEMPLATE.custom).toBe("enquiry_followup");
  });
  it("asked_to_be_contacted with any other compliance_class is refused, naming the required class", () => {
    const r = v({ ...good(), custom_basis: "asked_to_be_contacted" }, customMeta("service"));
    const e = r.errors.find((e) => e.path === "compliance_class");
    expect(e).toBeTruthy();
    expect(e.message).toMatch(/solicited/);
  });

  it("case 2: existing_customer + compliance_class service passes", () =>
    expect(v({ ...good(), custom_basis: "existing_customer" }, customMeta("service")).ok).toBe(true));
  it("existing_customer with any other compliance_class is refused, naming the required class", () => {
    const r = v({ ...good(), custom_basis: "existing_customer" }, customMeta("solicited"));
    const e = r.errors.find((e) => e.path === "compliance_class");
    expect(e).toBeTruthy();
    expect(e.message).toMatch(/service/);
  });

  it('case 3: selling is refused outright, naming "Part 3", regardless of compliance_class', () => {
    const r = v({ ...good(), custom_basis: "selling" }, customMeta("solicited"));
    const e = r.errors.find((e) => e.path === "custom_basis");
    expect(e).toBeTruthy();
    expect(e.message).toMatch(/Part 3/);
  });
  it("an unknown custom_basis value is refused", () =>
    expect(errPaths(v({ ...good(), custom_basis: "bogus" }, customMeta("solicited")))).toContain("custom_basis"));
});

// 2026-10-01 (spec 2026-10-01-outbound-live-first-line §3): the opener is now
// "the intro the first reply is built on" (live mode) -- disclosure, business,
// then the name check -- and still a valid opener for the clip rollback.
describe("speed_to_lead's default intro (2026-10-01)", () => {
  // Final review #7 (ruling R27): the spec's sentence ("Hi, this is {persona_name}, an AI assistant
  // calling from {business_name}. Am I speaking with {first_name}?") rendered past the 120-character
  // budget for business names of 23+ characters, so saving the default campaign failed for them.
  // Same three parts, the pre-2026-10-01 capacity (business names up to 45).
  it("is the intro: persona, AI assistant, business, then the name check", () => {
    expect(TEMPLATES.speed_to_lead.opener).toBe("Hi, it's {persona_name}, an AI assistant from {business_name}. Is that {first_name}?");
  });
  it("saves for a 40-character business name with the 30-character worst-case first name", () => {
    const longName = "Brightwork Family Dental and Implant Clinic".slice(0, 40);
    expect(longName).toHaveLength(40);
    expect(validateCampaign(META, good(), { businessName: longName })).toMatchObject({ ok: true });
  });
  it("still passes the opener validation (business name, bounded AI disclosure, 120 chars rendered)", () => {
    expect(v(good())).toMatchObject({ ok: true });
  });
});

// 2026-10-01 (spec 2026-10-01-outbound-live-first-line §5b): `confirm` on a
// question -- optional boolean, text questions only.
describe("questions[].confirm (read-back, spec §5b)", () => {
  const withQ = (q) => ({ ...good(), questions: [{ key: "clinic_name", ask: "What's the clinic called?", required: true, type: "text", ...q }] });
  it("accepts confirm: true on a text question, and confirm: false / absent", () => {
    expect(v(withQ({ confirm: true }))).toMatchObject({ ok: true });
    expect(v(withQ({ confirm: false }))).toMatchObject({ ok: true });
    expect(v(withQ({}))).toMatchObject({ ok: true });
  });
  it("refuses a non-boolean confirm", () => {
    expect(errPaths(v(withQ({ confirm: "yes" })))).toContain("questions[0].confirm");
    expect(errPaths(v(withQ({ confirm: 1 })))).toContain("questions[0].confirm");
  });
  it("refuses confirm: true on a non-text question", () => {
    expect(errPaths(v(withQ({ type: "yes_no", confirm: true })))).toContain("questions[0].confirm");
    expect(errPaths(v(withQ({ type: "number", confirm: true })))).toContain("questions[0].confirm");
  });
  it("speed_to_lead marks nothing confirm (unchanged behaviour)", () => {
    expect(TEMPLATES.speed_to_lead.questions.some((q) => q.confirm === true)).toBe(false);
  });
});

describe("validateCampaign: transfer.to is price-checked at save", () => {
  const withTransfer = (to) => ({ ...good(), transfer: { to, when: "Mon-Fri 09:00-17:00", whisper: true } });
  const transferErrors = (to) => v(withTransfer(to)).errors?.filter((e) => e.path === "transfer.to") ?? [];
  it("a never number (UK premium 090) is refused with the never message", () => {
    const e = transferErrors("+449090123456");
    expect(e).toHaveLength(1);
    expect(e[0].message).toMatch(/premium-rate/);
  });
  it("a Tunisia mobile (over the ceiling) is refused", () => {
    const e = transferErrors("+21650123456");
    expect(e).toHaveLength(1);
    expect(e[0].message).toMatch(/cost more than we allow/);
  });
  it("an EU mobile (needs switch-on) is accepted at save; the dial-time check decides", () => {
    expect(v(withTransfer("+33612345678")).ok).toBe(true);
  });
  it("a UK landline is accepted", () => {
    expect(v(withTransfer("+442079460958")).ok).toBe(true);
  });
});

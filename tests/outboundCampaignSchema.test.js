import { describe, it, expect } from "vitest";
import { validateCampaign, renderTemplate, spokenNumber, AI_DISCLOSURE_RE, buildCampaignSchemaExport } from "../lib/outbound/campaignSchema.js";
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

import { describe, it, expect } from "vitest";
import { validateCampaign, renderTemplate, spokenNumber, AI_DISCLOSURE_RE } from "../lib/outbound/campaignSchema.js";
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

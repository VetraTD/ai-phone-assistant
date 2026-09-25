// tests/outboundCampaignLine.test.js
/**
 * Task 14 fix round 2, owner decision O-9: `renderCampaignLine`
 * (lib/outbound/campaignSchema.js) is the ONE renderer for the lines Ava
 * speaks from a campaign template -- dispatch renders the clip text with it,
 * the Live session re-renders the seed with it.
 *
 * With no first name, the template's sentences that use {first_name} are
 * dropped, and the remainder is used only if it still carries the business
 * name AND the §7 AI disclosure. Sentences split after `.`, `?` or `!`
 * followed by whitespace, on the TEMPLATE (never the rendered text).
 * Nothing it returns can contain "null", "undefined" or an unfilled "{key}".
 */
import { describe, it, expect } from "vitest";
import { renderCampaignLine, SENTENCE_SPLIT_RE, validateCampaign } from "../lib/outbound/campaignSchema.js";
import { TEMPLATES } from "../lib/outbound/templates.js";

const CONFIG = { ...TEMPLATES.speed_to_lead, caller_id: "+441372656055" };
const BIZ = "Digile Media";
const NO_NAMES = [null, undefined, "", "   "];

describe("the sentence rule", () => {
  it("splits after . ? ! followed by whitespace, and only there", () => {
    expect("Hi, is that {first_name}? It's {persona_name}, an AI assistant from {business_name}.".split(SENTENCE_SPLIT_RE)).toEqual([
      "Hi, is that {first_name}?",
      "It's {persona_name}, an AI assistant from {business_name}.",
    ]);
    expect("One. Two! Three? Four".split(SENTENCE_SPLIT_RE)).toEqual(["One.", "Two!", "Three?", "Four"]);
    expect("No split here...no space".split(SENTENCE_SPLIT_RE)).toEqual(["No split here...no space"]);
  });
});

describe("renderCampaignLine, the shipped speed_to_lead template", () => {
  it("with a first name: the whole opener, as before", () => {
    expect(renderCampaignLine(CONFIG.opener, { firstName: "Sam", businessName: BIZ, config: CONFIG })).toBe(
      "Hi, is that Sam? It's Ava, an AI assistant from Digile Media."
    );
  });

  it.each(NO_NAMES)("no first name (%j): the opener drops its first sentence and keeps the disclosure", (firstName) => {
    expect(renderCampaignLine(CONFIG.opener, { firstName, businessName: BIZ, config: CONFIG })).toBe(
      "It's Ava, an AI assistant from Digile Media."
    );
  });

  it("with a first name: the whole voicemail", () => {
    expect(renderCampaignLine(CONFIG.voicemail, { firstName: "Sam", businessName: BIZ, config: CONFIG })).toBe(
      "Hi Sam, it's Ava, the AI assistant from Digile Media, about your enquiry. We'll try again later, or call us back on 01372 656 055."
    );
  });

  it.each(NO_NAMES)("no first name (%j): the voicemail's remainder has neither the name nor the disclosure -> no voicemail", (firstName) => {
    expect(renderCampaignLine(CONFIG.voicemail, { firstName, businessName: BIZ, config: CONFIG })).toBeNull();
  });
});

describe("renderCampaignLine, the usability rule", () => {
  it("a remainder with the disclosure but not the business name is no line", () => {
    const tpl = "Hi {first_name}, it's {business_name}. I'm {persona_name}, an AI assistant.";
    expect(renderCampaignLine(tpl, { firstName: null, businessName: BIZ, config: CONFIG })).toBeNull();
  });

  it("a remainder with the business name but not the disclosure is no line", () => {
    const tpl = "Hi {first_name}, I'm an AI assistant. This is {business_name} calling.";
    expect(renderCampaignLine(tpl, { firstName: null, businessName: BIZ, config: CONFIG })).toBeNull();
  });

  it("a template that is nothing but first-name sentences is no line", () => {
    expect(renderCampaignLine("Hi {first_name}!", { firstName: "", businessName: BIZ, config: CONFIG })).toBeNull();
  });

  it("a business name containing a full stop does not split a sentence (the TEMPLATE is split, not the text)", () => {
    expect(renderCampaignLine(CONFIG.opener, { firstName: null, businessName: "Dr. Patel Clinic", config: CONFIG })).toBe(
      "It's Ava, an AI assistant from Dr. Patel Clinic."
    );
  });
});

describe("never 'null', 'undefined' or an unfilled placeholder", () => {
  const values = [null, undefined, "", "   "];
  const templates = [CONFIG.opener, CONFIG.voicemail, "{persona_name} from {business_name}, an AI assistant, about {topic}."];

  it("whatever is missing, every rendered line is clean or null", () => {
    for (const tpl of templates) {
      for (const firstName of [...values, "Sam"]) {
        for (const businessName of [...values, BIZ]) {
          for (const persona of [...values, "Ava"]) {
            for (const topic of [...values, "your enquiry"]) {
              const out = renderCampaignLine(tpl, { firstName, businessName, config: { ...CONFIG, persona_name: persona, topic } });
              if (out !== null) {
                expect(out).not.toMatch(/\bnull\b|\bundefined\b/);
                expect(out).not.toMatch(/\{[a-zA-Z0-9_]+\}/);
              }
            }
          }
        }
      }
    }
  });

  it("a missing persona makes the line null rather than 'undefined'", () => {
    expect(renderCampaignLine(CONFIG.opener, { firstName: "Sam", businessName: BIZ, config: { ...CONFIG, persona_name: undefined } })).toBeNull();
  });

  it("a missing or empty template is no line", () => {
    expect(renderCampaignLine(undefined, { firstName: "Sam", businessName: BIZ, config: CONFIG })).toBeNull();
    expect(renderCampaignLine("", { firstName: "Sam", businessName: BIZ, config: CONFIG })).toBeNull();
  });
});

describe("save time: no warnings channel exists", () => {
  it("validateCampaign returns {ok, errors} / {ok, value} only -- the no-name signal is not added there (report ruling)", () => {
    const r = validateCampaign(
      { name: "c", template_key: "speed_to_lead", compliance_class: "solicited", audience: "business" },
      CONFIG,
      { businessName: BIZ }
    );
    expect(Object.keys(r).sort()).toEqual(["ok", "value"]);
  });
});

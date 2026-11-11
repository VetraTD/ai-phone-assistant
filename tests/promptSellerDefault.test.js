// ---------------------------------------------------------------------------
// S4-F1. A BUSINESS'S OWN SALES-CALL RULE REPLACES OUR SELLER DEFAULT.
//
// A live call on a lead-gen tenant: the business's custom instructions said
// "take a short message" for sales pitches, and the static inbound guardrail
// said "...or is selling something, say so politely in one sentence and end the
// call. Do not take a message." The guardrail won. No message was taken.
//
// Reliability by CONSTRUCTION, not by a "the business's instructions win"
// sentence: when the business's own prose already says how to handle sales
// calls, our default bullet is not in the prompt at all, so the contradiction
// never reaches the model.
//
// Both bullets also ASK ONCE whether there is anything else, in the exact shape
// closingTicRe recognises, so the close the model copies is the close the
// ask-gate is waiting for.
//
// Every fixture here is made-up wording. No real business's text.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { buildStaticSystemPrefix, guardrailsSection } from "../services/gemini.js";
import { businessHandlesSellerCalls, sellerRuleCategory } from "../lib/sellerCalls.js";
import { getStrings } from "../lib/voice/strings.js";
import { FIXTURES } from "./fixtures/businessConfigs.js";

const ASK = "Is there anything else I can help you with?";
const SALES_RULE = "Sales pitch: take a short message.";

const base = () => ({ ...FIXTURES["messages-only"].config, generalInfo: null, customInstructions: null });
const extras = FIXTURES["messages-only"].extras;
const prefixFor = (config) => buildStaticSystemPrefix(config, extras);

const wrongNumberBullets = (p) => p.split("\n").filter((l) => l.startsWith("- If the caller has the wrong number"));
const sellerDefaultBullets = (p) => p.split("\n").filter((l) => l.startsWith("- If the caller is selling something"));

/** The quoted question inside a bullet, which is what the model copies. */
const quotedAsk = (line) => (line.match(/"([^"]+\?)"/) || [])[1];

// The three places a business writes its own prose.
const IN_FIELD = {
  customInstructions: (text) => ({ ...base(), customInstructions: text }),
  generalInfo: (text) => ({ ...base(), generalInfo: text }),
  messagesNotes: (text) => ({ ...base(), capabilities: { messages: { notes: text } } }),
};

// Hand-written negatives: "sell" / "sales" describing the business itself.
const NEGATIVES = [
  "We sell and fit kitchens.",
  "Sales and marketing agency.",
  "Ask our sales team.",
  "We're a sales consultancy.",
  "We sell cars, vans and motorbikes.",
  "Our sales reps will call you back within a day.",
  "We help B2B companies book more sales calls.",
  "Our sales pitch is simple: quality first.",
  "We write sales pitches and ad copy for clients.",
  "Sales: Mon-Fri 9-5. Service: Sat 9-1.",
  "For sales enquiries, take their name and number.",
  "We build sales infrastructure and sales funnels for clients.",
  "Ask the lead what they sell and who they sell to.",
  "We help people selling their homes get the best price.",
  "We sell to US and UK customers.",
  "We are a cold storage company.",
];

// One or more per phrase category the detector knows.
const POSITIVES = [
  ["Sales pitch: take a short message", "labelled"],
  ["- Sales calls: politely decline.", "labelled"],
  ["Salespeople: ask them to email us.", "labelled"],
  ["If it's a sales call, take a message.", "handling"],
  ["For sales pitches, take a message.", "handling"],
  ["If sales people call, take a message.", "handling"],
  ["Sales reps should email us instead.", "rule_follows"],
  ["Ask if they are a client, a supplier or a sales pitch.", "a_sales_pitch"],
  ["No cold calls please.", "cold_call"],
  ["We do not accept cold-calling.", "cold_call"],
  ["Telemarketers: end the call.", "telemarketing"],
  ["Unsolicited offers: take a message.", "unsolicited"],
  ["Anyone trying to sell us something gets a message taken.", "selling_to_us"],
  ["If someone is selling something, take their number.", "people_selling"],
  ["Callers selling advertising: decline.", "people_selling"],
  ["Don't let anyone pitch us on the phone.", "pitching"],
];

describe("the seller-rule detector reads only the business's own prose", () => {
  it.each(POSITIVES)("matches a rule about handling sales calls: %s", (text, category) => {
    expect(sellerRuleCategory(text)).toBe(category);
  });

  it.each(NEGATIVES)("does not match a business describing itself: %s", (text) => {
    expect(sellerRuleCategory(text)).toBeNull();
  });

  it.each(Object.keys(IN_FIELD))("finds the rule in %s", (field) => {
    expect(businessHandlesSellerCalls(IN_FIELD[field](SALES_RULE))).toBe(true);
  });

  it("is false for a business that wrote nothing, and for no config at all", () => {
    expect(businessHandlesSellerCalls(base())).toBe(false);
    expect(businessHandlesSellerCalls({})).toBe(false);
    expect(businessHandlesSellerCalls(null)).toBe(false);
    expect(businessHandlesSellerCalls(undefined)).toBe(false);
  });

  it("does not count a rule past the prompt's 2000-character cap: the model never sees it", () => {
    const late = "x".repeat(2000) + " " + SALES_RULE;
    expect(businessHandlesSellerCalls(IN_FIELD.customInstructions(late))).toBe(false);
    expect(businessHandlesSellerCalls(IN_FIELD.generalInfo(late))).toBe(false);
    // A default kept beside a rule the model cannot read is the right way round.
    expect(sellerDefaultBullets(prefixFor(IN_FIELD.customInstructions(late)))).toHaveLength(1);
  });
});

describe("inbound guardrails: wrong number always, seller default unless the business has its own rule", () => {
  it("a business with no sales text gets both bullets, each asking once", () => {
    const p = prefixFor(base());
    const [wrong] = wrongNumberBullets(p);
    const [seller] = sellerDefaultBullets(p);

    expect(wrongNumberBullets(p)).toHaveLength(1);
    expect(sellerDefaultBullets(p)).toHaveLength(1);
    for (const line of [wrong, seller]) {
      expect(quotedAsk(line)).toBe(ASK);
      // The shape the ask-gate's detector reads off the model's reply.
      expect(getStrings(base()).closingTicRe.test(quotedAsk(line))).toBe(true);
      expect(line).toMatch(/say goodbye and end the call/);
      expect(line).toMatch(/do not take a message/i);
    }
    // The old one-line rule, which ended the call without asking, is gone.
    expect(p).not.toContain("or is selling something, say so politely in one sentence and end the call");
  });

  it.each(Object.keys(IN_FIELD))(
    "the business's own rule in %s replaces the seller default; the wrong-number bullet stays",
    (field) => {
      const p = prefixFor(IN_FIELD[field](SALES_RULE));

      expect(sellerDefaultBullets(p)).toHaveLength(0);
      expect(p).not.toMatch(/selling something/);
      expect(wrongNumberBullets(p)).toHaveLength(1);
      expect(quotedAsk(wrongNumberBullets(p)[0])).toBe(ASK);
      // The business's line is still there for the model to follow.
      expect(p).toContain(SALES_RULE);
    }
  );

  it.each(NEGATIVES)("a business describing itself keeps the default: %s", (text) => {
    for (const make of Object.values(IN_FIELD)) {
      expect(sellerDefaultBullets(prefixFor(make(text)))).toHaveLength(1);
    }
  });
});

describe("outbound guardrails are untouched", () => {
  const outbound = (config) =>
    guardrailsSection(config, { outboundCall: { config: {} } }, "outbound", {
      appointmentsEnabled: false,
      fragments: { guardrails: [] },
    });

  it("carries neither inbound bullet, and does not read the business's sales text", () => {
    const plain = outbound(base());
    expect(plain).not.toMatch(/wrong number/i);
    expect(plain).not.toMatch(/selling something/i);
    expect(outbound(IN_FIELD.customInstructions(SALES_RULE))).toBe(plain);
  });
});

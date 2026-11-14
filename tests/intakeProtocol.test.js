// ---------------------------------------------------------------------------
// Caller-experience Task 3: the message protocol is a described goal for the
// standard tier, and byte-for-byte today's checklist for the healthcare tier.
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import messages from "../capabilities/messages.js";
import { buildStaticSystemPrefix, buildDynamicTail } from "../services/gemini.js";
import { FIXTURES } from "./fixtures/businessConfigs.js";

// Captured from capabilities/messages.js BEFORE the change (HEAD 70f1a6b).
const OLD = JSON.parse(readFileSync(new URL("./fixtures/oldMessageProtocol.json", import.meta.url), "utf8"));
const LINE = "Sam will call you back as soon as he can.";

const render = (cfg = {}, extra = {}) => {
  const out = messages.prompt({ capabilities: { messages: cfg }, ...extra });
  return {
    protocol: out.static.protocols[0],
    take: out.dynamic.stepGuidance.take_message,
    callback: out.dynamic.stepGuidance.callback_request,
  };
};
const bodyLines = (protocol) => protocol.split("\n").slice(2);
const noQuotedQuestion = (text) => !/"[^"]+\?"/.test(text);

describe("standard tier: a described goal, not a checklist", () => {
  const { protocol, take, callback } = render({});

  it("keeps the section header and drops the old checklist", () => {
    expect(protocol.startsWith("=== MESSAGE PROTOCOL ===\n")).toBe(true);
    expect(protocol).not.toContain("follow this exactly");
    expect(protocol).not.toContain("Reason: ask briefly");
    expect(protocol).not.toContain("Summarise it ONCE");
  });

  it("states the rules in short distinctive phrases", () => {
    expect(protocol).toContain("already said");
    expect(protocol).toContain("never ask it again");
    expect(protocol).toContain("one question");
    expect(protocol).toMatch(/do not ask[^.]*number/);
    expect(protocol).toContain("this business's own questions");
    expect(protocol).toContain("short of time");
    expect(protocol).toContain("Never repeat the greeting");
  });

  it("asks urgency only of existing clients, and only when it seems to matter", () => {
    expect(protocol).toMatch(/Urgency: ask an existing client[^.]*only when what they said suggests it matters/);
  });

  it("uses an on-file name only to confirm once, and the caller's own account wins", () => {
    expect(protocol).toContain("never ask them to spell a confirmed on-file name");
    expect(protocol).toContain("What the caller says about who they are wins over the record");
  });

  it("the business's own questions: new enquiries by default, others only when the notes say so", () => {
    expect(protocol).toMatch(/new enquiries by default/);
    expect(protocol).toMatch(/other callers only when the notes say so/);
    expect(protocol).toContain("in the business's order");
  });

  it("no new line carries a quoted question for the model to recite", () => {
    for (const text of [protocol, take, callback, render({ callbackLine: LINE }).protocol]) {
      for (const line of bodyLines(text)) {
        // The callbackLine is the business's own text and stays quoted.
        expect(noQuotedQuestion(line.replace(`"${LINE}"`, "")), line).toBe(true);
      }
    }
  });

  it("the cascade guidance says the same lines as the Live prefix", () => {
    for (const phrase of ["already said", "short of time", "this business's own questions", "Number:"]) {
      expect(protocol).toContain(phrase);
      expect(take).toContain(phrase);
    }
    expect(callback).toContain("preferred callback time");
    expect(take).not.toContain("preferred callback time");
  });

  it("the standing promise keeps its urgent/normal split; a callbackLine replaces it", () => {
    expect(protocol).toMatch(/as soon as possible[^.]*urgent[^.]*next business day|urgent[^.]*as soon as possible[^.]*next business day/);
    const withLine = render({ callbackLine: LINE });
    expect(withLine.protocol).toContain(`Promise the callback: "${LINE}"`);
    expect(withLine.protocol).not.toContain("Urgency:");
    expect(withLine.protocol).not.toContain("next business day");
    expect(withLine.take).toContain(`"${LINE}"`);
  });

  it("an empty config is the same as a standard tier one", () => {
    expect(render({}, { complianceTier: "standard" }).protocol).toBe(protocol);
  });
});

describe("confirmStyle", () => {
  it('"end" (the default): one read-back at the end for leads and clients, number only if not the caller ID', () => {
    const { protocol } = render({});
    expect(protocol).toContain("one read-back at the end");
    expect(protocol).toContain("the surname spelled");
    expect(protocol).toContain("the email if given");
    expect(protocol).toMatch(/a number only if it is not the number they are calling from/);
    expect(protocol).toContain("said digit by digit");
    expect(protocol).toContain("the preferred time if given");
    expect(protocol).toContain("a one-line reason");
    expect(protocol).toContain("ask whether that is right");
    expect(protocol).toContain("save again");
    expect(render({ confirmStyle: "end" }).protocol).toBe(protocol);
  });

  it('"each": a per-answer line that spells the surname back, and no read-back at the end', () => {
    const { protocol } = render({ confirmStyle: "each" });
    expect(protocol).not.toContain("read-back at the end");
    expect(protocol).toMatch(/Confirming: confirm each answer briefly as it is given/);
    expect(protocol).toMatch(/spelling the surname back from what you heard/);
    expect(protocol).toContain("no closing recap");
  });

  // Fix round 1: the plain-confirmation rule for personal and seller callers
  // lives in the path note (tests/intakePath.test.js); the protocol only says
  // who gets the read-back.
  it("the read-back is for new enquiries and existing clients only", () => {
    expect(render({ confirmStyle: "end" }).protocol).toMatch(/Confirming: [^\n]*new enquir/);
  });
});

describe("spellUpFront", () => {
  it('"no": nobody is asked to spell', () => {
    expect(render({ spellUpFront: "no" }).protocol).toMatch(/Spelling: do not ask anyone to spell/);
    expect(render({}).protocol).toMatch(/Spelling: do not ask anyone to spell/);
  });
  it('"leads": new enquiries and existing clients are asked to spell the surname before saving', () => {
    const { protocol } = render({ spellUpFront: "leads" });
    expect(protocol).toMatch(/Spelling: ask new enquiries and existing clients to spell their surname before you save/);
    expect(protocol).not.toContain("do not ask anyone to spell");
  });
  it('"everyone": every caller who leaves a message is asked', () => {
    const { protocol } = render({ spellUpFront: "everyone" });
    expect(protocol).toMatch(/Spelling: ask every caller who leaves a message to spell their name before you save/);
  });
});

describe("healthcare tier: today's protocol, byte for byte, both settings ignored", () => {
  const hipaa = { complianceTier: "hipaa" };

  it("matches the captured old protocol and guidance", () => {
    for (const [key, cfg] of [["plain", {}], ["line", { callbackLine: LINE }]]) {
      const got = render(cfg, hipaa);
      expect(got.protocol).toBe(OLD[key].protocol);
      expect(got.take).toBe(OLD[key].take);
      expect(got.callback).toBe(OLD[key].callback);
    }
  });

  it("ignores confirmStyle and spellUpFront", () => {
    const got = render({ confirmStyle: "each", spellUpFront: "everyone" }, hipaa);
    expect(got.protocol).toBe(OLD.plain.protocol);
    expect(got.take).toBe(OLD.plain.take);
  });

  it("keeps today's NEXT_QUESTIONS_NOTE in the save reply", async () => {
    const fc = { id: "f", name: "record_customer_request", args: { request_type: "message", callback_number: "2145550123" } };
    const cfgFor = (extra) => ({ ...extra, capabilities: { messages: { notes: "Ask which department." } } });
    const old =
      "[not caller speech] If this business's notes list more questions for this caller, ask them now, one at a time, before closing. Then save again with the same message and the answers in details.";
    const h = await messages.execute(fc, { config: cfgFor(hipaa), callerPhone: "+12145550123" });
    expect(h.functionResponse.response.next).toBe(old);
    const s = await messages.execute(fc, { config: cfgFor({}), callerPhone: "+12145550123" });
    expect(s.functionResponse.response.next).toMatch(/new enquiries by default/);
    expect(s.functionResponse.response.next).toMatch(/other callers only when the notes say so/);
    expect(s.functionResponse.response.next).toMatch(/short of time/);
    expect(s.functionResponse.response.next).not.toBe(old);
    expect(noQuotedQuestion(s.functionResponse.response.next)).toBe(true);
  });
});

// Fix round 1 (reviewer, Important): the standard tier's other inbound lines
// must not contradict the message protocol's Spelling and save rules.
describe("standard tier: no contradicting spelling or save instruction elsewhere in the prompt", () => {
  const msgOnly = FIXTURES["messages-only"];
  const withSpell = (v, extra = {}) => ({
    ...msgOnly.config,
    capabilities: { ...msgOnly.config.capabilities, messages: { spellUpFront: v } },
    ...extra,
  });
  const prefix = (config) => buildStaticSystemPrefix(config, msgOnly.extras);
  const tail = (config, intent) => buildDynamicTail("gather_details", intent, config, msgOnly.extras);
  const OLD_SPELL = "ask them to spell the first AND last name in one go";
  const OLD_GUARDRAIL = "A message or quote request: one short summary, then record it straight away";
  const BLOCK = "=== SPELLING NOT YET CONFIRMED ===";

  it("the tool contract scopes the spelling ask to a booking and points a message at the Spelling rule", () => {
    const p = prefix(withSpell("no"));
    expect(p).toContain("A name you are going to write down for a booking that is not already on their record");
    expect(p).toContain("For a message, follow the message protocol's Spelling rule instead.");
    expect(p).toContain("Spelling: do not ask anyone to spell");
    // The old unscoped sentence is gone: nothing tells the model to ask a message caller to spell.
    expect(p).not.toContain("A name you are going to write down that is not already on their record");
  });

  it("the guardrail saves a message when the minimum is in hand and follows the protocol; quote keeps its words", () => {
    const p = prefix(withSpell("no"));
    expect(p).not.toContain(OLD_GUARDRAIL);
    expect(p).toContain("A message: save it as soon as this caller's minimum is in hand, then follow the message protocol");
    expect(p).toContain("A quote request: one short summary, then record it straight away");
  });

  it("the SPELLING NOT YET CONFIRMED block is omitted on message intents when spellUpFront is no", () => {
    for (const intent of ["take_message", "callback_request"]) {
      expect(tail(withSpell("no"), intent)).not.toContain(BLOCK);
      expect(tail(withSpell("leads"), intent)).toContain(BLOCK);
      expect(tail(withSpell("everyone"), intent)).toContain(BLOCK);
    }
  });

  it("booking intents keep the block whatever spellUpFront says", () => {
    const f = FIXTURES["appointments-db"];
    const cfg = { ...f.config, capabilities: { ...f.config.capabilities, messages: { spellUpFront: "no" } } };
    expect(buildDynamicTail("gather_details", "book_appointment", cfg, f.extras)).toContain(BLOCK);
  });

  it("the lines this fix adds or changes carry no quoted question", () => {
    const p = prefix(withSpell("no"));
    for (const line of p.split("\n")) {
      if (/For a message, follow the message protocol|A message: save it as soon/.test(line)) {
        // The booking question quoted earlier on the tool-contract line is old text, not added here.
        const added = line
          .replace(/"Could you spell the first and last name for me\?"/, "")
          .replace(/A booking or a reschedule.*$/, "");
        expect(/"[^"]+\?"/.test(added), line).toBe(false);
      }
    }
  });

  it("healthcare tier keeps all three old lines exactly", () => {
    const hipaa = withSpell("no", { complianceTier: "hipaa" });
    const p = prefix(hipaa);
    expect(p).toContain(
      "A name you are going to write down that is not already on their record, and that they have not spelled for you: ask them to spell the first AND last name in one go, in your very next reply"
    );
    expect(p).toContain("Ask once; if they decline or carry on, use it as you heard it. Never ask your one confirming question");
    expect(p).toContain("Before saving anything, read the details back ONCE, then do it. " + OLD_GUARDRAIL.replace("Before ", ""));
    for (const intent of ["take_message", "callback_request"]) expect(tail(hipaa, intent)).toContain(BLOCK);
  });
});

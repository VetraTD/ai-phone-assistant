// ---------------------------------------------------------------------------
// S4-F4 -- the goodbye thanks the caller and does NOT say the business name.
//
// Owner, 2026-11-11 (also chosen 2026-10-20): the model said "Thank you for
// calling <business>" at the close, and a hard business name is misheard on
// the line ("Digile Media" heard as "Digital Media"). The company name STAYS in
// the prompt, so "who am I speaking to?" still gets the name. Only the goodbye
// changes.
//
// The NAMED RISK is the closing detectors: many guards key on the goodbye text,
// and a name-free goodbye must still be recognised by every one of them.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { getStrings } from "../lib/voice/strings.js";
import { farewellIndex, farewellBeforeAsk } from "../lib/voice/closingOrder.js";
import { buildAllDeclarations, buildStaticSystemPrefix } from "../services/gemini.js";
import { FIXTURES } from "./fixtures/businessConfigs.js";

const EN = getStrings("en");
const ES = getStrings({ languagesSpoken: ["es"] });

describe("signOff -- the canned close carries no business name", () => {
  it("English is a fixed, name-free line", () => {
    expect(EN.signOff).toBe("Thank you for calling. Have a great day!");
  });

  it("Spanish is a fixed, name-free line", () => {
    expect(ES.signOff).toBe("Gracias por llamar. ¡Que tenga un buen día!");
  });

  it("is a string, so a name passed by a stale caller cannot reach it", () => {
    expect(typeof EN.signOff).toBe("string");
    expect(typeof ES.signOff).toBe("string");
    expect(EN.signOff).not.toMatch(/undefined|\bus\b|null/);
    expect(ES.signOff).not.toMatch(/undefined|\bus\b|null/);
  });
});

describe("signOffRe -- still arms on a name-free goodbye (read by armsGoodbyeExit)", () => {
  it.each([
    "Thank you for calling. Have a great day!",
    "Thanks for calling, have a great day!",
    "Thank you for calling. Take care!",
    "Thanks so much for calling, bye for now.",
    "Thanks again for calling, have a lovely weekend.",
  ])("EN matches %j", (t) => {
    expect(EN.signOffRe.test(t)).toBe(true);
  });

  it("EN: the canonical signOff itself matches", () => {
    expect(EN.signOffRe.test(EN.signOff)).toBe(true);
  });

  it.each([
    "Gracias por llamar. ¡Que tenga un buen día!",
    "Gracias por llamar, que tenga un buen día.",
    "Gracias por llamar, adiós.",
  ])("ES matches %j", (t) => {
    expect(ES.signOffRe.test(t)).toBe(true);
  });

  it("ES: the canonical signOff itself matches", () => {
    expect(ES.signOffRe.test(ES.signOff)).toBe(true);
  });

  // KNOWN MISS, documented rather than fixed: a bare thank-you with nothing
  // after it carries no farewell word, and signOffRe is anchored on one on
  // purpose ("thanks for calling" also opens the greeting). The canned line and
  // the end_call description both ask for the wish-well half, so the model's
  // usual close is covered; this pins the edge so a later change is deliberate.
  it("EN does NOT match a bare 'Thank you for calling.' (known, documented)", () => {
    expect(EN.signOffRe.test("Thank you for calling.")).toBe(false);
  });

  it("does not match the greeting", () => {
    expect(EN.signOffRe.test("Thanks for calling. How can I help you today?")).toBe(false);
  });
});

describe("farewellRe / farewellBeforeAsk -- a name-free goodbye is still found", () => {
  it("the canonical lines are goodbyes", () => {
    expect(farewellIndex(EN.signOff, EN)).toBeGreaterThanOrEqual(0);
    expect(farewellIndex(ES.signOff, ES)).toBeGreaterThanOrEqual(0);
  });

  it("goodbye THEN ask is still counted, through 'have a great day' (the turn-opening thanks is skipped as a greeting)", () => {
    const t = "Thanks for calling, have a great day! Is there anything else I can help you with?";
    expect(farewellIndex(t, EN)).toBeGreaterThan(0);
    expect(farewellBeforeAsk(t, EN)).toBe(true);
  });

  it("goodbye THEN ask, canonical wording", () => {
    expect(
      farewellBeforeAsk("Thank you for calling. Have a great day! Is there anything else I can help you with?", EN)
    ).toBe(true);
  });

  it("Spanish goodbye then ask", () => {
    expect(
      farewellBeforeAsk("Gracias por llamar. ¡Que tenga un buen día! ¿Hay algo más en que pueda ayudarle?", ES)
    ).toBe(true);
  });

  it("ask then goodbye is not counted", () => {
    expect(
      farewellBeforeAsk("Is there anything else I can help you with? Thank you for calling. Have a great day!", EN)
    ).toBe(false);
  });

  it("a name-free greeting is not a goodbye", () => {
    expect(farewellIndex("Thanks for calling. How can I help you today?", EN)).toBe(-1);
  });
});

describe("the prompt's end_call guardrail", () => {
  it("tells the model to thank the caller for calling, without the business name", () => {
    const { config, extras } = FIXTURES["messages-only"];
    const prefix = buildStaticSystemPrefix(config, extras);
    expect(prefix).toMatch(/thank them for calling and wish them well/);
    expect(prefix).not.toMatch(new RegExp(`thank them for calling ${config.businessName}`));
    // The name itself STAYS in the prompt (who-am-I answers, greeting).
    expect(prefix).toContain(config.businessName);
  });
});

describe("end_call description", () => {
  const cfg = { allowedTasks: ["general_question"], businessName: "Brightwork Studio" };
  const endCallOf = (extras) =>
    buildAllDeclarations(cfg, extras)
      .flatMap((d) => d.functionDeclarations || [d])
      .find((d) => d.name === "end_call");

  it("inbound asks for a thank-you and a good wish, without the business's name unless its own instructions give a sign-off", () => {
    const d = endCallOf({}).description;
    expect(d).toMatch(/thank them and wish them well/);
    expect(d).toMatch(/without saying the business's name/);
    expect(d).toMatch(/unless this business's own instructions give their own sign-off/);
    // Described, never a sentence for the model to recite.
    expect(d).not.toMatch(/"[^"]+\?"/);
    expect(d).not.toMatch(/thank them for calling/);
  });

  it("outbound is unchanged, byte for byte", () => {
    const d = endCallOf({ outboundCall: { contact: { firstName: "Sam" } } }).description;
    expect(d).toBe(
      "Signal that the conversation is naturally complete and it is time " +
        "to end the call. You MUST write your warm sign-off in the SAME " +
        "response as this call — thank them for their time and wish them " +
        "well. Nothing you say after this is heard."
    );
  });
});

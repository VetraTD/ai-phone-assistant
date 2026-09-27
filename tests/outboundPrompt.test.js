// tests/outboundPrompt.test.js
/**
 * lib/outbound/prompt.js's outboundCallBlock, direct unit coverage.
 *
 * Checkpoint 2b review:
 *
 *   I3. The opt-out belt is disconnected from the prompt. The prompt told
 *   Ava to "tell them you will make sure they are not called again", and
 *   the natural renderings of that instruction ("I'll make sure you're not
 *   called again") match none of lib/outbound/detectors.js's
 *   ASSISTANT_OPT_OUT_PATTERNS -- so the assistant-side scan (the belt to
 *   the caller-side transcript, which is lossy) usually misses Ava's own
 *   confirmation. The fix: the prompt must DICTATE the exact confirmation,
 *   and this file binds both sides to the same source of truth so they
 *   cannot drift apart again.
 *
 *   M2. The OUTBOUND CALL block never names confirm_identity. O-12 (the
 *   implicit phone_on_file gate on every outbound action tool) then relies
 *   entirely on a refusal message to make the model call it -- and "a
 *   refusal message is a request" is this codebase's own recorded lesson:
 *   refusal texts do not reliably cause a retry. The tool is declared
 *   (services/gemini.js buildCallTools, only on outbound), so naming it
 *   here is not a phantom-tool risk.
 */
import { describe, it, expect } from "vitest";
import { outboundCallBlock } from "../lib/outbound/prompt.js";
import { ASSISTANT_OPT_OUT_PATTERNS } from "../lib/outbound/detectors.js";
import { OUTBOUND_FIXTURES } from "./fixtures/businessConfigs.js";

const BUSINESS_NAME = OUTBOUND_FIXTURES["speed-to-lead"].config.businessName;

/** Mirrors services/gemini.js's own call shape exactly (buildDynamicTail). */
function renderBlock(outboundCall, disclosure = { enabled: false, text: null }, businessName = BUSINESS_NAME) {
  return outboundCallBlock({ ...outboundCall, disclosure }, businessName);
}

const WITH_FIRST_NAME = OUTBOUND_FIXTURES["speed-to-lead"].extras.outboundCall;
const WITHOUT_FIRST_NAME = OUTBOUND_FIXTURES["speed-to-lead-no-first-name"].extras.outboundCall;

describe("I3 (checkpoint 2b review) — the opt-out confirmation the prompt dictates matches the detector", () => {
  /**
   * Pulls the sentence Ava is told to say VERBATIM out of the "Stop
   * calling" bullet -- the one after "say exactly:", not the two caller
   * phrasings the bullet itself opens with (also quoted, on the same line).
   */
  function quotedOptOutConfirmation(text) {
    const line = text.split("\n").find((l) => l.startsWith(`- "Stop calling"`));
    const m = line && line.match(/say exactly:\s*"([^"]+)"/);
    return m ? m[1] : null;
  }

  it("quotes an exact confirmation sentence, not a paraphrase instruction", () => {
    const quoted = quotedOptOutConfirmation(renderBlock(WITH_FIRST_NAME));
    expect(quoted).toBeTruthy();
  });

  it("the quoted confirmation matches one of ASSISTANT_OPT_OUT_PATTERNS -- the drift this item exists to close", () => {
    const quoted = quotedOptOutConfirmation(renderBlock(WITH_FIRST_NAME));
    expect(ASSISTANT_OPT_OUT_PATTERNS.some((re) => re.test(quoted))).toBe(true);
  });

  it("same on the no-first-name path -- this bullet does not vary with firstName", () => {
    const quoted = quotedOptOutConfirmation(renderBlock(WITHOUT_FIRST_NAME));
    expect(ASSISTANT_OPT_OUT_PATTERNS.some((re) => re.test(quoted))).toBe(true);
  });

  it("still tells Ava to end the call after confirming", () => {
    const line = renderBlock(WITH_FIRST_NAME)
      .split("\n")
      .find((l) => l.startsWith(`- "Stop calling"`));
    expect(line).toMatch(/end the call/i);
  });
});

describe("M2 (checkpoint 2b review) — the identity-not-confirmed bullet names confirm_identity", () => {
  it("with a first name on file: names the tool once they confirm THAT name", () => {
    const text = renderBlock(WITH_FIRST_NAME);
    expect(text).toMatch(/confirm they are Priya/i);
    expect(text).toMatch(/call confirm_identity with name_confirmed true/i);
  });

  it("no first name on file: names the tool once they confirm who they are and the enquiry", () => {
    const text = renderBlock(WITHOUT_FIRST_NAME);
    expect(text).toMatch(/confirm who they are and that they made the enquiry/i);
    expect(text).toMatch(/call confirm_identity with name_confirmed true/i);
    // Not the with-first-name wording -- there is no name on file to name.
    expect(text).not.toMatch(/confirm they are Priya/i);
  });

  it("the instruction sits on the identity-not-confirmed bullet, not floating detached from it", () => {
    const line = renderBlock(WITH_FIRST_NAME)
      .split("\n")
      .find((l) => l.startsWith("You have not confirmed"));
    expect(line).toMatch(/confirm_identity/i);
  });
});

describe("S3-1 (spec §19, S3-D1) — the outbound closing rule (D7)", () => {
  it("D7 verbatim: confirm the next step, thank by name, say goodbye, then end -- never ask 'anything else'", () => {
    const text = renderBlock(WITH_FIRST_NAME);
    expect(text).toContain(
      "To end the call: confirm the next step in one sentence, thank them by name, say goodbye, then end the call. " +
        "You placed this call, so never ask whether there is anything else you can help with."
    );
  });

  it("still tells the model to call end_call in the same reply as the sign-off", () => {
    const text = renderBlock(WITH_FIRST_NAME);
    expect(text).toMatch(/call end_call in the same reply as your sign-off/i);
  });

  it("never contains the inbound ask-gate phrasing", () => {
    const text = renderBlock(WITH_FIRST_NAME);
    expect(text).not.toMatch(/anything else (?:that )?(?:I|we) can (?:help|assist)/i);
  });
});

describe("S3-1 — the number rule (D3)", () => {
  it("with a first name on file: 'You dialled Priya's number...'", () => {
    const text = renderBlock(WITH_FIRST_NAME);
    expect(text).toContain("You dialled Priya's number, so you already have it. Never ask for a phone number.");
  });

  it("with no first name on file: a name-free variant, still never-ask-for-a-number", () => {
    const text = renderBlock(WITHOUT_FIRST_NAME);
    expect(text).toMatch(/you dialled this number yourself, so you already have it/i);
    expect(text).toMatch(/never ask for a phone number/i);
  });
});

describe("S3-1 — the SITUATIONS section: one line per situation (13 rows)", () => {
  const text = renderBlock(WITH_FIRST_NAME);
  const lines = text.split("\n");

  it("has the SITUATIONS heading", () => {
    expect(text).toContain("=== SITUATIONS ===");
  });

  const rows = [
    ["the person themselves", /the person themselves/i, /explain why you are calling/i],
    ["a gatekeeper (S3-D1a)", /A gatekeeper/i, /never the topic/i],
    ["a household member or possible child (S3-D1b)", /household member or a possible child/i, /one availability question/i],
    ["a wrong number", /A wrong number/i, /apologise/i],
    ['"stop calling"', /"Stop calling"/i, /take me off your list/i],
    ['"are you a robot?"', /Are you a robot\?/i, /AI assistant/i],
    ["a bad time or driving", /A bad time or driving/i, /callback/i],
    ['"email me instead"', /Email me instead/i, /will follow up by email/i],
    [
      '"is this a sales call?" / "how did you get my number?" (fix round 1, controller ruling)',
      /Is this a sales call\?.*How did you get my number\?/i,
      /never invent a source/i,
    ],
    ['"already booked" / "already a customer"', /Already booked.*already a customer/i, /apologise/i],
    ["hostile", /^- Hostile/im, /offer to stop calling/i],
    ["a bad line or an unusable reply", /A bad line or an unusable reply/i, /ask once/i],
    ["call screening", /Call screening/i, /say your name and the reason.*once/i],
  ];

  for (const [label, whoRe, moveRe] of rows) {
    it(`covers: ${label}`, () => {
      expect(text).toMatch(whoRe);
      expect(text).toMatch(moveRe);
    });
  }

  it("is exactly 13 situation rows (lines starting with '- ')", () => {
    const situationsIdx = lines.findIndex((l) => l === "=== SITUATIONS ===");
    expect(situationsIdx).toBeGreaterThanOrEqual(0);
    const situationRows = lines.slice(situationsIdx + 1).filter((l) => l.startsWith("- "));
    expect(situationRows.length).toBe(13);
  });

  it("no situation line names a tool that is not declared on the call (spec §9.5 D-c) -- plain English only", () => {
    const situationsIdx = lines.findIndex((l) => l === "=== SITUATIONS ===");
    const situationRows = lines.slice(situationsIdx + 1).filter((l) => l.startsWith("- "));
    for (const row of situationRows) {
      expect(row).not.toMatch(/\b(schedule_callback|opt_out|record_outcome|wrong_person)\b/);
    }
  });

  it("named risk 4: the gatekeeper line contains no topic text (real config, real topic)", () => {
    const gatekeeperLine = lines.find((l) => /^- A gatekeeper/i.test(l));
    expect(gatekeeperLine).toBeTruthy();
    expect(gatekeeperLine.toLowerCase()).not.toContain(WITH_FIRST_NAME.config.topic.toLowerCase());
  });

  it("named risk 4b: the household-member line also contains no topic text", () => {
    const householdLine = lines.find((l) => /^- A household member/i.test(l));
    expect(householdLine).toBeTruthy();
    expect(householdLine.toLowerCase()).not.toContain(WITH_FIRST_NAME.config.topic.toLowerCase());
  });

  // Fix round 1 (review finding, IMPORTANT): the brief's contract item 1
  // spells out "record the outcome `other`[, note ...]" as PLAIN-ENGLISH
  // behaviour for these two situations -- not a tool call (no pack exists
  // yet), but the instruction to note the outcome must still be present.
  it('fix round 1: "email me instead" also records the outcome as other, noting the email request', () => {
    const line = lines.find((l) => /^- "Email me instead"/i.test(l));
    expect(line).toBeTruthy();
    expect(line).toMatch(/record the outcome as other/i);
    expect(line).toMatch(/asked for email/i);
    // Still plain English -- no tool name.
    expect(line).not.toMatch(/\brecord_outcome\b/);
  });

  it('fix round 1: "already booked" / "already a customer" also records the outcome as other', () => {
    const line = lines.find((l) => /^- "Already booked"/i.test(l));
    expect(line).toBeTruthy();
    expect(line).toMatch(/record the outcome as other/i);
    expect(line).not.toMatch(/\brecord_outcome\b/);
  });

  // Fix round 1 (controller ruling, not from the review): "How did you get
  // my number?" is folded back in, as an alternative phrasing on the "is
  // this a sales call?" line, so the list stays at 13 rows and Ava never
  // improvises a source when a caller asks this on an outbound call.
  it('fix round 1: "how did you get my number?" is folded into the "is this a sales call?" line, still 13 rows', () => {
    const line = lines.find((l) => /^- "Is this a sales call\?"/i.test(l));
    expect(line).toBeTruthy();
    expect(line).toMatch(/How did you get my number\?/i);
    expect(line).toMatch(/never invent a source/i);
    const situationsIdx = lines.findIndex((l) => l === "=== SITUATIONS ===");
    const situationRows = lines.slice(situationsIdx + 1).filter((l) => l.startsWith("- "));
    expect(situationRows.length).toBe(13);
  });
});

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

/** Mirrors services/gemini.js's own call shape exactly (buildDynamicTail). */
function renderBlock(outboundCall, disclosure = { enabled: false, text: null }) {
  return outboundCallBlock({ ...outboundCall, disclosure });
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

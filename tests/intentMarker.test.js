import { describe, it, expect } from "vitest";

import {
  createMarkerStripper,
  stripMarkerAnywhere,
  safeRejectedValue,
  MAX_MARKER_CHARS,
} from "../lib/intentMarker.js";

const ALLOWED = ["book_appointment", "take_message", "callback_request", "general_question"];

/** Feed a whole reply through a fresh stripper, one delta at a time. */
function run(deltas, allowedIntents = ALLOWED) {
  const stripper = createMarkerStripper({ allowedIntents });
  let text = "";
  let intent = null;
  for (const d of deltas) {
    const out = stripper.push(d);
    text += out.text;
    if (out.intent) intent = out.intent;
  }
  const tail = stripper.flush();
  text += tail.text;
  if (tail.intent) intent = tail.intent;
  return { text, intent };
}

describe("intentMarker — streaming stripper", () => {
  it("takes the intent from a leading marker and does not emit it", () => {
    const { text, intent } = run(["<<intent:book_appointment>>\nSure, I can help."]);

    expect(intent).toBe("book_appointment");
    expect(text).toBe("Sure, I can help.");
  });

  it("passes a reply with no marker through unchanged", () => {
    const { text, intent } = run(["Sure, ", "I can help."]);

    expect(intent).toBeNull();
    expect(text).toBe("Sure, I can help.");
  });

  it("holds nothing back once the text cannot be a marker", () => {
    const stripper = createMarkerStripper({ allowedIntents: ALLOWED });

    // The very first character rules out a marker, so the common path must
    // release immediately rather than buffering to the cap — this is the whole
    // latency argument for putting the marker first.
    expect(stripper.push("Sure, I can help.").text).toBe("Sure, I can help.");
  });

  // Gemini's chunk boundaries are arbitrary and will land inside the marker.
  // Testing one hand-picked split would prove nothing about the others.
  it("produces identical output no matter where the deltas are split", () => {
    const whole = "<<intent:take_message>>\nI'll pass that along. Anything else?";

    for (let i = 0; i <= whole.length; i++) {
      const { text, intent } = run([whole.slice(0, i), whole.slice(i)]);
      expect({ i, text, intent }).toEqual({
        i,
        text: "I'll pass that along. Anything else?",
        intent: "take_message",
      });
    }
  });

  it("strips a marker whose value is not an allowed task, without setting it", () => {
    const { text, intent } = run(["<<intent:wire_me_money>>\nSure, I can help."]);

    expect(intent).toBeNull();
    expect(text).toBe("Sure, I can help.");
  });

  it("tolerates the model wrapping the marker in markdown", () => {
    const { text, intent } = run(["**<<intent:book_appointment>>**\nWhat day works?"]);

    expect(intent).toBe("book_appointment");
    expect(text).toBe("What day works?");
  });

  it("emits a marker-only reply as empty text", () => {
    const { text, intent } = run(["<<intent:general_question>>"]);

    expect(intent).toBe("general_question");
    expect(text).toBe("");
  });

  it("emits nothing for an empty stream", () => {
    expect(run([])).toEqual({ text: "", intent: null });
  });

  // The failure that matters is a caller HEARING the marker, so an opening
  // token that never closes must not survive the release either.
  it("gives up at the first newline and does not emit the broken marker", () => {
    const { text, intent } = run(["<<intent:book_appointment\nWhat day works?"]);

    expect(intent).toBeNull();
    expect(text).toBe("What day works?");
  });

  it("gives up at the character cap on a marker that never closes", () => {
    const runaway = `<<intent:${"x".repeat(MAX_MARKER_CHARS * 2)}`;
    const { text, intent } = run([runaway + " and then some words."]);

    expect(intent).toBeNull();
    expect(text).not.toContain("<<");
    expect(text).not.toContain("intent:");
  });

  // The worst failure this design can produce is not a leak — it is silence.
  // couldBeMarker only validates the "<<intent:" prefix, so a value the regex
  // rejects (a space, a hyphen) kept the buffer open to the end of the reply,
  // and the unterminated-marker sweep then ate the whole thing. The caller
  // heard the generic "say that again" line instead of a perfectly good answer.
  // One wrong character at temperature 0.4 is not a rare event.
  describe("a malformed value must cost the intent, never the reply", () => {
    const REPLY = "Sure, our hours are nine to five.";

    it("keeps the reply when the value contains a space", () => {
      const { text, intent } = run([`<<intent:general question>> ${REPLY}`]);

      expect(text).toContain(REPLY);
      expect(text).not.toContain("<<");
      expect(intent).toBeNull();
    });

    it("keeps the reply when the value contains a hyphen", () => {
      const { text } = run([`<<intent:book-appointment>> ${REPLY}`]);

      expect(text).toContain(REPLY);
      expect(text).not.toContain("<<");
    });

    it("keeps the reply when the malformed marker is split across deltas", () => {
      const { text } = run(["<<intent:general", " question>>", " Sure, our hours", " are nine to five."]);

      expect(text).toContain(REPLY);
      expect(text).not.toContain("<<");
    });

    it("keeps the reply when the marker never closes at all", () => {
      const { text } = run([`<<intent: ${REPLY}`]);

      expect(text).toContain("nine to five");
      expect(text).not.toContain("<<");
    });
  });

  // A stray newline before the marker is plausible when the model resumes
  // generating after a tool round. It must not cost the declaration.
  it("still reads the marker after a leading blank-line delta", () => {
    const { text, intent } = run(["\n", "<<intent:book_appointment>>\nSure, that's great."]);

    expect(text).toBe("Sure, that's great.");
    expect(intent).toBe("book_appointment");
  });

  it("emits no leftover decoration or blank line when the separator lags", () => {
    expect(run(["`<<intent:book_appointment>>", "`", "\nWhat day works?"]).text).toBe("What day works?");
    expect(run(["<<intent:book_appointment>>", " ", "\nThat's great."]).text).toBe("That's great.");
  });

  it("stops inspecting once resolved, so a later '<<' is just text", () => {
    const stripper = createMarkerStripper({ allowedIntents: ALLOWED });
    stripper.push("Sure.");

    expect(stripper.push(" Two << three.")).toMatchObject({ text: " Two << three.", intent: null });
  });

  // The caller (services/gemini.js) logs this. Without it, a model drifting to
  // an intent the business never enabled is silent: the text looks clean and
  // the intent simply never updates.
  it("reports the rejected value so a drifting model is visible", () => {
    const stripper = createMarkerStripper({ allowedIntents: ALLOWED });

    expect(stripper.push("<<intent:quote_request>>\nSure.")).toMatchObject({
      intent: null,
      rejected: "quote_request",
    });
  });

  it("reports no rejection for an accepted value", () => {
    const stripper = createMarkerStripper({ allowedIntents: ALLOWED });

    expect(stripper.push("<<intent:take_message>>\nSure.").rejected).toBeNull();
  });
});

// A rejected value is model output, and it is logged so a model drifting to an
// intent the business never enabled is visible. One deployment of this codebase
// is HIPAA-scoped, and the marker charset ([a-zA-Z0-9_]) is wide enough to hold
// an unformatted phone number or account identifier if the model ever misplaces
// caller data into that slot.
describe("safeRejectedValue — what is safe to log", () => {
  // Every real task name is [a-z_]+ (services/supabase.js CORE_TASKS /
  // MODULE_TASKS), so nothing diagnostic is lost by refusing to log digits.
  it("passes a real-looking intent name through, so drift stays diagnosable", () => {
    expect(safeRejectedValue("quote_request")).toBe("quote_request");
    expect(safeRejectedValue("transfer_human")).toBe("transfer_human");
  });

  it("redacts anything carrying digits — the shape caller data would take", () => {
    expect(safeRejectedValue("5551234567")).toBe("(redacted)");
    expect(safeRejectedValue("acct99182")).toBe("(redacted)");
  });

  it("never throws on absent or non-string input", () => {
    expect(safeRejectedValue(null)).toBe("(redacted)");
    expect(safeRejectedValue(undefined)).toBe("(redacted)");
    expect(safeRejectedValue(12345)).toBe("(redacted)");
  });
});

describe("stripMarkerAnywhere — defensive strip", () => {
  it("removes a marker from the middle of a reply", () => {
    expect(stripMarkerAnywhere("Sure. <<intent:take_message>> What's the message?"))
      .not.toContain("intent");
  });

  it("removes an unterminated marker without eating the next line", () => {
    expect(stripMarkerAnywhere("<<intent:book_appointment\nWhat day works?").trim())
      .toBe("What day works?");
  });

  it("leaves ordinary text alone", () => {
    const plain = "We're open 9 to 5. Is 2 << 3? Yes.";
    expect(stripMarkerAnywhere(plain)).toBe(plain);
  });

  it("never throws on non-string input", () => {
    expect(stripMarkerAnywhere(null)).toBe(null);
    expect(stripMarkerAnywhere(undefined)).toBe(undefined);
  });
});

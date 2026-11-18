import { describe, it, expect } from "vitest";
import { createToolCallTextStripper, parseToolCallArgs } from "../lib/toolCallText.js";

// The verbatim string a caller heard on 2026-08-04, call 7eee9cd1. Gemini wrote
// the function call into the TEXT channel, so no tool ran and the namespace was
// spoken aloud ("default api get caller appointments from db").
const PRODUCTION_LEAK =
  "default_api:reschedule_appointment_db{appointment_id:8a13a7c6-7a19-480f-90d5-56ee3dbbf9d4," +
  "new_scheduled_at:2026-08-06T14:00:00} One moment while I reschedule that for you.";

const NAMES = [
  "get_caller_appointments_from_db",
  "reschedule_appointment_db",
  "cancel_appointment_db",
  "book_appointment",
  "set_call_intent",
];

function run(deltas, toolNames = NAMES, toolParamNames = []) {
  const s = createToolCallTextStripper({ toolNames, toolParamNames });
  let text = "";
  const calls = [];
  for (const d of deltas) {
    const out = s.push(d);
    text += out.text;
    calls.push(...out.calls);
  }
  const tail = s.flush();
  text += tail.text;
  calls.push(...tail.calls);
  return { text, calls };
}

describe("toolCallText.js — text-channel tool-call stripper", () => {
  describe("the production leak", () => {
    it("removes the pseudo-call and keeps the real sentence intact", () => {
      const { text, calls } = run([PRODUCTION_LEAK]);

      // Excision, not sentence destruction: the caller-facing half survives.
      expect(text.trim()).toBe("One moment while I reschedule that for you.");
      expect(text).not.toMatch(/default_api|reschedule_appointment_db|[{}]/);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("reschedule_appointment_db");
      expect(calls[0].shape).toBe("colon_brace");
    });

    it("survives being split across delta boundaries at every position", () => {
      for (let i = 1; i < PRODUCTION_LEAK.length; i++) {
        const { text, calls } = run([PRODUCTION_LEAK.slice(0, i), PRODUCTION_LEAK.slice(i)]);
        expect(text).not.toMatch(/default_api|reschedule_appointment_db/);
        expect(calls.map((c) => c.name)).toEqual(["reschedule_appointment_db"]);
      }
    });
  });

  describe("shapes", () => {
    it("catches the observed colon-brace form with no arguments", () => {
      const { text, calls } = run(["default_api:get_caller_appointments_from_db{} One moment."]);
      expect(text.trim()).toBe("One moment.");
      expect(calls[0].name).toBe("get_caller_appointments_from_db");
    });

    it("catches the dot-paren form", () => {
      const { calls } = run(["default_api.cancel_appointment_db(appointment_id:abc)"]);
      expect(calls[0].name).toBe("cancel_appointment_db");
    });

    it("catches a bare registered name with a brace blob", () => {
      const { calls } = run(["book_appointment{client_name:Ada}"]);
      expect(calls[0].name).toBe("book_appointment");
    });

    it("catches a print()-wrapped call inside a tool_code fence", () => {
      const { text, calls } = run([
        "Sure.\n```tool_code\nprint(default_api.book_appointment(client_name:Ada))\n```\nAll set.",
      ]);
      expect(calls[0].name).toBe("book_appointment");
      expect(text).not.toMatch(/```|print|book_appointment/);
      expect(text).toContain("Sure.");
      expect(text).toContain("All set.");
    });

    it("catches a namespaced name with no argument block at all", () => {
      const { text, calls } = run(["default_api:book_appointment then I'll confirm."]);
      expect(calls[0].name).toBe("book_appointment");
      expect(text).not.toMatch(/default_api|book_appointment/);
    });
  });

  describe("what it must not touch", () => {
    it("leaves ordinary speech alone and holds nothing", () => {
      const s = createToolCallTextStripper({ toolNames: NAMES });
      const out = s.push("Of course, I can help with that.");
      expect(out.text).toBe("Of course, I can help with that.");
      expect(out.calls).toEqual([]);
    });

    it("leaves prose containing colons and braces alone", () => {
      const { text, calls } = run(["We open at 9:00, and the note said {see reception}."]);
      expect(text).toBe("We open at 9:00, and the note said {see reception}.");
      expect(calls).toEqual([]);
    });

    it("does not match a name that is not in this business's registry", () => {
      const { text, calls } = run(["transfer_to_billing{x:1}"], ["book_appointment"]);
      expect(text).toBe("transfer_to_billing{x:1}");
      expect(calls).toEqual([]);
    });

    it("releases a held prefix that never becomes a call", () => {
      // "book" is a prefix of book_appointment, so it is briefly held — it must
      // come back out, not be swallowed.
      const { text, calls } = run(["I'll book", " that in for you."]);
      expect(text).toBe("I'll book that in for you.");
      expect(calls).toEqual([]);
    });
  });

  describe("argument parsing — lenient, because the model's output is not JSON", () => {
    it("reads unquoted keys and unquoted values containing spaces", () => {
      // The observed form: {caller_name:Boris Johnson}
      expect(parseToolCallArgs("caller_name:Boris Johnson")).toEqual({
        ok: true,
        args: { caller_name: "Boris Johnson" },
      });
    });

    it("reads several arguments and keeps ISO datetimes whole", () => {
      const { args, ok } = parseToolCallArgs(
        "appointment_id:8a13a7c6,new_scheduled_at:2026-08-06T14:00:00"
      );
      expect(ok).toBe(true);
      expect(args.new_scheduled_at).toBe("2026-08-06T14:00:00");
    });

    it("reads quoted JSON-ish arguments too", () => {
      expect(parseToolCallArgs('"client_name": "Ada Lovelace"').args).toEqual({
        client_name: "Ada Lovelace",
      });
    });

    it("reports ok:false rather than guessing when a fragment has no key", () => {
      expect(parseToolCallArgs("just some words").ok).toBe(false);
    });

    it("treats an empty argument block as parsed-and-empty", () => {
      expect(parseToolCallArgs("")).toEqual({ ok: true, args: {} });
    });
  });

  // -------------------------------------------------------------------------
  // Round 3, 2026-08-29. A caller heard
  //   "{reason:Caller declined further assistance and said thank you. }"
  // read aloud, and then heard the goodbye twice.
  //
  // The name was removed and the ARGUMENTS were not. BARE_NS_RE runs
  // unconditionally after CALL_RE, so when a delta boundary lands before the
  // closing brace CALL_RE cannot match (it requires `\{([^{}]*)\}`) but
  // BARE_NS_RE still fires and deletes just `default_api:end_call`, orphaning
  // the blob. The existing split-at-every-position test above could not catch
  // this: it asserts only that the NAME is gone.
  // -------------------------------------------------------------------------
  describe("the round-3 leak — an orphaned argument blob", () => {
    const R3_NAMES = [...NAMES, "end_call"];
    // Every parameter name the live declarations expose, threaded in the same
    // way the tool names are. This is what makes the nameless case
    // registry-driven rather than a denylist.
    const R3_PARAMS = ["reason", "client_name", "scheduled_at", "appointment_id", "requested_at"];

    const LEAK =
      "You're very welcome. default_api:end_call{reason:Caller declined further " +
      "assistance and said thank you. } Thank you for calling Digile Media.";

    const r3 = (deltas) =>
      run(deltas, R3_NAMES, R3_PARAMS);

    it("removes the arguments along with the name, not just the name", () => {
      const { text, calls } = r3([LEAK]);
      expect(text).not.toMatch(/[{}]/);
      expect(text).not.toMatch(/reason\s*:/i);
      expect(text).not.toMatch(/default_api|end_call/);
      expect(text).toContain("You're very welcome.");
      expect(text).toContain("Thank you for calling Digile Media.");
      expect(calls.map((c) => c.name)).toEqual(["end_call"]);
    });

    it("survives being split across delta boundaries at every position", () => {
      for (let i = 1; i < LEAK.length; i++) {
        const { text } = r3([LEAK.slice(0, i), LEAK.slice(i)]);
        expect(
          /[{}]|reason\s*:|default_api|end_call/i.test(text),
          `split at ${i} leaked: ${JSON.stringify(text)}`
        ).toBe(false);
      }
    });

    it("excises a nameless argument blob whose keys are all tool parameters", () => {
      // No function name at all — only the arguments object. This is what
      // actually reached the caller's ear once BARE_NS_RE had eaten the name.
      const { text } = r3(["{reason:Caller said thank you. } Have a good day."]);
      expect(text).not.toMatch(/[{}]|reason\s*:/i);
      expect(text).toContain("Have a good day.");
    });

    it("leaves a brace blob alone when its keys are not tool parameters", () => {
      // The restraint case: braces in prose are not evidence of anything.
      const { text, calls } = r3(["The note said {colour:blue} on the file."]);
      expect(text).toBe("The note said {colour:blue} on the file.");
      expect(calls).toEqual([]);
    });

    it("still holds a pseudo-call that follows ordinary prose", () => {
      // viableOpener let the optional [.:] separator start on the PRECEDING
      // prose word, so "welcome.  {reason:" produced head="welcome", matched
      // nothing, and the buffer was released mid-call rather than held.
      const s = createToolCallTextStripper({ toolNames: R3_NAMES, toolParamNames: R3_PARAMS });
      const out = s.push("Have a wonderful day. end_call{reason:Caller is done");
      expect(out.text).not.toMatch(/end_call|[{]|reason\s*:/i);
      expect(out.text).toContain("Have a wonderful day.");
    });
  });
});

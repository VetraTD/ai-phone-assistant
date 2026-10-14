/**
 * LVX178 (round A1) — "anything else?" must come BEFORE the goodbye.
 *
 * On Live the model composes speech and tool calls together and the tool runs
 * first. When end_call was refused for not having asked, the model then spoke
 * the goodbye it had planned AND the ask: "Thank you for calling Digile Media,
 * and have a wonderful day. Is there anything else I can help you with today?"
 * (2 of 434 assistant turns in call-corpus/, both real). The owner's rule:
 * goodbye only after the caller says no, never goodbye-then-ask.
 *
 * A COUNTER'S detector, nothing more. It never blocks, cuts or arms anything,
 * which is why its farewell regex (strings.farewellRe) may be broad.
 */

const GREETING_LEAD_RE =
  /^\s*(?:(?:good\s+(?:morning|afternoon|evening)|hi|hello|hey|buen(?:os|as)\s+(?:d[ií]as|tardes|noches)|hola)[\s,.!]*)?$/i;

/**
 * Where the first goodbye in `text` starts, or -1.
 *
 * A turn-OPENING "Thanks for calling …" is the greeting ("Thanks for calling
 * Digile Media. You're through to our AI receptionist …"), not a goodbye, so a
 * thanks-for-calling match at index 0 is skipped. Any other farewell in that
 * same turn ("…, have a wonderful day") is still found.
 * @param {string|undefined} text
 * @param {{farewellRe?: RegExp}} strings getStrings(config)
 */
export function farewellIndex(text, strings) {
  const re = strings?.farewellRe;
  if (!text || !re) return -1;
  const all = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (const m of text.matchAll(all)) {
    // The greeting's "Thanks for calling", alone or after a salutation
    // ("Good morning, thanks for calling …"), is not a goodbye.
    if (
      /^(?:thanks|thank|gracias)\b/i.test(m[0]) &&
      GREETING_LEAD_RE.test(text.slice(0, m.index))
    ) {
      continue;
    }
    return m.index;
  }
  return -1;
}

/**
 * One breath, wrong order: a goodbye, THEN "anything else?".
 * @param {string|undefined} text
 * @param {{farewellRe?: RegExp, closingTicRe?: RegExp}} strings
 */
export function farewellBeforeAsk(text, strings) {
  const at = farewellIndex(text, strings);
  if (at < 0 || !strings?.closingTicRe) return false;
  const ask = text.slice(at).search(strings.closingTicRe);
  return ask > 0;
}

// Formats for "information callers must give", offered as choices. An owner
// never sees or types a regular expression (spec §8 Bookings panel); each
// choice maps to the pattern the voice engine checks the caller's answer with.

export const FORMAT_CHOICES = [
  { value: "any", label: "Anything" },
  { value: "numbers", label: "Numbers only" },
  { value: "digits", label: "Exactly this many digits" },
  { value: "alnum", label: "Letters and numbers" },
];

export const MIN_DIGITS = 1;
export const MAX_DIGITS = 20;

/** The pattern a choice saves. "custom" keeps whatever was there. */
export function patternFor({ choice, digits }, existing = "") {
  switch (choice) {
    case "numbers":
      return "^\\d+$";
    case "digits": {
      const n = Math.min(MAX_DIGITS, Math.max(MIN_DIGITS, Math.round(Number(digits) || MIN_DIGITS)));
      return `^\\d{${n}}$`;
    }
    case "alnum":
      return "^[A-Za-z0-9]+$";
    case "custom":
      return existing;
    default:
      return "";
  }
}

/**
 * Which choice a saved pattern is. One that matches no choice (set by VetraTD
 * by hand) is "custom": shown read-only and saved back unchanged.
 * @returns {{ choice: "any" | "numbers" | "digits" | "alnum" | "custom", digits?: number }}
 */
export function formatFromPattern(pattern) {
  if (!pattern) return { choice: "any" };
  if (pattern === "^\\d+$" || pattern === "^[0-9]+$") return { choice: "numbers" };
  const exact = /^\^(?:\\d|\[0-9\])\{(\d{1,2})\}\$$/.exec(pattern);
  if (exact) {
    const n = Number(exact[1]);
    if (n >= MIN_DIGITS && n <= MAX_DIGITS) return { choice: "digits", digits: n };
  }
  if (pattern === "^[A-Za-z0-9]+$") return { choice: "alnum" };
  return { choice: "custom" };
}

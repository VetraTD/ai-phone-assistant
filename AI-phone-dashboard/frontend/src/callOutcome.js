export function humanise(key) {
  const s = String(key ?? "").replace(/[_-]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

function display(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// Split call.answers into visible key/value rows, a note, and hide every other
// "_"-prefixed (internal) key.
export function splitAnswers(answers) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return { rows: [], note: "" };
  const rows = Object.entries(answers)
    .filter(([k]) => !k.startsWith("_"))
    .map(([k, v]) => [k, display(v)]);
  const note = display(answers._outcome_note);
  return { rows, note };
}

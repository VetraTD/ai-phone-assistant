// A cell starting with = + - @ (or a tab/CR) is read by Excel and Sheets as a
// formula. Caller-influenced text (names, summaries) must never become one, so
// such a cell gets a leading apostrophe and opens as plain text. Phone numbers
// and plain numbers are left alone so they still read as written.
const FORMULA_LEAD = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?[\d\s().-]+$/;

export function neutraliseFormula(str) {
  if (FORMULA_LEAD.test(str) && !PLAIN_NUMBER.test(str)) return `'${str}`;
  return str;
}

function escapeCsvCell(s) {
  const str = neutraliseFormula(s == null ? "" : String(s));
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function buildCallsCsv(calls) {
  if (!calls?.length) return null;
  const headers = ["Date", "Caller", "Direction", "Status", "Outcome", "Duration (s)", "Sentiment", "Summary"];
  const rows = calls.map((c) => [
    c.started_at ? new Date(c.started_at).toISOString() : "",
    c.caller_name_guess || c.caller_number || "",
    c.direction || "",
    c.inferred_transferred ? "Transferred" : (c.status || ""),
    c.outcome_code || "",
    c.duration_seconds ?? "",
    c.sentiment ?? "",
    (c.summary || "").slice(0, 500),
  ]);
  const line = (arr) => arr.map(escapeCsvCell).join(",");
  return [line(headers), ...rows.map(line)].join("\r\n");
}

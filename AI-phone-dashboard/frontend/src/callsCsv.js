function escapeCsvCell(s) {
  const str = s == null ? "" : String(s);
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

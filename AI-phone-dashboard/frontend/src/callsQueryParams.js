// Query params for GET /api/calls, built from the Calls page filter state.
// Pure so it can be tested without rendering App.
//
// A date PRESET ("last 7 days") sends only `from`. `to` would be the browser's
// local date, which is not the business's date; leaving it off lets the server
// stay open-ended instead of cutting the list off at the wrong midnight. Only
// a custom range the person typed in sends `to`.
export function buildCallsQueryParams({
  businessId, status, callerSearch, datePreset, fromDate, toDate,
  hasAppointments, sentiment, hasSummary, needsFollowUp, direction,
}) {
  const params = { limit: 200, offset: 0 };
  if (businessId) params.business_id = businessId;
  if (status !== "all") params.status = status;
  if (callerSearch.trim()) params.caller = callerSearch.trim();
  if (fromDate) params.from = fromDate;
  if (datePreset === "custom" && toDate) params.to = toDate;
  if (hasAppointments) params.has_appointments = "true";
  if (sentiment !== "all") params.sentiment = sentiment;
  if (hasSummary !== "all") params.has_summary = hasSummary;
  if (needsFollowUp) params.needs_followup = "true";
  if (direction !== "all") params.direction = direction;
  return params;
}

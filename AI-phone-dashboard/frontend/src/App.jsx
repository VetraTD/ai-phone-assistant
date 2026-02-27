import { useEffect, useMemo, useState } from "react";
import axios from "axios";

const BUSINESS_ID = "33ac8c19-a73b-4d5e-9b92-d6f949d5e4ab";

function formatDateYYYYMMDD(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function badgeStyle(type) {
  const t = (type || "").toLowerCase();
  const base = {
    display: "inline-block",
    padding: "3px 8px",
    borderRadius: 999,
    fontSize: 12,
    border: "1px solid #444",
    background: "#141414",
    opacity: 0.9,
  };
  if (t === "callback") return { ...base, border: "1px solid #2f5b8a", background: "#152233" };
  if (t === "message") return { ...base, border: "1px solid #4b7b3b", background: "#142114" };
  if (t === "appointment") return { ...base, border: "1px solid #7b5a2a", background: "#221a10" };
  return base;
}

function App() {
  const API = import.meta.env.VITE_API_URL;

  const [business, setBusiness] = useState(null);

  const [calls, setCalls] = useState([]);
  const [selectedCallId, setSelectedCallId] = useState(null);
  const [callDetails, setCallDetails] = useState(null);

  // Filters
  const [status, setStatus] = useState("all");
  const [callerSearch, setCallerSearch] = useState("");
  const [datePreset, setDatePreset] = useState("7");
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return formatDateYYYYMMDD(d);
  });
  const [toDate, setToDate] = useState(() => formatDateYYYYMMDD(new Date()));
  const [hasAppointments, setHasAppointments] = useState(false);

  // New filters you added in backend
  const [sentiment, setSentiment] = useState("all"); // all | positive | neutral | negative | unknown
  const [hasSummary, setHasSummary] = useState("all"); // all | true | false
  const [needsFollowUp, setNeedsFollowUp] = useState(false);

  // Load business header info
  useEffect(() => {
    axios
      .get(`${API}/api/businesses/${BUSINESS_ID}`)
      .then((res) => setBusiness(res.data))
      .catch((err) => console.error(err));
  }, [API]);

  // Compute date range based on preset unless custom
  useEffect(() => {
    if (datePreset === "custom") return;

    const days = Number(datePreset);
    const to = new Date();
    const from = new Date();
    from.setDate(to.getDate() - days);

    setFromDate(formatDateYYYYMMDD(from));
    setToDate(formatDateYYYYMMDD(to));
  }, [datePreset]);

  const callsQueryParams = useMemo(() => {
    const params = { business_id: BUSINESS_ID };

    if (status !== "all") params.status = status;
    if (callerSearch.trim()) params.caller = callerSearch.trim();
    if (fromDate) params.from = fromDate;
    if (toDate) params.to = toDate;
    if (hasAppointments) params.has_appointments = "true";

    if (sentiment !== "all") params.sentiment = sentiment;
    if (hasSummary !== "all") params.has_summary = hasSummary;
    if (needsFollowUp) params.needs_followup = "true";

    return params;
  }, [
    status,
    callerSearch,
    fromDate,
    toDate,
    hasAppointments,
    sentiment,
    hasSummary,
    needsFollowUp,
  ]);

  // Load calls list (refetch whenever filters change)
  useEffect(() => {
    setCalls([]);

    axios
      .get(`${API}/api/calls`, { params: callsQueryParams })
      .then((res) => {
        setCalls(res.data);

        if (selectedCallId && !res.data.some((c) => c.id === selectedCallId)) {
          setSelectedCallId(null);
          setCallDetails(null);
        }
      })
      .catch((err) => console.error(err));
  }, [API, callsQueryParams, selectedCallId]);

  // Load one call + transcript + appointments + customer requests
  const loadCallDetails = (id) => {
    setSelectedCallId(id);

    axios
      .get(`${API}/api/calls/${id}`)
      .then((res) => setCallDetails(res.data))
      .catch((err) => console.error(err));
  };

  const resetFilters = () => {
    setStatus("all");
    setCallerSearch("");
    setDatePreset("7");
    const d = new Date();
    const from = new Date();
    from.setDate(d.getDate() - 7);
    setFromDate(formatDateYYYYMMDD(from));
    setToDate(formatDateYYYYMMDD(d));
    setHasAppointments(false);

    setSentiment("all");
    setHasSummary("all");
    setNeedsFollowUp(false);
  };

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Top bar */}
      <div style={{ padding: "16px 20px", borderBottom: "1px solid #333" }}>
        <div style={{ fontSize: 28, fontWeight: 800 }}>
          {business?.name ?? "AI Call Dashboard"}
        </div>
        {business ? (
          <div style={{ marginTop: 6, fontSize: 13, opacity: 0.75 }}>
            {business.phone_number} • {business.timezone}
          </div>
        ) : null}
      </div>

      {/* Main split layout */}
      <div
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "420px 1fr",
          gap: 16,
          padding: 16,
          overflow: "hidden",
        }}
      >
        {/* LEFT: Calls list */}
        <div
          style={{
            border: "1px solid #333",
            borderRadius: 10,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <div style={{ padding: 12, borderBottom: "1px solid #333", fontWeight: 700 }}>
            Calls
          </div>

          {/* FILTER BAR */}
          <div
            style={{
              padding: 12,
              borderBottom: "1px solid #333",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>Status</div>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  style={{
                    width: "100%",
                    padding: 8,
                    borderRadius: 8,
                    border: "1px solid #444",
                    background: "#111",
                    color: "white",
                  }}
                >
                  <option value="all">All</option>
                  <option value="completed">Completed</option>
                  <option value="in-progress">In progress</option>
                  <option value="failed">Failed</option>
                  <option value="no-answer">No answer</option>
                  <option value="busy">Busy</option>
                </select>
              </div>

              <div>
                <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>Date Range</div>
                <select
                  value={datePreset}
                  onChange={(e) => setDatePreset(e.target.value)}
                  style={{
                    width: "100%",
                    padding: 8,
                    borderRadius: 8,
                    border: "1px solid #444",
                    background: "#111",
                    color: "white",
                  }}
                >
                  <option value="1">Last 24h</option>
                  <option value="7">Last 7 days</option>
                  <option value="30">Last 30 days</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
            </div>

            {datePreset === "custom" ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>From</div>
                  <input
                    type="date"
                    value={fromDate}
                    onChange={(e) => setFromDate(e.target.value)}
                    style={{
                      width: "100%",
                      padding: 8,
                      borderRadius: 8,
                      border: "1px solid #444",
                      background: "#111",
                      color: "white",
                    }}
                  />
                </div>
                <div>
                  <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>To</div>
                  <input
                    type="date"
                    value={toDate}
                    onChange={(e) => setToDate(e.target.value)}
                    style={{
                      width: "100%",
                      padding: 8,
                      borderRadius: 8,
                      border: "1px solid #444",
                      background: "#111",
                      color: "white",
                    }}
                  />
                </div>
              </div>
            ) : null}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>Sentiment</div>
                <select
                  value={sentiment}
                  onChange={(e) => setSentiment(e.target.value)}
                  style={{
                    width: "100%",
                    padding: 8,
                    borderRadius: 8,
                    border: "1px solid #444",
                    background: "#111",
                    color: "white",
                  }}
                >
                  <option value="all">All</option>
                  <option value="positive">Positive</option>
                  <option value="neutral">Neutral</option>
                  <option value="negative">Negative</option>
                  <option value="unknown">Unknown</option>
                </select>
              </div>

              <div>
                <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>Summary</div>
                <select
                  value={hasSummary}
                  onChange={(e) => setHasSummary(e.target.value)}
                  style={{
                    width: "100%",
                    padding: 8,
                    borderRadius: 8,
                    border: "1px solid #444",
                    background: "#111",
                    color: "white",
                  }}
                >
                  <option value="all">All</option>
                  <option value="true">Has summary</option>
                  <option value="false">No summary</option>
                </select>
              </div>
            </div>

            <div>
              <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>Caller search</div>
              <input
                value={callerSearch}
                onChange={(e) => setCallerSearch(e.target.value)}
                placeholder="e.g. +4477 or 938887"
                style={{
                  width: "100%",
                  padding: 8,
                  borderRadius: 8,
                  border: "1px solid #444",
                  background: "#111",
                  color: "white",
                }}
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={hasAppointments}
                  onChange={(e) => setHasAppointments(e.target.checked)}
                />
                Only calls with appointments
              </label>

              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={needsFollowUp}
                  onChange={(e) => setNeedsFollowUp(e.target.checked)}
                />
                Needs follow up
              </label>
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
                marginTop: 4,
              }}
            >
              <div style={{ fontSize: 12, opacity: 0.6 }}>
                Showing {calls.length} call{calls.length === 1 ? "" : "s"}
              </div>

              <button
                onClick={resetFilters}
                style={{
                  padding: "6px 10px",
                  borderRadius: 8,
                  border: "1px solid #444",
                  background: "#111",
                  color: "white",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                Reset
              </button>
            </div>
          </div>

          {/* CALL LIST */}
          <div style={{ padding: 12, overflowY: "auto", minHeight: 0 }}>
            {calls.map((call) => (
              <div
                key={call.id}
                onClick={() => loadCallDetails(call.id)}
                style={{
                  border: selectedCallId === call.id ? "2px solid white" : "1px solid #444",
                  borderRadius: 10,
                  padding: 12,
                  marginBottom: 10,
                  cursor: "pointer",
                  background: selectedCallId === call.id ? "#151515" : "transparent",
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 6 }}>{call.caller_number}</div>

                <div style={{ display: "flex", gap: 12, fontSize: 13, opacity: 0.9, flexWrap: "wrap" }}>
                  <span>
                    <b>Status:</b> {call.status}
                  </span>
                  <span>
                    <b>Dur:</b> {call.duration_seconds ?? "-"}s
                  </span>
                  <span>
                    <b>Sent:</b> {call.sentiment ?? "unknown"}
                  </span>
                  <span style={{ opacity: call.summary ? 0.9 : 0.6 }}>
                    <b>Sum:</b> {call.summary ? "✓" : "–"}
                  </span>
                </div>

                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                  {call.started_at ? new Date(call.started_at).toLocaleString() : ""}
                </div>
              </div>
            ))}

            {!calls.length ? (
              <div style={{ opacity: 0.7, padding: 10 }}>No calls match filters.</div>
            ) : null}
          </div>
        </div>

        {/* RIGHT: Details */}
        <div
          style={{
            border: "1px solid #333",
            borderRadius: 10,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <div style={{ padding: 12, borderBottom: "1px solid #333", fontWeight: 700 }}>
            Call Details
          </div>

          <div
            style={{
              padding: 16,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              gap: 16,
              overflow: "hidden",
            }}
          >
            {!callDetails ? (
              <div style={{ opacity: 0.7 }}>
                Select a call on the left to view transcript + appointments + customer requests.
              </div>
            ) : (
              <>
                {/* Call Info */}
                <div style={{ border: "1px solid #444", borderRadius: 10, padding: 14, flex: "0 0 auto" }}>
                  <div style={{ fontWeight: 800, marginBottom: 10 }}>Call Info</div>

                  <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", rowGap: 6 }}>
                    <div style={{ opacity: 0.7 }}>Status</div>
                    <div>{callDetails.call.status}</div>

                    <div style={{ opacity: 0.7 }}>Duration</div>
                    <div>{callDetails.call.duration_seconds ?? "-"} sec</div>

                    <div style={{ opacity: 0.7 }}>Started</div>
                    <div>
                      {callDetails.call.started_at
                        ? new Date(callDetails.call.started_at).toLocaleString()
                        : "-"}
                    </div>

                    <div style={{ opacity: 0.7 }}>Summary</div>
                    <div>{callDetails.call.summary ?? "No summary yet"}</div>

                    <div style={{ opacity: 0.7 }}>Sentiment</div>
                    <div>{callDetails.call.sentiment ?? "Unknown"}</div>
                  </div>
                </div>

                {/* Transcript */}
                <div style={{ fontWeight: 800, flex: "0 0 auto" }}>Transcript</div>

                <div
                  style={{
                    border: "1px solid #444",
                    borderRadius: 10,
                    padding: 12,
                    minHeight: 0,
                    flex: "1 1 auto",
                    overflowY: "auto",
                  }}
                >
                  {callDetails.transcript?.length ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {callDetails.transcript.map((line) => (
                        <div
                          key={line.id}
                          style={{
                            display: "flex",
                            justifyContent: line.speaker === "ai" ? "flex-start" : "flex-end",
                          }}
                        >
                          <div
                            style={{
                              maxWidth: "70%",
                              padding: 10,
                              borderRadius: 12,
                              border: "1px solid #444",
                              background: line.speaker === "ai" ? "#141414" : "#1b2a3a",
                              whiteSpace: "pre-wrap",
                            }}
                          >
                            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>
                              {line.speaker}
                            </div>
                            {line.message}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ opacity: 0.7 }}>No transcript found.</div>
                  )}
                </div>

                {/* Appointments */}
                <div style={{ fontWeight: 800, flex: "0 0 auto" }}>Appointments</div>

                <div style={{ flex: "0 0 auto" }}>
                  {callDetails.appointments?.length ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {callDetails.appointments.map((appt) => (
                        <div
                          key={appt.id}
                          style={{ border: "1px solid #444", borderRadius: 10, padding: 12 }}
                        >
                          <div style={{ fontWeight: 700, marginBottom: 6 }}>
                            {appt.client_name} — {appt.client_phone}
                          </div>

                          <div style={{ fontSize: 13, opacity: 0.85 }}>
                            <b>Scheduled:</b>{" "}
                            {appt.scheduled_at ? new Date(appt.scheduled_at).toLocaleString() : "-"}
                          </div>

                          <div style={{ fontSize: 13, opacity: 0.85 }}>
                            <b>Status:</b> {appt.status}
                          </div>

                          {appt.notes ? (
                            <div style={{ fontSize: 13, opacity: 0.85, marginTop: 6 }}>
                              <b>Notes:</b> {appt.notes}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ opacity: 0.7 }}>No appointments linked to this call.</div>
                  )}
                </div>

                {/* ✅ Customer Requests */}
                <div style={{ fontWeight: 800, flex: "0 0 auto", marginTop: 8 }}>
                  Customer Requests
                </div>

                <div style={{ flex: "0 0 auto" }}>
                  {callDetails.customer_requests?.length ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {callDetails.customer_requests.map((r) => (
                        <div
                          key={r.id}
                          style={{ border: "1px solid #444", borderRadius: 10, padding: 12 }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                            <span style={badgeStyle(r.request_type)}>{r.request_type}</span>
                            <div style={{ fontWeight: 700 }}>
                              {r.caller_name || "Unknown"}{" "}
                              <span style={{ opacity: 0.7, fontWeight: 400 }}>
                                — {r.callback_number || ""}
                              </span>
                            </div>
                          </div>

                          {r.message ? (
                            <div style={{ fontSize: 13, opacity: 0.9, whiteSpace: "pre-wrap" }}>
                              {r.message}
                            </div>
                          ) : null}

                          <div style={{ fontSize: 12, opacity: 0.6, marginTop: 8 }}>
                            {r.created_at ? new Date(r.created_at).toLocaleString() : ""}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ opacity: 0.7 }}>No customer requests for this call.</div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
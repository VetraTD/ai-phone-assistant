import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { supabase } from "./supabaseClient";

import "./dashboard.css";

import Login from "./Login";
import Signup from "./Signup";
import Onboarding from "./Onboarding";

function formatDateYYYYMMDD(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function badgeStyle(type) {
  const t = (type || "").toLowerCase();

  const base = {
    display: "inline-flex",
    alignItems: "center",
    padding: "4px 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 600,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.04)",
    color: "#e7eef7",
  };

  if (t === "callback") {
    return {
      ...base,
      background: "rgba(76,129,255,0.14)",
      border: "1px solid rgba(76,129,255,0.28)",
      color: "#bcd3ff",
    };
  }

  if (t === "message") {
    return {
      ...base,
      background: "rgba(67,182,110,0.14)",
      border: "1px solid rgba(67,182,110,0.28)",
      color: "#bcefc9",
    };
  }

  if (t === "appointment") {
    return {
      ...base,
      background: "rgba(255,184,76,0.14)",
      border: "1px solid rgba(255,184,76,0.28)",
      color: "#ffe0a8",
    };
  }

  return base;
}

function getStatusPillStyle(status) {
  const s = (status || "").toLowerCase();

  const base = {
    display: "inline-flex",
    alignItems: "center",
    height: 28,
    padding: "0 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 600,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.05)",
    color: "#dfe8f2",
  };

  if (s === "completed") {
    return {
      ...base,
      background: "rgba(67,182,110,0.14)",
      border: "1px solid rgba(67,182,110,0.28)",
      color: "#bcefc9",
    };
  }

  if (s === "failed" || s === "busy" || s === "no-answer") {
    return {
      ...base,
      background: "rgba(255,107,107,0.14)",
      border: "1px solid rgba(255,107,107,0.28)",
      color: "#ffb9b9",
    };
  }

  if (s === "in-progress") {
    return {
      ...base,
      background: "rgba(76,129,255,0.14)",
      border: "1px solid rgba(76,129,255,0.28)",
      color: "#bcd3ff",
    };
  }

  return base;
}

function getSentimentPillStyle(sentiment) {
  const s = (sentiment || "").toLowerCase();

  const base = {
    display: "inline-flex",
    alignItems: "center",
    height: 28,
    padding: "0 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 600,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.05)",
    color: "#dfe8f2",
  };

  if (s === "positive") {
    return {
      ...base,
      background: "rgba(67,182,110,0.14)",
      border: "1px solid rgba(67,182,110,0.28)",
      color: "#bcefc9",
    };
  }

  if (s === "negative") {
    return {
      ...base,
      background: "rgba(255,107,107,0.14)",
      border: "1px solid rgba(255,107,107,0.28)",
      color: "#ffb9b9",
    };
  }

  if (s === "neutral") {
    return {
      ...base,
      background: "rgba(255,255,255,0.06)",
      border: "1px solid rgba(255,255,255,0.1)",
      color: "#d6dfeb",
    };
  }

  return {
    ...base,
    background: "rgba(255,184,76,0.14)",
    border: "1px solid rgba(255,184,76,0.28)",
    color: "#ffe0a8",
  };
}

function LoadingScreen({ title, subtitle }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(circle at top left, rgba(45,110,255,0.12), transparent 30%), radial-gradient(circle at bottom right, rgba(31,209,184,0.10), transparent 28%), #08111b",
        color: "#f4f7fb",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 460,
          borderRadius: 24,
          border: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(8, 14, 24, 0.82)",
          boxShadow: "0 18px 50px rgba(0, 0, 0, 0.25)",
          backdropFilter: "blur(10px)",
          padding: 32,
          textAlign: "center",
        }}
      >
        <div
          style={{
            width: 52,
            height: 52,
            margin: "0 auto 18px",
            borderRadius: "50%",
            border: "4px solid rgba(255,255,255,0.12)",
            borderTopColor: "#58a4ff",
            animation: "spin 0.8s linear infinite",
          }}
        />
        <div
          style={{
            fontSize: 28,
            fontWeight: 800,
            letterSpacing: "-0.03em",
            marginBottom: 8,
          }}
        >
          {title}
        </div>
        <div
          style={{
            color: "#9bacbf",
            fontSize: 15,
            lineHeight: 1.6,
          }}
        >
          {subtitle}
        </div>

        <style>{`
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    </div>
  );
}

function App() {
  const [authView, setAuthView] = useState("login");

  const [session, setSession] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);

  const [needsOnboarding, setNeedsOnboarding] = useState(false);

  const [meLoading, setMeLoading] = useState(true);
  const [meError, setMeError] = useState(null);

  const [businessId, setBusinessId] = useState(null);
  const [business, setBusiness] = useState(null);
  const [analytics, setAnalytics] = useState(null);

  const [calls, setCalls] = useState([]);
  const [selectedCallId, setSelectedCallId] = useState(null);
  const [callDetails, setCallDetails] = useState(null);

  const [callsLoading, setCallsLoading] = useState(false);
  const [callsError, setCallsError] = useState(null);

  const [callDetailsLoading, setCallDetailsLoading] = useState(false);
  const [callDetailsError, setCallDetailsError] = useState(null);

  const [analyticsError, setAnalyticsError] = useState(null);

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

  const [sentiment, setSentiment] = useState("all");
  const [hasSummary, setHasSummary] = useState("all");
  const [needsFollowUp, setNeedsFollowUp] = useState(false);

  useEffect(() => {
    const boot = async () => {
      const { data } = await supabase.auth.getSession();
      setSession(data.session || null);
      setCheckingSession(false);
    };

    boot();

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, newSession) => {
        setSession(newSession || null);
      }
    );

    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const loadMe = async () => {
      if (!session) {
        setBusiness(null);
        setBusinessId(null);
        setAnalytics(null);
        setCalls([]);
        setCallDetails(null);
        setSelectedCallId(null);
        setNeedsOnboarding(false);
        setMeError(null);
        setMeLoading(false);
        setCallsError(null);
        setCallDetailsError(null);
        return;
      }

      setMeLoading(true);
      setMeError(null);

      try {
        const res = await api.get("/api/me");

        const needs = !!res.data.needsOnboarding;
        setNeedsOnboarding(needs);

        const biz = needs ? null : res.data.business || null;
        setBusiness(biz);
        setBusinessId(biz?.id || null);
      } catch (err) {
        const msg = err?.response?.data?.error || err?.message || "Unknown error";
        setMeError(msg);
        setBusiness(null);
        setBusinessId(null);
      } finally {
        setMeLoading(false);
      }
    };

    loadMe();
  }, [session]);

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
    const params = {};

    if (businessId) params.business_id = businessId;

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
    businessId,
    status,
    callerSearch,
    fromDate,
    toDate,
    hasAppointments,
    sentiment,
    hasSummary,
    needsFollowUp,
  ]);

  useEffect(() => {
    if (!businessId) return;

    const fetchAnalytics = () =>
      api
        .get(`/api/analytics/${businessId}`)
        .then((res) => {
          setAnalytics(res.data);
          setAnalyticsError(null);
        })
        .catch((err) => {
          console.error(err);
          setAnalyticsError(
            err?.response?.data?.error || err?.message || "Failed to load analytics"
          );
        });

    fetchAnalytics();
    const t = setInterval(fetchAnalytics, 15000);
    return () => clearInterval(t);
  }, [businessId]);

  useEffect(() => {
    if (!businessId) return;

    setCallsLoading(true);
    setCallsError(null);
    setCalls([]);

    api
      .get(`/api/calls`, { params: callsQueryParams })
      .then((res) => {
        setCalls(res.data);

        if (selectedCallId && !res.data.some((c) => c.id === selectedCallId)) {
          setSelectedCallId(null);
          setCallDetails(null);
          setCallDetailsError(null);
        }
      })
      .catch((err) => {
        console.error(err);
        setCallsError(
          err?.response?.data?.error || err?.message || "Failed to load calls"
        );
      })
      .finally(() => {
        setCallsLoading(false);
      });
  }, [businessId, callsQueryParams, selectedCallId]);

  const loadCallDetails = (id) => {
    if (!businessId) return;

    setSelectedCallId(id);
    setCallDetailsLoading(true);
    setCallDetailsError(null);

    api
      .get(`/api/calls/${id}`)
      .then((res) => {
        setCallDetails(res.data);
      })
      .catch((err) => {
        console.error(err);
        setCallDetails(null);
        setCallDetailsError(
          err?.response?.data?.error || err?.message || "Failed to load call details"
        );
      })
      .finally(() => {
        setCallDetailsLoading(false);
      });
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

  if (checkingSession) {
    return (
      <LoadingScreen
        title="Checking your session"
        subtitle="Please wait while we securely restore your dashboard access."
      />
    );
  }

  if (!session) {
    return authView === "login" ? (
      <Login onSwitchToSignup={() => setAuthView("signup")} />
    ) : (
      <Signup onSwitchToLogin={() => setAuthView("login")} />
    );
  }

  if (needsOnboarding) {
    return (
      <Onboarding
        onComplete={(biz) => {
          setNeedsOnboarding(false);
          setBusiness(biz);
          setBusinessId(biz.id);
        }}
      />
    );
  }

  if (meLoading) {
    return (
      <LoadingScreen
        title="Loading dashboard"
        subtitle="We’re gathering your business overview, calls, and analytics."
      />
    );
  }

  if (meError) {
    return (
      <div
        style={{
          padding: 24,
          fontFamily: "system-ui",
          color: "white",
          background: "#0b0b0b",
          minHeight: "100vh",
        }}
      >
        <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 10 }}>
          Couldn’t load account
        </div>
        <div style={{ opacity: 0.8, marginBottom: 14 }}>{meError}</div>

        <button
          onClick={async () => {
            await supabase.auth.signOut();
            window.location.reload();
          }}
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid #444",
            background: "#111",
            color: "white",
            cursor: "pointer",
          }}
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <div className="dashboard-page">
      <div className="dashboard-shell">
        <header className="dashboard-topbar">
          <div className="dashboard-topbar-left">
            <div className="dashboard-badge">AI Call Dashboard</div>

            <h1 className="dashboard-business-name">
              {business?.name ?? "AI Call Dashboard"}
            </h1>

            {business ? (
              <div className="dashboard-business-meta">
                <span className="dashboard-meta-pill">
                  {business.phone_number || "No phone number"}
                </span>
                <span className="dashboard-meta-pill">
                  {business.timezone || "No timezone"}
                </span>
              </div>
            ) : null}
          </div>

          <div className="dashboard-topbar-right">
            <button
              className="dashboard-logout"
              onClick={async () => {
                await supabase.auth.signOut();
                window.location.reload();
              }}
            >
              Logout
            </button>
          </div>
        </header>

        {analytics ? (
          <section className="dashboard-kpis">
            <div className="kpi-card">
              <div className="kpi-label">Calls Today</div>
              <div className="kpi-value">{analytics.calls_today ?? 0}</div>
            </div>

            <div className="kpi-card">
              <div className="kpi-label">Appointments Today</div>
              <div className="kpi-value">{analytics.appointments_today ?? 0}</div>
            </div>

            <div className="kpi-card">
              <div className="kpi-label">Follow Ups Needed</div>
              <div className="kpi-value">{analytics.followups_needed ?? 0}</div>
            </div>

            <div className="kpi-card">
              <div className="kpi-label">Positive Calls</div>
              <div className="kpi-value">
                {(analytics.positive_calls_percent ?? 0) + "%"}
              </div>
            </div>
          </section>
        ) : analyticsError ? (
          <section className="dashboard-kpis">
            <div className="kpi-card" style={{ gridColumn: "1 / -1" }}>
              <div className="kpi-label">Analytics</div>
              <div className="empty-note">{analyticsError}</div>
            </div>
          </section>
        ) : null}

        <section className="dashboard-main">
          <aside className="panel">
            <div className="panel-header">
              <h2 className="panel-title">Calls</h2>
            </div>

            <div className="panel-body">
              <div className="filters-grid">
                <div className="filter-row-2">
                  <div className="filter-field">
                    <label>Status</label>
                    <select
                      value={status}
                      onChange={(e) => setStatus(e.target.value)}
                    >
                      <option value="all">All</option>
                      <option value="completed">Completed</option>
                      <option value="in-progress">In progress</option>
                      <option value="failed">Failed</option>
                      <option value="no-answer">No answer</option>
                      <option value="busy">Busy</option>
                    </select>
                  </div>

                  <div className="filter-field">
                    <label>Date Range</label>
                    <select
                      value={datePreset}
                      onChange={(e) => setDatePreset(e.target.value)}
                    >
                      <option value="1">Last 24h</option>
                      <option value="7">Last 7 days</option>
                      <option value="30">Last 30 days</option>
                      <option value="custom">Custom</option>
                    </select>
                  </div>
                </div>

                {datePreset === "custom" ? (
                  <div className="filter-row-2">
                    <div className="filter-field">
                      <label>From</label>
                      <input
                        type="date"
                        value={fromDate}
                        onChange={(e) => setFromDate(e.target.value)}
                      />
                    </div>

                    <div className="filter-field">
                      <label>To</label>
                      <input
                        type="date"
                        value={toDate}
                        onChange={(e) => setToDate(e.target.value)}
                      />
                    </div>
                  </div>
                ) : null}

                <div className="filter-row-2">
                  <div className="filter-field">
                    <label>Sentiment</label>
                    <select
                      value={sentiment}
                      onChange={(e) => setSentiment(e.target.value)}
                    >
                      <option value="all">All</option>
                      <option value="positive">Positive</option>
                      <option value="neutral">Neutral</option>
                      <option value="negative">Negative</option>
                      <option value="unknown">Unknown</option>
                    </select>
                  </div>

                  <div className="filter-field">
                    <label>Summary</label>
                    <select
                      value={hasSummary}
                      onChange={(e) => setHasSummary(e.target.value)}
                    >
                      <option value="all">All</option>
                      <option value="true">Has summary</option>
                      <option value="false">No summary</option>
                    </select>
                  </div>
                </div>

                <div className="filter-field">
                  <label>Caller search</label>
                  <input
                    value={callerSearch}
                    onChange={(e) => setCallerSearch(e.target.value)}
                    placeholder="e.g. +4477 or 938887"
                  />
                </div>

                <div className="checkbox-list">
                  <label className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={hasAppointments}
                      onChange={(e) => setHasAppointments(e.target.checked)}
                    />
                    <span>Only calls with appointments</span>
                  </label>

                  <label className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={needsFollowUp}
                      onChange={(e) => setNeedsFollowUp(e.target.checked)}
                    />
                    <span>Needs follow up</span>
                  </label>
                </div>
              </div>

              <div className="calls-toolbar">
                <span>
                  {callsLoading
                    ? "Loading calls..."
                    : `Showing ${calls.length} call${calls.length === 1 ? "" : "s"}`}
                </span>

                <button className="reset-button" onClick={resetFilters}>
                  Reset
                </button>
              </div>

              <div className="calls-list">
                {callsLoading ? (
                  <div className="empty-note">Loading calls…</div>
                ) : callsError ? (
                  <div className="empty-note">{callsError}</div>
                ) : !calls.length ? (
                  <div className="empty-note">
                    No calls match these filters.
                  </div>
                ) : (
                  calls.map((call) => (
                    <div
                      key={call.id}
                      onClick={() => loadCallDetails(call.id)}
                      className={`call-card ${
                        selectedCallId === call.id ? "is-active" : ""
                      }`}
                    >
                      <div className="call-card-top">
                        <div
                          className="call-number"
                          style={{ fontSize: 18, marginBottom: 0 }}
                        >
                          {call.caller_number}
                        </div>
                      </div>

                      <div className="call-date">
                        {call.started_at
                          ? new Date(call.started_at).toLocaleString()
                          : ""}
                      </div>

                      <div className="call-meta" style={{ marginTop: 12 }}>
                        <span style={getStatusPillStyle(call.status)}>
                          {call.status}
                        </span>

                        <span className="call-pill">
                          {call.duration_seconds ?? "-"}s
                        </span>

                        <span style={getSentimentPillStyle(call.sentiment)}>
                          {call.sentiment ?? "unknown"}
                        </span>

                        <span className="call-pill">
                          {call.summary ? "Summary ✓" : "No summary"}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </aside>

          <section className="panel">
            <div className="panel-header">
              <h2 className="panel-title">Call Details</h2>
            </div>

            <div className="panel-body">
              {callDetailsLoading ? (
                <div className="details-empty">Loading call details…</div>
              ) : callDetailsError ? (
                <div className="details-empty">{callDetailsError}</div>
              ) : !callDetails ? (
                <div className="details-empty">
                  Select a call on the left to view transcript, appointments, and
                  customer requests.
                </div>
              ) : (
                <div className="details-stack">
                  <div className="detail-card">
                    <h3 className="detail-card-title">Call Info</h3>

                    <div className="info-grid">
                      <div className="info-label">Status</div>
                      <div className="info-value">{callDetails.call.status}</div>

                      <div className="info-label">Duration</div>
                      <div className="info-value">
                        {callDetails.call.duration_seconds ?? "-"} sec
                      </div>

                      <div className="info-label">Started</div>
                      <div className="info-value">
                        {callDetails.call.started_at
                          ? new Date(callDetails.call.started_at).toLocaleString()
                          : "-"}
                      </div>

                      <div className="info-label">Summary</div>
                      <div className="info-value">
                        {callDetails.call.summary ?? "No summary yet"}
                      </div>

                      <div className="info-label">Sentiment</div>
                      <div className="info-value">
                        {callDetails.call.sentiment ?? "Unknown"}
                      </div>
                    </div>
                  </div>

                  <div className="detail-card">
                    <h3 className="detail-card-title">Transcript</h3>

                    {callDetails.transcript?.length ? (
                      <div
                        style={{
                          maxHeight: 420,
                          overflowY: "auto",
                          paddingRight: 6,
                        }}
                      >
                        <div className="transcript-list">
                          {callDetails.transcript.map((line) => {
                            const isAi = line.speaker === "ai";

                            return (
                              <div
                                key={line.id}
                                className={`transcript-row ${isAi ? "ai" : "caller"}`}
                              >
                                <div
                                  className={`transcript-bubble ${
                                    isAi ? "ai" : "caller"
                                  }`}
                                >
                                  <div className="transcript-speaker">
                                    {isAi ? "AI Receptionist" : "Caller"}
                                  </div>

                                  <div className="transcript-message">
                                    {line.message}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ) : (
                      <div className="empty-note">
                        No transcript was captured for this call.
                      </div>
                    )}
                  </div>

                  <div className="detail-card">
                    <h3 className="detail-card-title">Appointments</h3>

                    {callDetails.appointments?.length ? (
                      <div className="sub-card-stack">
                        {callDetails.appointments.map((appt) => (
                          <div key={appt.id} className="sub-card">
                            <div className="sub-card-title">
                              {appt.client_name} — {appt.client_phone}
                            </div>

                            <div className="detail-block-text">
                              <b>Scheduled:</b>{" "}
                              {appt.scheduled_at
                                ? new Date(appt.scheduled_at).toLocaleString()
                                : "-"}
                            </div>

                            <div className="detail-block-text">
                              <b>Status:</b> {appt.status}
                            </div>

                            {appt.notes ? (
                              <div className="detail-block-text">
                                <b>Notes:</b> {appt.notes}
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="empty-note">
                        No appointments were linked to this call.
                      </div>
                    )}
                  </div>

                  <div className="detail-card">
                    <h3 className="detail-card-title">Customer Requests</h3>

                    {callDetails.customer_requests?.length ? (
                      <div className="sub-card-stack">
                        {callDetails.customer_requests.map((r) => (
                          <div key={r.id} className="sub-card">
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                                marginBottom: 6,
                                flexWrap: "wrap",
                              }}
                            >
                              <span style={badgeStyle(r.request_type)}>
                                {r.request_type}
                              </span>

                              <div style={{ fontWeight: 700 }}>
                                {r.caller_name || "Unknown"}{" "}
                                <span style={{ opacity: 0.7, fontWeight: 400 }}>
                                  — {r.callback_number || ""}
                                </span>
                              </div>
                            </div>

                            {r.message ? (
                              <div
                                className="detail-block-text"
                                style={{ whiteSpace: "pre-wrap" }}
                              >
                                {r.message}
                              </div>
                            ) : null}

                            <div
                              style={{
                                fontSize: 12,
                                opacity: 0.6,
                                marginTop: 8,
                              }}
                            >
                              {r.created_at
                                ? new Date(r.created_at).toLocaleString()
                                : ""}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="empty-note">
                        No customer requests were captured for this call.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>
        </section>
      </div>
    </div>
  );
}

export default App;
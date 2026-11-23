import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { signOut } from "./auth";
import { useTranslations } from "./LanguageSwitcher";

import "./Dashboard.css";

import SessionGate from "./shell/SessionGate";
import { useBusiness } from "./shell/BusinessContext";
import SettingsPage from "./settings/SettingsPage";
import CallOutcomeAnswers from "./components/CallOutcomeAnswers";
import { humanise } from "./callOutcome";
import { buildCallsCsv } from "./callsCsv";
import { buildCallsQueryParams } from "./callsQueryParams";

function formatDateYYYYMMDD(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function downloadCsv(csvContent, filename) {
  const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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
    border: "1px solid var(--vetra-border)",
    background: "var(--vetra-bg-2)",
    color: "var(--vetra-muted)",
  };
  if (t === "callback")
    return { ...base, background: "rgba(58,143,242,0.12)", border: "1px solid rgba(58,143,242,0.3)", color: "#2a6fd6" };
  if (t === "message")
    return { ...base, background: "rgba(67,182,110,0.14)", border: "1px solid rgba(67,182,110,0.32)", color: "#1f8a4c" };
  if (t === "appointment")
    return { ...base, background: "rgba(255,184,76,0.16)", border: "1px solid rgba(255,184,76,0.42)", color: "#9a6a12" };
  return base;
}

function getStatusPillStyle(status) {
  const s = (status || "").toLowerCase();
  const base = {
    display: "inline-flex", alignItems: "center", height: 28, padding: "0 10px",
    borderRadius: 999, fontSize: 12, fontWeight: 600,
    border: "1px solid var(--vetra-border)", background: "var(--vetra-bg-2)", color: "var(--vetra-muted)",
  };
  if (s === "completed")
    return { ...base, background: "rgba(67,182,110,0.14)", border: "1px solid rgba(67,182,110,0.32)", color: "#1f8a4c" };
  if (s === "transferred")
    return { ...base, background: "rgba(58,143,242,0.12)", border: "1px solid rgba(58,143,242,0.3)", color: "#2a6fd6" };
  if (s === "failed" || s === "busy" || s === "no-answer")
    return { ...base, background: "rgba(220,80,80,0.12)", border: "1px solid rgba(220,80,80,0.32)", color: "#b91c1c" };
  if (s === "in-progress")
    return { ...base, background: "rgba(58,143,242,0.12)", border: "1px solid rgba(58,143,242,0.3)", color: "#2a6fd6" };
  return base;
}

function AnalyticsPeriodSelect({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (!ref.current || ref.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const options = [
    { value: "7d", label: "Last 7 days" },
    { value: "30d", label: "Last 30 days" },
    { value: "90d", label: "Last 3 months" },
  ];

  const current = options.find((o) => o.value === value) || options[1];

  return (
    <div className="analytics-period" ref={ref}>
      <button
        type="button"
        className="analytics-period-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="analytics-period-label">{current.label}</span>
        <span className="analytics-period-chevron">▾</span>
      </button>
      {open && (
        <div
          className="analytics-period-menu"
          role="listbox"
          aria-label="Analytics period"
        >
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`analytics-period-item ${
                opt.value === value ? "is-active" : ""
              }`}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              role="option"
              aria-selected={opt.value === value}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function getSentimentPillStyle(sentiment) {
  const s = (sentiment || "").toLowerCase();
  const base = {
    display: "inline-flex", alignItems: "center", height: 28, padding: "0 10px",
    borderRadius: 999, fontSize: 12, fontWeight: 600,
    border: "1px solid var(--vetra-border)", background: "var(--vetra-bg-2)", color: "var(--vetra-muted)",
  };
  if (s === "positive")
    return { ...base, background: "rgba(67,182,110,0.14)", border: "1px solid rgba(67,182,110,0.32)", color: "#1f8a4c" };
  if (s === "negative")
    return { ...base, background: "rgba(220,80,80,0.12)", border: "1px solid rgba(220,80,80,0.32)", color: "#b91c1c" };
  if (s === "neutral")
    return { ...base, background: "var(--vetra-bg-2)", border: "1px solid var(--vetra-border-strong)", color: "var(--vetra-muted)" };
  return { ...base, background: "rgba(255,184,76,0.16)", border: "1px solid rgba(255,184,76,0.42)", color: "#9a6a12" };
}

function AnimatedNumber({ value, duration = 1200, suffix = "" }) {
  const num = Number(value);
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    if (typeof num !== "number" || isNaN(num) || num < 0) return;
    setDisplay(0);
    const start = performance.now();
    let rafId;
    const tick = (now) => {
      const elapsed = now - start;
      const t = Math.min(elapsed / duration, 1);
      const easeOut = 1 - Math.pow(1 - t, 2);
      setDisplay(Math.round(easeOut * num));
      if (t < 1) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [num, duration]);

  if (typeof num !== "number" || isNaN(num)) return <>{String(0) + suffix}</>;
  return <>{display}{suffix}</>;
}

// The old one-page dashboard. Sign-in, the /api/me business, onboarding and
// idle sign-out moved to shell/SessionGate; this reads the business from it.
// Deleted in Task 14 when the new pages replace it.
function Dashboard() {
  const t = useTranslations();
  const { business, businessId, setBusiness } = useBusiness();

  const [analytics, setAnalytics] = useState(null);
  const [calls, setCalls] = useState([]);
  const [callsTotal, setCallsTotal] = useState(null);
  const [selectedCallId, setSelectedCallId] = useState(null);
  const [callDetails, setCallDetails] = useState(null);
  const [callsLoading, setCallsLoading] = useState(false);
  const [callsError, setCallsError] = useState(null);
  const [callsLoadingMore, setCallsLoadingMore] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(null);
  const selectedCallIdRef = useRef(null);
  selectedCallIdRef.current = selectedCallId;
  const [callDetailsLoading, setCallDetailsLoading] = useState(false);
  const [callDetailsError, setCallDetailsError] = useState(null);
  const [analyticsError, setAnalyticsError] = useState(null);
  const [status, setStatus] = useState("all");
  const [callerSearch, setCallerSearch] = useState("");
  const [datePreset, setDatePreset] = useState("7");
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 7); return formatDateYYYYMMDD(d);
  });
  const [toDate, setToDate] = useState(() => formatDateYYYYMMDD(new Date()));
  const [hasAppointments, setHasAppointments] = useState(false);
  const [sentiment, setSentiment] = useState("all");
  const [hasSummary, setHasSummary] = useState("all");
  const [direction, setDirection] = useState("all");
  const [needsFollowUp, setNeedsFollowUp] = useState(false);
  const [activePage, setActivePage] = useState("dashboard");
  const [toast, setToast] = useState(null);
  const navTabsRef = useRef(null);
  const [navHighlight, setNavHighlight] = useState({ left: 0, width: 0 });
  const [analyticsBreakdown, setAnalyticsBreakdown] = useState(null);
  const [analyticsPeriod, setAnalyticsPeriod] = useState("90d");
  const [appointmentsEmailRange, setAppointmentsEmailRange] = useState("today");
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [usage, setUsage] = useState(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState(null);
  const [appointmentsList, setAppointmentsList] = useState([]);
  const [appointmentsLoading, setAppointmentsLoading] = useState(false);
  const [appointmentsError, setAppointmentsError] = useState(null);
  const [appointmentsRange, setAppointmentsRange] = useState("upcoming");

  useEffect(() => {
    const container = navTabsRef.current;
    if (!container) return;
    const el = container.querySelector(`[data-tab="${activePage}"]`);
    if (!el) return;
    const crect = container.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    setNavHighlight({
      left: rect.left - crect.left,
      width: rect.width,
    });
  }, [activePage]);

  useEffect(() => {
    if (datePreset === "custom") return;
    const days = Number(datePreset);
    const to = new Date(); const from = new Date();
    from.setDate(to.getDate() - days);
    setFromDate(formatDateYYYYMMDD(from)); setToDate(formatDateYYYYMMDD(to));
  }, [datePreset]);

  useEffect(() => {
    if (activePage !== "settings" || !businessId) return;
    setUsageLoading(true); setUsageError(null);
    api.get("/api/usage")
      .then((res) => { setUsage(res.data); })
      .catch((err) => { setUsageError(err?.response?.data?.error || "Failed to load usage"); setUsage(null); })
      .finally(() => { setUsageLoading(false); });
  }, [activePage, businessId]);

  const callsQueryParams = useMemo(() => {
    return buildCallsQueryParams({
      businessId, status, callerSearch, datePreset, fromDate, toDate,
      hasAppointments, sentiment, hasSummary, needsFollowUp, direction,
    });
  }, [businessId, status, callerSearch, datePreset, fromDate, toDate, hasAppointments, sentiment, hasSummary, needsFollowUp, direction]);

  const hasActiveCallFilters = useMemo(() => {
    const caller = callerSearch.trim();
    return (
      status !== "all" ||
      datePreset !== "7" ||
      hasAppointments ||
      sentiment !== "all" ||
      hasSummary !== "all" ||
      needsFollowUp ||
      direction !== "all" ||
      !!caller
    );
  }, [status, datePreset, hasAppointments, sentiment, hasSummary, needsFollowUp, direction, callerSearch]);

  const fetchAnalytics = useCallback(() => {
    if (!businessId) return;
    api.get(`/api/analytics/${businessId}`)
      .then((res) => { setAnalytics(res.data); setAnalyticsError(null); })
      .catch((err) => {
        console.error(err);
        setAnalyticsError(err?.response?.data?.error || err?.message || "Failed to load analytics");
      });
  }, [businessId]);

  useEffect(() => {
    if (!businessId) return;
    fetchAnalytics();
    const ti = setInterval(fetchAnalytics, 15000);
    return () => clearInterval(ti);
  }, [businessId, fetchAnalytics]);

  useEffect(() => {
    if (!businessId || activePage !== "analytics") return;
    setAnalyticsBreakdown(null);
    api.get("/api/analytics-breakdown", { params: { period: analyticsPeriod } })
      .then((res) => setAnalyticsBreakdown(res.data))
      .catch((err) => {
        console.error(err);
      });
  }, [businessId, activePage, analyticsPeriod]);

  useEffect(() => {
    if (!businessId || activePage !== "appointments") return;
    setAppointmentsLoading(true);
    setAppointmentsError(null);
    api.get("/api/appointments", { params: { range: appointmentsRange } })
      .then((res) => { setAppointmentsList(Array.isArray(res.data) ? res.data : []); })
      .catch((err) => {
        setAppointmentsError(err?.response?.data?.error || err?.message || "Failed to load appointments");
        setAppointmentsList([]);
      })
      .finally(() => setAppointmentsLoading(false));
  }, [businessId, activePage, appointmentsRange]);

  const fetchCalls = useCallback((opts = {}) => {
    if (!businessId) return Promise.resolve();
    const { append = false, offset: optOffset } = opts;
    if (!append) {
      setCallsLoading(true);
      setCallsError(null);
      setCalls([]);
    }
    const params = { ...callsQueryParams, limit: 200, offset: append ? (optOffset ?? 0) : 0 };
    return api.get(`/api/calls`, { params })
      .then((res) => {
        const data = res.data?.calls != null ? res.data : { calls: res.data, total: res.data?.length };
        const list = Array.isArray(data.calls) ? data.calls : [];
        const total = data.total != null ? data.total : list.length;
        if (append) {
          setCalls((prev) => [...prev, ...list]);
          setCallsTotal((prev) => (prev != null ? prev : total));
        } else {
          setCalls(list);
          setCallsTotal(total);
          const sid = selectedCallIdRef.current;
          if (sid && !list.some((c) => c.id === sid)) {
            setSelectedCallId(null); setCallDetails(null); setCallDetailsError(null);
          }
        }
      })
      .catch((err) => {
        console.error(err);
        setCallsError(err?.response?.data?.error || err?.message || "Failed to load calls");
      })
      .finally(() => {
        setCallsLoading(false);
        setCallsLoadingMore(false);
      });
  }, [businessId, callsQueryParams]);

  const loadMoreCalls = () => {
    if (callsLoadingMore || callsLoading || (callsTotal != null && calls.length >= callsTotal)) return;
    setCallsLoadingMore(true);
    fetchCalls({ append: true, offset: calls.length });
  };

  const refreshDashboard = () => {
    fetchAnalytics();
    if (activePage === "dashboard") fetchCalls();
  };

  const loadCallDetails = (id) => {
    if (!businessId) return;
    setSelectedCallId(id); setCallDetailsLoading(true); setCallDetailsError(null);
    api.get(`/api/calls/${id}`)
      .then((res) => setCallDetails(res.data))
      .catch((err) => {
        console.error(err); setCallDetails(null);
        setCallDetailsError(err?.response?.data?.error || err?.message || "Failed to load call details");
      })
      .finally(() => setCallDetailsLoading(false));
  };

  useEffect(() => {
    if (!businessId || activePage !== "dashboard") return;
    fetchCalls();
  }, [businessId, activePage, fetchCalls]);

  useEffect(() => {
    if (activePage !== "dashboard") return;
    if (selectedCallId || !calls.length) return;
    const first = calls[0];
    if (first?.id) {
      loadCallDetails(first.id);
    }
  }, [activePage, selectedCallId, calls]);

  const emailAppointments = async (range) => {
    if (!businessId) return;
    const to = business?.notification_email;
    if (!to) {
      setToast({ type: "error", message: "Add a notification email in Settings first." });
      setTimeout(() => setToast(null), 2200);
      return;
    }
    try {
      await api.post("/api/appointments/email", { range });
      // The email is a nudge with a count and a link, not the list: bodies carry
      // no patient information (A1.3), so the copy must not promise one.
      setToast({ type: "success", message: `Sent a reminder to ${to}. Details stay here in the dashboard.` });
      setTimeout(() => setToast(null), 2200);
    } catch (err) {
      console.error(err);
      setToast({ type: "error", message: "Failed to send appointments email. Please try again." });
      setTimeout(() => setToast(null), 2200);
    }
  };

  const goToPage = (page) => {
    if (activePage === "settings" && settingsDirty && !window.confirm(t.unsavedChanges)) return;
    setActivePage(page);
  };

  const resetFilters = () => {
    setStatus("all"); setCallerSearch(""); setDatePreset("7");
    const d = new Date(); const from = new Date();
    from.setDate(d.getDate() - 7);
    setFromDate(formatDateYYYYMMDD(from)); setToDate(formatDateYYYYMMDD(d));
    setHasAppointments(false); setSentiment("all"); setHasSummary("all"); setNeedsFollowUp(false); setDirection("all");
  };

  return (
    <div className="dashboard-page">
      <div className="dashboard-shell">
        <header className="dashboard-topbar">
          <div className="dashboard-topbar-left">
            <div className="dashboard-badge">
              {t.appTitle}
            </div>
            <h1 className="dashboard-business-name">{business?.name ?? t.appTitle}</h1>
            <p className="dashboard-context-line">
              {t.dashboardOverview}
            </p>
            {business ? (
              <div className="dashboard-business-meta">
                <span className="dashboard-meta-pill">{business.phone_number || "No phone number"}</span>
                <span className="dashboard-meta-pill">{business.timezone || "No timezone"}</span>
              </div>
            ) : null}
          </div>

          <div className="dashboard-topbar-right" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            {/* ── Nav tabs ── */}
            <div className="nav-tabs" ref={navTabsRef}>
              {navHighlight.width > 0 && (
                <div
                  className="nav-tab-highlight"
                  style={{
                    width: navHighlight.width,
                    transform: `translateX(${navHighlight.left}px)`,
                  }}
                />
              )}
              <button
                className={`nav-tab ${activePage === "dashboard" ? "is-active" : ""}`}
                data-tab="dashboard"
                onClick={() => goToPage("dashboard")}
              >
                {t.navDashboard}
              </button>
              <button
                className={`nav-tab ${activePage === "analytics" ? "is-active" : ""}`}
                data-tab="analytics"
                onClick={() => goToPage("analytics")}
              >
                {t.navAnalytics}
              </button>
              <button
                className={`nav-tab ${activePage === "appointments" ? "is-active" : ""}`}
                data-tab="appointments"
                onClick={() => goToPage("appointments")}
              >
                {t.navAppointments}
              </button>
              <button
                className={`nav-tab ${activePage === "settings" ? "is-active" : ""}`}
                data-tab="settings"
                onClick={() => setActivePage("settings")}
              >
                {t.navSettings}
              </button>
              <button
                className={`nav-tab ${activePage === "guide" ? "is-active" : ""}`}
                data-tab="guide"
                onClick={() => goToPage("guide")}
              >
                {t.navGuide}
              </button>
            </div>

            <button
              className="dashboard-logout"
              onClick={async () => { await signOut(); window.location.reload(); }}
            >
              {t.logout}
            </button>
          </div>
        </header>

        <main className={`dashboard-content page-${activePage}`}>
        {activePage === "dashboard" ? (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
              <p className="dashboard-today-label" style={{ margin: 0 }} aria-hidden="true">
                {t.dataForToday} {new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
              </p>
              <button
                type="button"
                className="dashboard-logout"
                style={{ fontSize: 13, height: 32, padding: "0 12px" }}
                onClick={refreshDashboard}
                title={t.refresh}
              >
                {t.refresh}
              </button>
            </div>
            <section className="dashboard-kpis" style={{ alignItems: "stretch", gap: 12 }}>
              {analytics ? (
                <>
                  <div className="kpi-card">
                    <div className="kpi-label">{t.callsToday}</div>
                    <div className="kpi-value">
                      <AnimatedNumber value={analytics.calls_today ?? 0} duration={900} />
                    </div>
                  </div>
                  <div className="kpi-card">
                    <div className="kpi-label">{t.appointmentsToday}</div>
                    <div className="kpi-value">
                      <AnimatedNumber value={analytics.appointments_today ?? 0} duration={900} />
                    </div>
                  </div>
                  <div className="kpi-card">
                    <div className="kpi-label">{t.followUpsNeeded}</div>
                    <div className="kpi-value">
                      <AnimatedNumber value={analytics.followups_needed ?? 0} duration={900} />
                    </div>
                  </div>
                  <div className="kpi-card">
                    <div className="kpi-label">{t.transferredToHuman}</div>
                    <div className="kpi-value">
                      <AnimatedNumber value={analytics.transferred_today ?? 0} duration={900} />
                    </div>
                  </div>
                </>
              ) : !analyticsError ? (
                <>
                  <div className="kpi-card kpi-card-skeleton">
                    <div className="kpi-label">{t.callsToday}</div>
                    <div className="kpi-value kpi-skeleton" />
                  </div>
                  <div className="kpi-card kpi-card-skeleton">
                    <div className="kpi-label">{t.appointmentsToday}</div>
                    <div className="kpi-value kpi-skeleton" />
                  </div>
                  <div className="kpi-card kpi-card-skeleton">
                    <div className="kpi-label">{t.followUpsNeeded}</div>
                    <div className="kpi-value kpi-skeleton" />
                  </div>
                  <div className="kpi-card kpi-card-skeleton">
                    <div className="kpi-label">{t.transferredToHuman}</div>
                    <div className="kpi-value kpi-skeleton" />
                  </div>
                </>
              ) : analyticsError ? (
                <div className="kpi-card" style={{ gridColumn: "1 / -1" }}>
                  <div className="kpi-label">Analytics</div>
                  <div className="empty-note">{analyticsError}</div>
                </div>
              ) : null}
            </section>
            {analyticsError && !analytics ? null : null}

            {!analytics && analyticsError ? (
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
                  <p className="panel-section-label">Activity</p>
                  <h2 className="panel-title">{t.calls}</h2>
                </div>
                <div className="panel-body">
                  <div className="filters-grid">
                    <div className="filter-row-2">
                      <div className="filter-field">
                        <label>{t.filterStatus}</label>
                        <select value={status} onChange={(e) => setStatus(e.target.value)}>
                          <option value="all">{t.filterAll}</option>
                          <option value="completed">{t.filterCompleted}</option>
                          <option value="transferred">{t.filterTransferred}</option>
                          <option value="in-progress">{t.filterInProgress}</option>
                          <option value="failed">{t.filterFailed}</option>
                          <option value="no-answer">{t.filterNoAnswer}</option>
                          <option value="busy">{t.filterBusy}</option>
                        </select>
                      </div>
                      <div className="filter-field">
                        <label>{t.filterDateRange}</label>
                        <select value={datePreset} onChange={(e) => setDatePreset(e.target.value)}>
                          <option value="1">{t.filterLast24h}</option>
                          <option value="7">{t.filterLast7}</option>
                          <option value="30">{t.filterLast30}</option>
                          <option value="custom">{t.filterCustom}</option>
                        </select>
                      </div>
                    </div>

                    {datePreset === "custom" ? (
                      <div className="filter-row-2">
                        <div className="filter-field">
                          <label>{t.filterFrom}</label>
                          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
                        </div>
                        <div className="filter-field">
                          <label>{t.filterTo}</label>
                          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
                        </div>
                      </div>
                    ) : null}

                    <div className="filter-row-2">
                      <div className="filter-field">
                        <label>{t.filterSentiment}</label>
                        <select value={sentiment} onChange={(e) => setSentiment(e.target.value)}>
                          <option value="all">{t.filterAll}</option>
                          <option value="positive">{t.filterPositive}</option>
                          <option value="neutral">{t.filterNeutral}</option>
                          <option value="negative">{t.filterNegative}</option>
                          <option value="unknown">{t.filterUnknown}</option>
                        </select>
                      </div>
                      <div className="filter-field">
                        <label>{t.filterSummary}</label>
                        <select value={hasSummary} onChange={(e) => setHasSummary(e.target.value)}>
                          <option value="all">{t.filterAll}</option>
                          <option value="true">{t.filterHasSummary}</option>
                          <option value="false">{t.filterNoSummary}</option>
                        </select>
                      </div>
                    </div>

                    <div className="filter-field">
                      <label>{t.filterDirection}</label>
                      <select value={direction} onChange={(e) => setDirection(e.target.value)}>
                        <option value="all">{t.filterAll}</option>
                        <option value="inbound">{t.filterInbound}</option>
                        <option value="outbound">{t.filterOutbound}</option>
                      </select>
                    </div>

                    <div className="filter-field">
                      <label>{t.filterCallerSearch}</label>
                      <input value={callerSearch} onChange={(e) => setCallerSearch(e.target.value)} placeholder={t.filterCallerPlaceholder} />
                    </div>

                    <div className="checkbox-list">
                      <label className="checkbox-item">
                        <input type="checkbox" checked={hasAppointments} onChange={(e) => setHasAppointments(e.target.checked)} />
                        <span>{t.filterOnlyAppointments}</span>
                      </label>
                      <label className="checkbox-item">
                        <input type="checkbox" checked={needsFollowUp} onChange={(e) => setNeedsFollowUp(e.target.checked)} />
                        <span>{t.filterNeedsFollowUp}</span>
                      </label>
                    </div>
                  </div>

                  <div className="calls-toolbar">
                    <span>
                      {callsLoading ? t.loadingCalls : t.showingCalls(calls.length, callsTotal ?? undefined)}
                    </span>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className="reset-button"
                        onClick={() => emailAppointments("upcoming")}
                      >
                        Email me a reminder
                      </button>
                      <button
                        type="button"
                        className="reset-button"
                        onClick={() => {
                          const csv = buildCallsCsv(calls);
                          if (csv) {
                            downloadCsv(csv, `calls-${formatDateYYYYMMDD(new Date())}.csv`);
                            setToast({ type: "success", message: t.exportedCallsCsv });
                            setTimeout(() => setToast(null), 2200);
                          }
                        }}
                        disabled={!calls.length}
                      >
                        {t.exportCallsCsv}
                      </button>
                      <button className="reset-button" onClick={resetFilters}>{t.reset}</button>
                    </div>
                  </div>

                  <div className="calls-list">
                    {callsLoading ? (
                      <div className="empty-note">{t.loadingCallsEllipsis}</div>
                    ) : callsError ? (
                      <div className="empty-note">{callsError}</div>
                    ) : !calls.length ? (
                      <div className="empty-note">{hasActiveCallFilters ? t.noCallsMatch : t.noCallsYet}</div>
                    ) : (
                      calls.map((call) => (
                        <div
                          key={call.id}
                          onClick={() => loadCallDetails(call.id)}
                          className={`call-card ${selectedCallId === call.id ? "is-active" : ""}`}
                        >
                          <div className="call-card-top">
                            <div className="call-number" style={{ fontSize: 18, marginBottom: 0 }}>{call.caller_name_guess || call.caller_number}</div>
                          </div>
                          <div className="call-date">{call.started_at ? new Date(call.started_at).toLocaleString() : ""}</div>
                          <div className="call-meta" style={{ marginTop: 12 }}>
                            <span style={getStatusPillStyle(call.inferred_transferred ? "transferred" : call.status)}>
                              {call.inferred_transferred ? "Transferred" : (call.status || "")}
                            </span>
                            {call.direction === "outbound" ? <span className="call-pill">{t.directionOutbound}</span> : null}
                            {call.outcome_code ? <span className="call-pill">{humanise(call.outcome_code)}</span> : null}
                            <span className="call-pill">{call.duration_seconds ?? "-"}s</span>
                            <span style={getSentimentPillStyle(call.sentiment)}>{call.sentiment ?? t.filterUnknown}</span>
                            <span className="call-pill">{call.summary ? t.summaryCheck : t.noSummaryShort}</span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                  {!callsLoading && calls.length > 0 && callsTotal != null && calls.length < callsTotal && (
                    <div style={{ marginTop: 12, textAlign: "center" }}>
                      <button type="button" className="reset-button" onClick={loadMoreCalls} disabled={callsLoadingMore}>
                        {callsLoadingMore ? "…" : t.loadMore}
                      </button>
                    </div>
                  )}
                </div>
              </aside>

              <section className="panel">
                <div className="panel-header">
                  <p className="panel-section-label">Details</p>
                  <h2 className="panel-title">{t.callDetails}</h2>
                </div>
                <div className="panel-body">
                  {callDetailsLoading ? (
                    <div className="details-empty">
                      <div className="details-spinner" aria-hidden="true" />
                      <div>{t.loadingCallDetails}</div>
                    </div>
                  ) : callDetailsError ? (
                    <div className="details-empty">{callDetailsError}</div>
                  ) : !callDetails ? (
                    <div className="details-empty">{calls.length ? t.selectCallPrompt : t.noCallsYetDetails}</div>
                  ) : (
                    <div className="details-stack">
                      <div className="detail-card">
                        <h3 className="detail-card-title">{t.callInfo}</h3>
                        <div className="info-grid">
                          <div className="info-label">{t.infoStatus}</div>
                          <div className="info-value">{callDetails.call.inferred_transferred ? "Transferred" : (callDetails.call.status || "")}</div>
                          <div className="info-label">{t.infoDirection}</div>
                          <div className="info-value">{callDetails.call.direction === "outbound" ? t.directionOutbound : t.directionInbound}</div>
                          <div className="info-label">{t.infoDuration}</div>
                          <div className="info-value">{callDetails.call.duration_seconds ?? "-"} {t.sec}</div>
                          <div className="info-label">{t.infoStarted}</div>
                          <div className="info-value">{callDetails.call.started_at ? new Date(callDetails.call.started_at).toLocaleString() : "-"}</div>
                          <div className="info-label">{t.infoSummary}</div>
                          <div className="info-value" style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
                            <span style={{ flex: "1 1 auto", minWidth: 0 }}>{callDetails.call.summary ?? t.noSummaryYet}</span>
                            <button type="button" className="reset-button" style={{ flexShrink: 0, fontSize: 12 }} onClick={() => { const s = callDetails.call?.summary || ""; if (s) { navigator.clipboard.writeText(s); setCopyFeedback("summary"); setTimeout(() => setCopyFeedback(null), 2000); } }}>{copyFeedback === "summary" ? t.copied : t.copySummary}</button>
                          </div>
                          <div className="info-label">{t.infoSentiment}</div>
                          <div className="info-value">{callDetails.call.sentiment ?? t.unknownSentiment}</div>
                        </div>
                      </div>

                      <CallOutcomeAnswers call={callDetails.call} t={t} />

                      <div className="detail-card">
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                          <h3 className="detail-card-title" style={{ margin: 0 }}>{t.transcript}</h3>
                          {callDetails.transcript?.length ? (
                            <button type="button" className="reset-button" style={{ fontSize: 12 }} onClick={() => { const text = callDetails.transcript.map((l) => `${l.speaker === "ai" ? t.aiReceptionist : t.caller}: ${l.message}`).join("\n"); navigator.clipboard.writeText(text); setCopyFeedback("transcript"); setTimeout(() => setCopyFeedback(null), 2000); }}>{copyFeedback === "transcript" ? t.copied : t.copyTranscript}</button>
                          ) : null}
                        </div>
                        {callDetails.transcript?.length ? (
                          <div style={{ maxHeight: 420, overflowY: "auto", paddingRight: 6 }}>
                            <div className="transcript-list">
                              {callDetails.transcript.map((line) => {
                                const isAi = line.speaker === "ai";
                                return (
                                  <div key={line.id} className={`transcript-row ${isAi ? "ai" : "caller"}`}>
                                    <div className={`transcript-bubble ${isAi ? "ai" : "caller"}`}>
                                      <div className="transcript-speaker">{isAi ? t.aiReceptionist : t.caller}</div>
                                      <div className="transcript-message">{line.message}</div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ) : (
                          <div className="empty-note">{t.noTranscript}</div>
                        )}
                      </div>

                      <div className="detail-card">
                        <h3 className="detail-card-title">{t.appointments}</h3>
                        {callDetails.appointments?.length ? (
                          <div className="sub-card-stack">
                            {callDetails.appointments.map((appt) => (
                              <div key={appt.id} className="sub-card">
                                <div className="sub-card-title">{appt.client_name} — {appt.client_phone}</div>
                                <div className="detail-block-text"><b>{t.scheduled}:</b> {appt.scheduled_at ? new Date(appt.scheduled_at).toLocaleString() : "-"}</div>
                                <div className="detail-block-text"><b>{t.status}:</b> {appt.status}</div>
                                {appt.notes ? <div className="detail-block-text"><b>{t.notes}:</b> {appt.notes}</div> : null}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="empty-note">{t.noAppointments}</div>
                        )}
                      </div>

                      <div className="detail-card">
                        <h3 className="detail-card-title">{t.customerRequests}</h3>
                        {callDetails.customer_requests?.length ? (
                          <div className="sub-card-stack">
                            {callDetails.customer_requests.map((r) => (
                              <div key={r.id} className="sub-card">
                                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
                                  <span style={badgeStyle(r.request_type)}>{r.request_type}</span>
                                  <div style={{ fontWeight: 700 }}>
                                    {r.caller_name || t.unknown}{" "}
                                    <span style={{ opacity: 0.7, fontWeight: 400 }}>— {r.callback_number || ""}</span>
                                  </div>
                                </div>
                                {r.message ? <div className="detail-block-text" style={{ whiteSpace: "pre-wrap" }}>{r.message}</div> : null}
                                <div style={{ fontSize: 12, opacity: 0.6, marginTop: 8 }}>
                                  {r.created_at ? new Date(r.created_at).toLocaleString() : ""}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="empty-note">{t.noRequests}</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </section>
            </section>
          </>
        ) : activePage === "appointments" ? (
          <section className="appointments-page">
            <div className="appointments-page-header">
              <h2 className="appointments-page-title">{t.appointmentsPageTitle}</h2>
              <div className="appointments-range-tabs">
                {["today", "7days", "upcoming"].map((r) => (
                  <button
                    key={r}
                    type="button"
                    className={`appointments-range-tab ${appointmentsRange === r ? "is-active" : ""}`}
                    onClick={() => setAppointmentsRange(r)}
                  >
                    {r === "today" ? t.appointmentsRangeToday : r === "7days" ? t.appointmentsRange7Days : t.appointmentsRangeUpcoming}
                  </button>
                ))}
              </div>
            </div>
            {appointmentsLoading ? (
              <div className="appointments-loading">{t.loadingCalls}</div>
            ) : appointmentsError ? (
              <div className="appointments-error">{appointmentsError}</div>
            ) : !appointmentsList?.length ? (
              <div className="appointments-empty">{t.noAppointmentsInRange}</div>
            ) : (
              <div className="appointments-list">
                {appointmentsList.map((appt) => (
                  <div key={appt.id} className="appointment-card">
                    <div className="appointment-card-main">
                      <div className="appointment-card-time">
                        {appt.scheduled_at ? new Date(appt.scheduled_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—"}
                      </div>
                      <div className="appointment-card-client">
                        <strong>{appt.client_name || t.caller}</strong>
                        {appt.client_phone ? <span className="appointment-card-phone">{appt.client_phone}</span> : null}
                      </div>
                      <div className="appointment-card-meta">
                        <span style={badgeStyle("appointment")}>{appt.status || "scheduled"}</span>
                        {appt.notes ? <span className="appointment-card-notes">{appt.notes}</span> : null}
                      </div>
                    </div>
                    {appt.call_id ? (
                      <button
                        type="button"
                        className="appointment-view-call"
                        onClick={() => {
                          setSelectedCallId(appt.call_id);
                          setActivePage("dashboard");
                          fetchCalls();
                          loadCallDetails(appt.call_id);
                        }}
                      >
                        {t.viewCall}
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : activePage === "analytics" ? (
          <section className="analytics-page">
            <div className="analytics-page-header">
              <div className="analytics-page-title-row">
                <h2 className="analytics-page-title">Call analytics</h2>
                <AnalyticsPeriodSelect
                  value={analyticsPeriod}
                  onChange={setAnalyticsPeriod}
                />
              </div>
              <p className="analytics-page-subtitle">Trends and totals for your receptionist calls</p>
            </div>

            {!analyticsBreakdown ? (
              <>
                <section className="analytics-overview">
                  <h3 className="analytics-section-label">Overview</h3>
                  <div className="dashboard-kpis analytics-kpis">
                    <div className="kpi-card kpi-card-skeleton"><div className="kpi-label">Receptionist calls</div><div className="kpi-value kpi-skeleton" /></div>
                    <div className="kpi-card kpi-card-skeleton"><div className="kpi-label">Appointments scheduled</div><div className="kpi-value kpi-skeleton" /></div>
                    <div className="kpi-card kpi-card-skeleton"><div className="kpi-label">Follow-ups needed</div><div className="kpi-value kpi-skeleton" /></div>
                    <div className="kpi-card kpi-card-skeleton"><div className="kpi-label">Positive calls</div><div className="kpi-value kpi-skeleton" /></div>
                    <div className="kpi-card kpi-card-skeleton"><div className="kpi-label">Calls → appointments</div><div className="kpi-value kpi-skeleton" /></div>
                  </div>
                </section>
                <section className="analytics-charts">
                  <div className="panel analytics-chart-panel">
                    <div className="panel-header">
                      <h3 className="panel-title">{analyticsPeriod === "7d" ? "Calls this week" : analyticsPeriod === "30d" ? "Calls by week" : "Calls last 3 months"}</h3>
                    </div>
                    <div className="panel-body"><div className="empty-note">{t.loadingAnalytics}</div></div>
                  </div>
                  <div className="panel analytics-chart-panel">
                    <div className="panel-header"><h3 className="panel-title">Actions taken</h3></div>
                    <div className="panel-body"><div className="empty-note">{t.loadingAnalytics}</div></div>
                  </div>
                </section>
                <section className="analytics-charts analytics-charts-second-row">
                  <div className="panel analytics-chart-panel">
                    <div className="panel-header"><h3 className="panel-title">Calls by day of week</h3></div>
                    <div className="panel-body"><div className="empty-note">{t.loadingAnalytics}</div></div>
                  </div>
                  <div className="panel analytics-chart-panel">
                    <div className="panel-header"><h3 className="panel-title">Sentiment</h3></div>
                    <div className="panel-body"><div className="empty-note">{t.loadingAnalytics}</div></div>
                  </div>
                  <div className="panel analytics-chart-panel">
                    <div className="panel-header"><h3 className="panel-title">Call outcomes</h3></div>
                    <div className="panel-body"><div className="empty-note">{t.loadingAnalytics}</div></div>
                  </div>
                </section>
              </>
            ) : (
              <>
            <section className="analytics-overview">
              <h3 className="analytics-section-label">Overview</h3>
              <div className="dashboard-kpis analytics-kpis">
                <div className="kpi-card kpi-card-orange">
                  <div className="kpi-value">
                    <AnimatedNumber value={analyticsBreakdown?.total_calls_3m ?? 0} duration={1200} />
                  </div>
                  <div className="kpi-label">Receptionist calls</div>
                </div>
                <div className="kpi-card kpi-card-green">
                  <div className="kpi-value">
                    <AnimatedNumber value={analyticsBreakdown?.actions?.appointments ?? 0} duration={1200} />
                  </div>
                  <div className="kpi-label">Appointments scheduled</div>
                </div>
                <div className="kpi-card kpi-card-blue">
                  <div className="kpi-value">
                    <AnimatedNumber value={analyticsBreakdown?.followups_needed ?? 0} duration={1200} />
                  </div>
                  <div className="kpi-label">Follow-ups needed</div>
                </div>
                <div className="kpi-card kpi-card-teal">
                  <div className="kpi-value">
                    <AnimatedNumber value={analyticsBreakdown?.positive_calls_percent ?? 0} duration={1200} suffix="%" />
                  </div>
                  <div className="kpi-label">Positive calls</div>
                </div>
                <div className="kpi-card kpi-card-purple">
                  <div className="kpi-value">
                    <AnimatedNumber value={analyticsBreakdown?.appointment_conversion_percent ?? 0} duration={1200} suffix="%" />
                  </div>
                  <div className="kpi-label">Calls → appointments</div>
                </div>
                {analyticsBreakdown?.caller_mix && (
                  <div className="kpi-card">
                    <div className="kpi-value">
                      <AnimatedNumber
                        value={Number(analyticsBreakdown.caller_mix.first_time ?? 0)}
                        duration={1200}
                      />
                    </div>
                    <div className="kpi-label">New callers this period</div>
                  </div>
                )}
              </div>
            </section>

            {analyticsBreakdown?.caller_mix && (
              <section className="panel analytics-insights">
                <div className="panel-body analytics-insights-body">
                  {(() => {
                    const mix = analyticsBreakdown.caller_mix || {};
                    const first = Number(mix.first_time ?? 0);
                    const returning = Number(mix.returning ?? 0);
                    const total = first + returning;
                    const firstPct = total > 0 ? Math.round((first / total) * 100) : 0;
                    const returningPct = total > 0 ? 100 - firstPct : 0;
                    const peak = analyticsBreakdown.peak_hour;
                    const bh = analyticsBreakdown.business_hours;
                    const lines = [];
                    lines.push(`${firstPct}% first-time callers, ${returningPct}% returning`);
                    if (peak && typeof peak.hour === "number") {
                      const h = peak.hour;
                      const pad = (n) => String(n).padStart(2, "0");
                      const next = (h + 1) % 24;
                      lines.push(`Peak hour this period: ${pad(h)}:00–${pad(next)}:00`);
                    }
                    if (bh) {
                      const inHours = Number(bh.in_hours ?? 0);
                      const outHours = Number(bh.out_hours ?? 0);
                      const totalBh = inHours + outHours;
                      if (totalBh > 0) {
                        const outPct = Math.round((outHours / totalBh) * 100);
                        const tzLabel = bh.timezone || (business?.timezone || "");
                        lines.push(
                          `${outPct}% of calls came outside typical hours (09:00–17:00${tzLabel ? `, ${tzLabel}` : ""})`
                        );
                      }
                    }
                    return (
                      <>
                        <p className="analytics-insights-title">Insights for this period</p>
                        <ul className="analytics-insights-list">
                          {lines.map((text) => (
                            <li key={text}>{text}</li>
                          ))}
                        </ul>
                      </>
                    );
                  })()}
                </div>
              </section>
            )}

            <section className="analytics-charts">
              <div className="panel analytics-chart-panel">
                <div className="panel-header">
                  <h3 className="panel-title">
                    {analyticsPeriod === "7d" ? "Calls this week" : analyticsPeriod === "30d" ? "Calls by week" : "Calls last 3 months"}
                  </h3>
                </div>
                <div className="panel-body">
                  {analyticsBreakdown?.calls_by_month?.length ? (
                    <div className="calls-chart">
                      {(() => {
                        const chartHeightPx = 160;
                        const buckets = analyticsBreakdown.calls_by_month;
                        const max = Math.max(...buckets.map((b) => Number(b.total_calls) || 0), 1);
                        return buckets.map((b) => {
                          const count = Number(b.total_calls) || 0;
                          const pct = max > 0 ? count / max : 0;
                          const barPx = Math.max(Math.round(pct * chartHeightPx), 12);
                          return (
                            <div key={b.month_label} className="calls-chart-column">
                              <div
                                className="calls-chart-bar-wrap"
                                style={{ height: `${barPx}px` }}
                              >
                                <div
                                  className="calls-chart-bar"
                                  title={`${count} calls`}
                                />
                              </div>
                              <div className="calls-chart-label">{b.month_label || b.bucket_label}</div>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  ) : (
                    <div className="empty-note">
                      No call data for {analyticsPeriod === "7d" ? "the last 7 days" : analyticsPeriod === "30d" ? "the last 30 days" : "the last 3 months"}.
                    </div>
                  )}
                </div>
              </div>
              <div className="panel analytics-chart-panel">
                <div className="panel-header">
                  <h3 className="panel-title">Actions taken</h3>
                </div>
                <div className="panel-body">
                  <div className="actions-summary">
                    <div className="actions-row">
                      <span className="actions-dot actions-dot-appointments" />
                      <span>Appointment scheduled</span>
                      <span className="actions-count">{analyticsBreakdown?.actions?.appointments ?? 0}</span>
                    </div>
                    <div className="actions-row">
                      <span className="actions-dot actions-dot-callbacks" />
                      <span>Callback requested</span>
                      <span className="actions-count">{analyticsBreakdown?.actions?.callbacks ?? 0}</span>
                    </div>
                    <div className="actions-row">
                      <span className="actions-dot actions-dot-messages" />
                      <span>Message taken</span>
                      <span className="actions-count">{analyticsBreakdown?.actions?.messages ?? 0}</span>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section className="analytics-charts analytics-charts-second-row">
              <div className="panel analytics-chart-panel">
                <div className="panel-header">
                  <h3 className="panel-title">Calls by day of week</h3>
                </div>
                <div className="panel-body">
                  {analyticsBreakdown?.calls_by_weekday?.length ? (
                    <div className="calls-chart calls-chart-weekday">
                      {analyticsBreakdown.calls_by_weekday.map((d) => {
                        const count = Number(d.total_calls) || 0;
                        const max = Math.max(...analyticsBreakdown.calls_by_weekday.map((x) => Number(x.total_calls) || 0), 1);
                        const chartHeightPx = 100;
                        const barPx = Math.max(Math.round((count / max) * chartHeightPx), 8);
                        return (
                          <div key={d.day_name} className="calls-chart-column">
                            <div className="calls-chart-bar-wrap" style={{ height: `${barPx}px` }}>
                              <div className="calls-chart-bar" title={`${count} calls`} />
                            </div>
                            <div className="calls-chart-label">{d.day_name}</div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="empty-note">No call data for this period.</div>
                  )}
                </div>
              </div>
              <div className="panel analytics-chart-panel">
                <div className="panel-header">
                  <h3 className="panel-title">Sentiment</h3>
                </div>
                <div className="panel-body">
                  <div className="sentiment-summary">
                    <div className="sentiment-row sentiment-positive">
                      <span className="sentiment-dot" />
                      <span>Positive</span>
                      <span className="sentiment-count">{analyticsBreakdown?.sentiment_counts?.positive ?? 0}</span>
                    </div>
                    <div className="sentiment-row sentiment-neutral">
                      <span className="sentiment-dot" />
                      <span>Neutral</span>
                      <span className="sentiment-count">{analyticsBreakdown?.sentiment_counts?.neutral ?? 0}</span>
                    </div>
                    <div className="sentiment-row sentiment-negative">
                      <span className="sentiment-dot" />
                      <span>Negative</span>
                      <span className="sentiment-count">{analyticsBreakdown?.sentiment_counts?.negative ?? 0}</span>
                    </div>
                    <div className="sentiment-row sentiment-unknown">
                      <span className="sentiment-dot" />
                      <span>Unknown</span>
                      <span className="sentiment-count">{analyticsBreakdown?.sentiment_counts?.unknown ?? 0}</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="panel analytics-chart-panel">
                <div className="panel-header">
                  <h3 className="panel-title">Call outcomes</h3>
                </div>
                <div className="panel-body">
                  {(() => {
                    const sc = analyticsBreakdown?.status_counts || {};
                    const completed = Number(sc.completed ?? 0);
                    const transferred = Number(sc.transferred ?? 0);
                    const failed = Number(sc.failed ?? 0);
                    const noAnswer = Number(sc.no_answer ?? 0);
                    const busy = Number(sc.busy ?? 0);
                    const inProgress = Number(sc.in_progress ?? 0);
                    const total = completed + transferred + failed + noAnswer + busy + inProgress;
                    const answerRate = total > 0 ? Math.round((completed / total) * 100) : 0;
                    return (
                      <>
                        <div className="outcome-rate">
                          <span className="outcome-rate-value">{answerRate}%</span>
                          <span className="outcome-rate-label">answered / completed</span>
                        </div>
                        <div className="outcomes-list">
                          <div className="outcome-row outcome-completed">
                            <span className="outcome-dot" />
                            <span>Completed</span>
                            <span className="outcome-count">{completed}</span>
                          </div>
                          <div className="outcome-row outcome-transferred">
                            <span className="outcome-dot" />
                            <span>Transferred</span>
                            <span className="outcome-count">{transferred}</span>
                          </div>
                          <div className="outcome-row outcome-missed">
                            <span className="outcome-dot" />
                            <span>Failed</span>
                            <span className="outcome-count">{failed}</span>
                          </div>
                          <div className="outcome-row outcome-missed">
                            <span className="outcome-dot" />
                            <span>No answer</span>
                            <span className="outcome-count">{noAnswer}</span>
                          </div>
                          <div className="outcome-row outcome-missed">
                            <span className="outcome-dot" />
                            <span>Busy</span>
                            <span className="outcome-count">{busy}</span>
                          </div>
                          {inProgress > 0 && (
                            <div className="outcome-row outcome-pending">
                              <span className="outcome-dot" />
                              <span>In progress</span>
                              <span className="outcome-count">{inProgress}</span>
                            </div>
                          )}
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>
            </section>
              </>
            )}
          </section>
        ) : activePage === "settings" ? (
          // Usage and billing used to be hand-rolled panels here, above and
          // below SettingsPage, in the old .panel visual language. They now live
          // inside the settings group rail as AccountSection — the data and
          // these handlers still belong to App.jsx and are passed down.
          <SettingsPage
            business={business}
            businessId={businessId}
            onBusinessUpdate={(updated) => setBusiness((prev) => ({ ...(prev || {}), ...updated }))}
            onDirtyChange={setSettingsDirty}
            usage={usage}
            usageLoading={usageLoading}
            usageError={usageError}
          />
        ) : (
          <section className="guide-page">
            <section className="panel guide-intro-panel">
              <div className="panel-header">
                <h2 className="panel-title">How Vetra works</h2>
              </div>
              <div className="panel-body guide-panel-body">
                <p>
                  This dashboard shows everything Vetra is handling for your business — from incoming calls and written summaries to appointments and follow-ups.
                  Share this page with your team so everyone understands how calls are being handled.
                </p>
              </div>
            </section>

            <section className="panel">
              <div className="panel-header"><h2 className="panel-title">1. Getting set up</h2></div>
              <div className="panel-body guide-panel-body">
                <ol className="guide-list">
                  <li><strong>Create your business</strong> – complete the onboarding form with your name, timezone, language, greeting, and call-handling rules.</li>
                  <li><strong>Choose a phone number</strong> – buy a local or toll-free number for Vetra to answer.</li>
                  <li><strong>Configure settings</strong> – review transfer rules, notification email/phone, and emergency/fallback messages under <strong>Settings</strong>.</li>
                  <li><strong>Make a test call</strong> – call your new number from your own phone to hear the greeting and see a test call appear in the dashboard.</li>
                </ol>
              </div>
            </section>

            <section className="panel">
              <div className="panel-header"><h2 className="panel-title">2. What callers experience</h2></div>
              <div className="panel-body guide-panel-body">
                <p style={{ margin: 0 }}>
                  The typical call flow looks like this:
                </p>
                <ul className="guide-list guide-list-tight">
                  <li><strong>Caller dials your number</strong> – shown at the top of the dashboard.</li>
                  <li><strong>Vetra answers</strong> – uses your greeting, language, and business info to talk naturally.</li>
                  <li><strong>During the call</strong> – we can book appointments, take messages, collect callback details, and follow your transfer rules.</li>
                  <li><strong>After the call</strong> – the written summary and any requests appear instantly in the dashboard.</li>
                </ul>
              </div>
            </section>

            <section className="panel">
              <div className="panel-header"><h2 className="panel-title">3. What happens after a call</h2></div>
              <div className="panel-body guide-panel-body">
                <ul className="guide-list guide-list-tight">
                  <li>
                    <strong>Written summary</strong> – every call is saved with a full conversation record and a short summary so you can skim quickly.
                  </li>
                  <li>
                    <strong>Appointments</strong> – if the caller booked, Vetra creates an appointment record linked to the call.
                    You can view it in <strong>Call Details</strong> and on the <strong>Appointments</strong> tab.
                  </li>
                  <li>
                    <strong>Customer requests</strong> – messages, callback requests, and follow-up notes are stored as requests tied to the call.
                  </li>
                  <li>
                    <strong>Notifications</strong> – if your business has a notification email/phone set, Vetra sends alerts for important events
                    (appointment booked, missed call, and call completed summaries).
                  </li>
                </ul>
              </div>
            </section>

            <section className="panel">
              <div className="panel-header"><h2 className="panel-title">4. Reading the dashboard</h2></div>
              <div className="panel-body guide-panel-body">
                <ul className="guide-list guide-list-tight">
                  <li><strong>KPIs (top row)</strong> – quick snapshot of calls today, appointments today, follow-ups needed, and calls transferred to a human today.</li>
                  <li><strong>Calls list (left)</strong> – every call with status, duration, and whether a summary exists. Use filters to drill into specific days or appointment calls.</li>
                  <li><strong>Call Details (right)</strong> – full summary, sentiment, transcript, appointments, and customer requests for the selected call.</li>
                  <li><strong>Follow-ups</strong> – calls with customer requests or callbacks needed will be easy to spot using the filters and request badges.</li>
                </ul>
              </div>
            </section>

            <section className="panel">
              <div className="panel-header"><h2 className="panel-title">5. Best practices</h2></div>
              <div className="panel-body guide-panel-body">
                <ul className="guide-list guide-list-tight">
                  <li><strong>Greeting</strong> – be clear about who you are and what Vetra can help with (booking, messages, urgent calls).</li>
                  <li><strong>Transfer rules</strong> – use “Business hours only” to avoid forwarding calls to a mobile at night, and rely on message taking after hours.</li>
                  <li><strong>Notifications</strong> – set a notification email and phone so important messages and callbacks never get missed.</li>
                  <li><strong>Review calls regularly</strong> – skim summaries and requests each day to close the loop on callbacks and messages.</li>
                </ul>
              </div>
            </section>

            <section className="panel">
              <div className="panel-header"><h2 className="panel-title">6. Getting help</h2></div>
              <div className="panel-body guide-panel-body">
                <p style={{ margin: 0 }}>
                  If something doesn’t look right – or you’d like help tuning greetings, or call-handling rules – reach out to us at support@vetratd.com.
                </p>
              </div>
            </section>
          </section>
        )}
        </main>

        {toast && (
          <div className={`dashboard-toast dashboard-toast-${toast.type}`}>
            {toast.message}
          </div>
        )}

        <footer className="dashboard-footer">
          {t.securityFooter}
        </footer>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <SessionGate>
      <Dashboard />
    </SessionGate>
  );
}

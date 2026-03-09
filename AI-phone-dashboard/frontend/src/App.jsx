import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { supabase } from "./supabaseClient";
import { LanguageSwitcher, useTranslations } from "./LanguageSwitcher";

import "./Dashboard.css";

import Login from "./Login";
import Signup from "./Signup";
import Onboarding from "./Onboarding";
import ResetPassword from "./resetPassword";

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
  if (t === "callback")
    return { ...base, background: "rgba(76,129,255,0.14)", border: "1px solid rgba(76,129,255,0.28)", color: "#bcd3ff" };
  if (t === "message")
    return { ...base, background: "rgba(67,182,110,0.14)", border: "1px solid rgba(67,182,110,0.28)", color: "#bcefc9" };
  if (t === "appointment")
    return { ...base, background: "rgba(255,184,76,0.14)", border: "1px solid rgba(255,184,76,0.28)", color: "#ffe0a8" };
  return base;
}

function getStatusPillStyle(status) {
  const s = (status || "").toLowerCase();
  const base = {
    display: "inline-flex", alignItems: "center", height: 28, padding: "0 10px",
    borderRadius: 999, fontSize: 12, fontWeight: 600,
    border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.05)", color: "#dfe8f2",
  };
  if (s === "completed")
    return { ...base, background: "rgba(67,182,110,0.14)", border: "1px solid rgba(67,182,110,0.28)", color: "#bcefc9" };
  if (s === "failed" || s === "busy" || s === "no-answer")
    return { ...base, background: "rgba(255,107,107,0.14)", border: "1px solid rgba(255,107,107,0.28)", color: "#ffb9b9" };
  if (s === "in-progress")
    return { ...base, background: "rgba(76,129,255,0.14)", border: "1px solid rgba(76,129,255,0.28)", color: "#bcd3ff" };
  return base;
}

function getSentimentPillStyle(sentiment) {
  const s = (sentiment || "").toLowerCase();
  const base = {
    display: "inline-flex", alignItems: "center", height: 28, padding: "0 10px",
    borderRadius: 999, fontSize: 12, fontWeight: 600,
    border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.05)", color: "#dfe8f2",
  };
  if (s === "positive")
    return { ...base, background: "rgba(67,182,110,0.14)", border: "1px solid rgba(67,182,110,0.28)", color: "#bcefc9" };
  if (s === "negative")
    return { ...base, background: "rgba(255,107,107,0.14)", border: "1px solid rgba(255,107,107,0.28)", color: "#ffb9b9" };
  if (s === "neutral")
    return { ...base, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#d6dfeb" };
  return { ...base, background: "rgba(255,184,76,0.14)", border: "1px solid rgba(255,184,76,0.28)", color: "#ffe0a8" };
}

function formatBusinessHours(hours) {
  if (!hours) return "Mon–Fri, 9:00 AM – 5:00 PM";
  if (typeof hours === "string") return hours;
  if (hours.open_time && hours.close_time) return `${hours.open_time} - ${hours.close_time}`;
  return "Mon–Fri, 9:00 AM – 5:00 PM";
}

function LoadingScreen({ title, subtitle }) {
  return (
    <div style={{
      minHeight: "100vh",
      background: "radial-gradient(circle at top left, rgba(45,110,255,0.12), transparent 30%), radial-gradient(circle at bottom right, rgba(31,209,184,0.10), transparent 28%), #08111b",
      color: "#f4f7fb", display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
    }}>
      <div style={{
        width: "100%", maxWidth: 460, borderRadius: 24,
        border: "1px solid rgba(255,255,255,0.08)", background: "rgba(8, 14, 24, 0.82)",
        boxShadow: "0 18px 50px rgba(0, 0, 0, 0.25)", backdropFilter: "blur(10px)",
        padding: 32, textAlign: "center",
      }}>
        <div style={{
          width: 52, height: 52, margin: "0 auto 18px", borderRadius: "50%",
          border: "4px solid rgba(255,255,255,0.12)", borderTopColor: "#58a4ff",
          animation: "spin 0.8s linear infinite",
        }} />
        <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-0.03em", marginBottom: 8 }}>{title}</div>
        <div style={{ color: "#9bacbf", fontSize: 15, lineHeight: 1.6 }}>{subtitle}</div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  );
}

function App() {
  const isResetPasswordPage = window.location.pathname === "/reset-password";

  // ── Language ──────────────────────────────────────────────────────────────
  const [lang, setLang] = useState(() => localStorage.getItem("ui_lang") || "en");
  const t = useTranslations(lang);

  const handleLangChange = (code) => {
    setLang(code);
    localStorage.setItem("ui_lang", code);
  };
  // ─────────────────────────────────────────────────────────────────────────

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
    const d = new Date(); d.setDate(d.getDate() - 7); return formatDateYYYYMMDD(d);
  });
  const [toDate, setToDate] = useState(() => formatDateYYYYMMDD(new Date()));
  const [hasAppointments, setHasAppointments] = useState(false);
  const [sentiment, setSentiment] = useState("all");
  const [hasSummary, setHasSummary] = useState("all");
  const [needsFollowUp, setNeedsFollowUp] = useState(false);
  const [activePage, setActivePage] = useState("dashboard");
  const [settingsBusinessName, setSettingsBusinessName] = useState("");
  const [settingsTimezone, setSettingsTimezone] = useState("America/Chicago");
  const [settingsDefaultLanguage, setSettingsDefaultLanguage] = useState("en");
  const [settingsGreeting, setSettingsGreeting] = useState("Thank you for calling. How can I help you today?");
  const [settingsBusinessHours, setSettingsBusinessHours] = useState("Mon–Fri, 9:00 AM – 5:00 PM");
  const [settingsAfterHoursMode, setSettingsAfterHoursMode] = useState("take-message");
  const [settingsAllowAppointments, setSettingsAllowAppointments] = useState(true);
  const [settingsAllowCallbacks, setSettingsAllowCallbacks] = useState(true);
  const [settingsAllowMessages, setSettingsAllowMessages] = useState(true);
  const [settingsTransferPolicy, setSettingsTransferPolicy] = useState("business_hours_only");
  const [settingsTransferPhoneNumber, setSettingsTransferPhoneNumber] = useState("");
  const [settingsNotificationEmail, setSettingsNotificationEmail] = useState("");
  const [settingsNotificationPhone, setSettingsNotificationPhone] = useState("");
  const [settingsEmergencyMessage, setSettingsEmergencyMessage] = useState(
    "If this is a medical emergency, please hang up and call emergency services immediately."
  );
  const [settingsFallbackInstructions, setSettingsFallbackInstructions] = useState(
    "If you cannot help the caller, take a message and let them know the team will follow up."
  );
  const [settingsPlanName] = useState("Starter");
  const [settingsBillingStatus] = useState("Not connected yet");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSavedMessage, setSettingsSavedMessage] = useState("");
  const [settingsError, setSettingsError] = useState("");

  useEffect(() => {
    const boot = async () => {
      const { data } = await supabase.auth.getSession();
      setSession(data.session || null);
      setCheckingSession(false);
    };
    boot();
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession || null);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const loadMe = async () => {
      if (!session) {
        setBusiness(null); setBusinessId(null); setAnalytics(null);
        setCalls([]); setCallDetails(null); setSelectedCallId(null);
        setNeedsOnboarding(false); setMeError(null); setMeLoading(false);
        setCallsError(null); setCallDetailsError(null);
        return;
      }
      setMeLoading(true); setMeError(null);
      try {
        const res = await api.get("/api/me");
        const needs = !!res.data.needsOnboarding;
        setNeedsOnboarding(needs);
        const biz = needs ? null : res.data.business || null;
        setBusiness(biz); setBusinessId(biz?.id || null);
        if (biz) {
          setSettingsBusinessName(biz.name || "");
          setSettingsTimezone(biz.timezone || "America/Chicago");
          setSettingsDefaultLanguage(biz.default_language || "en");
          setSettingsGreeting(biz.greeting || "Thank you for calling. How can I help you today?");
          setSettingsBusinessHours(formatBusinessHours(biz.business_hours));
          setSettingsAfterHoursMode(biz.after_hours_policy || "take-message");
          setSettingsTransferPolicy(biz.transfer_policy || "business_hours_only");
          setSettingsTransferPhoneNumber(biz.transfer_phone_number || "");
          setSettingsNotificationEmail(biz.notification_email || "");
          setSettingsNotificationPhone(biz.notification_phone || "");
        }
      } catch (err) {
        const msg = err?.response?.data?.error || err?.message || "Unknown error";
        setMeError(msg); setBusiness(null); setBusinessId(null);
      } finally {
        setMeLoading(false);
      }
    };
    loadMe();
  }, [session]);

  useEffect(() => {
    if (datePreset === "custom") return;
    const days = Number(datePreset);
    const to = new Date(); const from = new Date();
    from.setDate(to.getDate() - days);
    setFromDate(formatDateYYYYMMDD(from)); setToDate(formatDateYYYYMMDD(to));
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
  }, [businessId, status, callerSearch, fromDate, toDate, hasAppointments, sentiment, hasSummary, needsFollowUp]);

  useEffect(() => {
    if (!businessId) return;
    const fetchAnalytics = () =>
      api.get(`/api/analytics/${businessId}`)
        .then((res) => { setAnalytics(res.data); setAnalyticsError(null); })
        .catch((err) => {
          console.error(err);
          setAnalyticsError(err?.response?.data?.error || err?.message || "Failed to load analytics");
        });
    fetchAnalytics();
    const ti = setInterval(fetchAnalytics, 15000);
    return () => clearInterval(ti);
  }, [businessId]);

  useEffect(() => {
    if (!businessId || activePage !== "dashboard") return;
    setCallsLoading(true); setCallsError(null); setCalls([]);
    api.get(`/api/calls`, { params: callsQueryParams })
      .then((res) => {
        setCalls(res.data);
        if (selectedCallId && !res.data.some((c) => c.id === selectedCallId)) {
          setSelectedCallId(null); setCallDetails(null); setCallDetailsError(null);
        }
      })
      .catch((err) => {
        console.error(err);
        setCallsError(err?.response?.data?.error || err?.message || "Failed to load calls");
      })
      .finally(() => setCallsLoading(false));
  }, [businessId, callsQueryParams, selectedCallId, activePage]);

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

  const resetFilters = () => {
    setStatus("all"); setCallerSearch(""); setDatePreset("7");
    const d = new Date(); const from = new Date();
    from.setDate(d.getDate() - 7);
    setFromDate(formatDateYYYYMMDD(from)); setToDate(formatDateYYYYMMDD(d));
    setHasAppointments(false); setSentiment("all"); setHasSummary("all"); setNeedsFollowUp(false);
  };

  const saveSettings = async (e) => {
    e.preventDefault();
    if (!businessId) { setSettingsError("No business selected."); return; }
    setSettingsSaving(true); setSettingsSavedMessage(""); setSettingsError("");
    try {
      const res = await api.put(`/api/business/${businessId}/settings`, {
        name: settingsBusinessName, timezone: settingsTimezone,
        greeting_message: settingsGreeting, after_hours_policy: settingsAfterHoursMode,
        transfer_policy: settingsTransferPolicy, transfer_phone_number: settingsTransferPhoneNumber,
        notification_email: settingsNotificationEmail, notification_phone: settingsNotificationPhone,
        default_language: settingsDefaultLanguage,
      });
      const updatedBusiness = res.data;
      setBusiness((prev) => ({ ...(prev || {}), ...updatedBusiness }));
      setSettingsBusinessName(updatedBusiness.name || "");
      setSettingsTimezone(updatedBusiness.timezone || "America/Chicago");
      setSettingsDefaultLanguage(updatedBusiness.default_language || "en");
      setSettingsGreeting(updatedBusiness.greeting || "Thank you for calling. How can I help you today?");
      setSettingsBusinessHours(formatBusinessHours(updatedBusiness.business_hours));
      setSettingsAfterHoursMode(updatedBusiness.after_hours_policy || "take-message");
      setSettingsTransferPolicy(updatedBusiness.transfer_policy || "business_hours_only");
      setSettingsTransferPhoneNumber(updatedBusiness.transfer_phone_number || "");
      setSettingsNotificationEmail(updatedBusiness.notification_email || "");
      setSettingsNotificationPhone(updatedBusiness.notification_phone || "");
      setSettingsSavedMessage("Settings saved successfully.");
    } catch (err) {
      console.error(err);
      setSettingsError(err?.response?.data?.error || "Failed to save settings");
    } finally {
      setSettingsSaving(false);
    }
  };

  if (isResetPasswordPage) return <ResetPassword />;

  if (checkingSession)
    return <LoadingScreen title={t.checkingSession} subtitle={t.checkingSubtitle} />;

  if (!session)
    return authView === "login"
      ? <Login onSwitchToSignup={() => setAuthView("signup")} />
      : <Signup onSwitchToLogin={() => setAuthView("login")} />;

  if (needsOnboarding)
    return (
      <Onboarding onComplete={(biz) => {
        setNeedsOnboarding(false); setBusiness(biz); setBusinessId(biz.id);
      }} />
    );

  if (meLoading)
    return <LoadingScreen title={t.loadingDashboard} subtitle={t.loadingSubtitle} />;

  if (meError)
    return (
      <div style={{ padding: 24, fontFamily: "system-ui", color: "white", background: "#0b0b0b", minHeight: "100vh" }}>
        <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 10 }}>{t.couldntLoad}</div>
        <div style={{ opacity: 0.8, marginBottom: 14 }}>{meError}</div>
        <button
          onClick={async () => { await supabase.auth.signOut(); window.location.reload(); }}
          style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #444", background: "#111", color: "white", cursor: "pointer" }}
        >
          {t.signOut}
        </button>
      </div>
    );

  return (
    <div className="dashboard-page">
      <div className="dashboard-shell">
        <header className="dashboard-topbar">
          <div className="dashboard-topbar-left">
            <div className="dashboard-badge">{t.appTitle}</div>
            <h1 className="dashboard-business-name">{business?.name ?? t.appTitle}</h1>
            {business ? (
              <div className="dashboard-business-meta">
                <span className="dashboard-meta-pill">{business.phone_number || "No phone number"}</span>
                <span className="dashboard-meta-pill">{business.timezone || "No timezone"}</span>
              </div>
            ) : null}
          </div>

          <div className="dashboard-topbar-right" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            {/* ── Language switcher ── */}
            <LanguageSwitcher lang={lang} onChange={handleLangChange} />

            {/* ── Nav tabs ── */}
            <div style={{
              display: "inline-flex", padding: 4, borderRadius: 14,
              background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", gap: 4,
            }}>
              <button
                className="dashboard-logout"
                style={{
                  height: 40,
                  background: activePage === "dashboard" ? "rgba(88,164,255,0.16)" : "transparent",
                  border: activePage === "dashboard" ? "1px solid rgba(88,164,255,0.32)" : "1px solid transparent",
                }}
                onClick={() => setActivePage("dashboard")}
              >
                {t.navDashboard}
              </button>
              <button
                className="dashboard-logout"
                style={{
                  height: 40,
                  background: activePage === "settings" ? "rgba(88,164,255,0.16)" : "transparent",
                  border: activePage === "settings" ? "1px solid rgba(88,164,255,0.32)" : "1px solid transparent",
                }}
                onClick={() => setActivePage("settings")}
              >
                {t.navSettings}
              </button>
            </div>

            <button
              className="dashboard-logout"
              onClick={async () => { await supabase.auth.signOut(); window.location.reload(); }}
            >
              {t.logout}
            </button>
          </div>
        </header>

        {activePage === "dashboard" ? (
          <>
            {analytics ? (
              <section className="dashboard-kpis">
                <div className="kpi-card"><div className="kpi-label">{t.callsToday}</div><div className="kpi-value">{analytics.calls_today ?? 0}</div></div>
                <div className="kpi-card"><div className="kpi-label">{t.appointmentsToday}</div><div className="kpi-value">{analytics.appointments_today ?? 0}</div></div>
                <div className="kpi-card"><div className="kpi-label">{t.followUpsNeeded}</div><div className="kpi-value">{analytics.followups_needed ?? 0}</div></div>
                <div className="kpi-card"><div className="kpi-label">{t.positiveCalls}</div><div className="kpi-value">{(analytics.positive_calls_percent ?? 0) + "%"}</div></div>
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
                <div className="panel-header"><h2 className="panel-title">{t.calls}</h2></div>
                <div className="panel-body">
                  <div className="filters-grid">
                    <div className="filter-row-2">
                      <div className="filter-field">
                        <label>{t.filterStatus}</label>
                        <select value={status} onChange={(e) => setStatus(e.target.value)}>
                          <option value="all">{t.filterAll}</option>
                          <option value="completed">{t.filterCompleted}</option>
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
                      {callsLoading ? t.loadingCalls : t.showingCalls(calls.length)}
                    </span>
                    <button className="reset-button" onClick={resetFilters}>{t.reset}</button>
                  </div>

                  <div className="calls-list">
                    {callsLoading ? (
                      <div className="empty-note">{t.loadingCallsEllipsis}</div>
                    ) : callsError ? (
                      <div className="empty-note">{callsError}</div>
                    ) : !calls.length ? (
                      <div className="empty-note">{t.noCallsMatch}</div>
                    ) : (
                      calls.map((call) => (
                        <div
                          key={call.id}
                          onClick={() => loadCallDetails(call.id)}
                          className={`call-card ${selectedCallId === call.id ? "is-active" : ""}`}
                        >
                          <div className="call-card-top">
                            <div className="call-number" style={{ fontSize: 18, marginBottom: 0 }}>{call.caller_number}</div>
                          </div>
                          <div className="call-date">{call.started_at ? new Date(call.started_at).toLocaleString() : ""}</div>
                          <div className="call-meta" style={{ marginTop: 12 }}>
                            <span style={getStatusPillStyle(call.status)}>{call.status}</span>
                            <span className="call-pill">{call.duration_seconds ?? "-"}s</span>
                            <span style={getSentimentPillStyle(call.sentiment)}>{call.sentiment ?? t.filterUnknown}</span>
                            <span className="call-pill">{call.summary ? t.summaryCheck : t.noSummaryShort}</span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </aside>

              <section className="panel">
                <div className="panel-header"><h2 className="panel-title">{t.callDetails}</h2></div>
                <div className="panel-body">
                  {callDetailsLoading ? (
                    <div className="details-empty">{t.loadingCallDetails}</div>
                  ) : callDetailsError ? (
                    <div className="details-empty">{callDetailsError}</div>
                  ) : !callDetails ? (
                    <div className="details-empty">{t.selectCallPrompt}</div>
                  ) : (
                    <div className="details-stack">
                      <div className="detail-card">
                        <h3 className="detail-card-title">{t.callInfo}</h3>
                        <div className="info-grid">
                          <div className="info-label">{t.infoStatus}</div>
                          <div className="info-value">{callDetails.call.status}</div>
                          <div className="info-label">{t.infoDuration}</div>
                          <div className="info-value">{callDetails.call.duration_seconds ?? "-"} {t.sec}</div>
                          <div className="info-label">{t.infoStarted}</div>
                          <div className="info-value">{callDetails.call.started_at ? new Date(callDetails.call.started_at).toLocaleString() : "-"}</div>
                          <div className="info-label">{t.infoSummary}</div>
                          <div className="info-value">{callDetails.call.summary ?? t.noSummaryYet}</div>
                          <div className="info-label">{t.infoSentiment}</div>
                          <div className="info-value">{callDetails.call.sentiment ?? t.unknownSentiment}</div>
                        </div>
                      </div>

                      <div className="detail-card">
                        <h3 className="detail-card-title">{t.transcript}</h3>
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
        ) : (
          <section style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16 }}>
            <section className="panel">
              <div className="panel-header"><h2 className="panel-title">{t.businessSettings}</h2></div>
              <div className="panel-body">
                <form onSubmit={saveSettings} style={{ display: "grid", gap: 14 }}>
                  <div className="filter-field">
                    <label>{t.businessName}</label>
                    <input value={settingsBusinessName} onChange={(e) => setSettingsBusinessName(e.target.value)} placeholder={t.businessName} />
                  </div>
                  <div className="filter-field">
                    <label>{t.timezone}</label>
                    <select value={settingsTimezone} onChange={(e) => setSettingsTimezone(e.target.value)}>
                      <option value="America/Chicago">America/Chicago</option>
                      <option value="America/New_York">America/New_York</option>
                      <option value="America/Los_Angeles">America/Los_Angeles</option>
                      <option value="Europe/London">Europe/London</option>
                    </select>
                  </div>
                  <div className="filter-field">
                    <label>{t.preferredLanguage}</label>
                    <select value={settingsDefaultLanguage} onChange={(e) => setSettingsDefaultLanguage(e.target.value)}>
                      <option value="en">English</option>
                      <option value="es">Spanish</option>
                      <option value="fr">French</option>
                    </select>
                  </div>
                  <div className="filter-field">
                    <label>{t.businessPhone}</label>
                    <input value={business?.phone_number || t.noPhoneConnected} disabled />
                  </div>
                  <div className="filter-field">
                    <label>{t.setupStatus}</label>
                    <input value={business?.phone_number ? t.businessActive : t.businessNoPhone} disabled />
                  </div>
                </form>
              </div>
            </section>

            <section className="panel">
              <div className="panel-header"><h2 className="panel-title">{t.aiReceptionistTitle}</h2></div>
              <div className="panel-body" style={{ display: "grid", gap: 14 }}>
                <div className="filter-field">
                  <label>{t.greetingMessage}</label>
                  <textarea value={settingsGreeting} onChange={(e) => setSettingsGreeting(e.target.value)} rows={4}
                    style={{ width: "100%", padding: 14, borderRadius: 12, border: "1px solid rgba(255,255,255,0.09)", background: "rgba(6,11,19,0.85)", color: "#f5f7fb", outline: "none", fontSize: 14, resize: "vertical", minHeight: 110 }} />
                </div>
                <div className="filter-field">
                  <label>{t.businessHours}</label>
                  <input value={settingsBusinessHours} onChange={(e) => setSettingsBusinessHours(e.target.value)} placeholder="Mon–Fri, 9:00 AM – 5:00 PM" disabled />
                </div>
                <div className="filter-field">
                  <label>{t.afterHoursBehaviour}</label>
                  <select value={settingsAfterHoursMode} onChange={(e) => setSettingsAfterHoursMode(e.target.value)}>
                    <option value="take-message">{t.takeMessage}</option>
                    <option value="book-later">{t.bookLater}</option>
                    <option value="book_appointment">{t.bookAppointment}</option>
                  </select>
                </div>
                <div className="checkbox-list">
                  <label className="checkbox-item">
                    <input type="checkbox" checked={settingsAllowAppointments} onChange={(e) => setSettingsAllowAppointments(e.target.checked)} />
                    <span>{t.allowAppointments}</span>
                  </label>
                  <label className="checkbox-item">
                    <input type="checkbox" checked={settingsAllowCallbacks} onChange={(e) => setSettingsAllowCallbacks(e.target.checked)} />
                    <span>{t.allowCallbacks}</span>
                  </label>
                  <label className="checkbox-item">
                    <input type="checkbox" checked={settingsAllowMessages} onChange={(e) => setSettingsAllowMessages(e.target.checked)} />
                    <span>{t.allowMessages}</span>
                  </label>
                </div>
              </div>
            </section>

            <section className="panel">
              <div className="panel-header"><h2 className="panel-title">{t.callHandling}</h2></div>
              <div className="panel-body" style={{ display: "grid", gap: 14 }}>
                <div className="filter-field">
                  <label>{t.transferPolicy}</label>
                  <select value={settingsTransferPolicy} onChange={(e) => setSettingsTransferPolicy(e.target.value)}>
                    <option value="never">{t.neverTransfer}</option>
                    <option value="always">{t.alwaysTransfer}</option>
                    <option value="business_hours_only">{t.businessHoursOnly}</option>
                  </select>
                </div>
                <div className="filter-field">
                  <label>{t.transferPhone}</label>
                  <input value={settingsTransferPhoneNumber} onChange={(e) => setSettingsTransferPhoneNumber(e.target.value)} placeholder="+447700900123" />
                </div>
                <div className="filter-field">
                  <label>{t.emergencyMessage}</label>
                  <textarea value={settingsEmergencyMessage} onChange={(e) => setSettingsEmergencyMessage(e.target.value)} rows={4}
                    style={{ width: "100%", padding: 14, borderRadius: 12, border: "1px solid rgba(255,255,255,0.09)", background: "rgba(6,11,19,0.85)", color: "#f5f7fb", outline: "none", fontSize: 14, resize: "vertical", minHeight: 110 }} />
                </div>
                <div className="filter-field">
                  <label>{t.fallbackInstructions}</label>
                  <textarea value={settingsFallbackInstructions} onChange={(e) => setSettingsFallbackInstructions(e.target.value)} rows={4}
                    style={{ width: "100%", padding: 14, borderRadius: 12, border: "1px solid rgba(255,255,255,0.09)", background: "rgba(6,11,19,0.85)", color: "#f5f7fb", outline: "none", fontSize: 14, resize: "vertical", minHeight: 110 }} />
                </div>
              </div>
            </section>

            <section className="panel">
              <div className="panel-header"><h2 className="panel-title">{t.billingPlan}</h2></div>
              <div className="panel-body" style={{ display: "grid", gap: 14 }}>
                <div className="detail-card" style={{ padding: 14 }}>
                  <div className="info-grid">
                    <div className="info-label">{t.currentPlan}</div><div className="info-value">{settingsPlanName}</div>
                    <div className="info-label">{t.billingStatus}</div><div className="info-value">{settingsBillingStatus}</div>
                    <div className="info-label">{t.usageThisMonth}</div><div className="info-value">{t.comingSoon}</div>
                    <div className="info-label">{t.phoneNumber}</div><div className="info-value">{business?.phone_number || t.notConnectedYet}</div>
                  </div>
                </div>
                <div className="empty-note">{t.stripeComing}</div>
              </div>
            </section>

            <section className="panel">
              <div className="panel-header"><h2 className="panel-title">{t.notifications}</h2></div>
              <div className="panel-body" style={{ display: "grid", gap: 14 }}>
                <div className="filter-field">
                  <label>{t.notificationEmail}</label>
                  <input value={settingsNotificationEmail} onChange={(e) => setSettingsNotificationEmail(e.target.value)} placeholder="you@business.com" />
                </div>
                <div className="filter-field">
                  <label>{t.notificationPhone}</label>
                  <input value={settingsNotificationPhone} onChange={(e) => setSettingsNotificationPhone(e.target.value)} placeholder="+447700900123" />
                </div>
              </div>
            </section>

            <section className="panel" style={{ gridColumn: "1 / -1" }}>
              <div className="panel-header"><h2 className="panel-title">{t.saveSettings}</h2></div>
              <div className="panel-body" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                <div style={{ display: "grid", gap: 8 }}>
                  {settingsSavedMessage ? (
                    <div style={{ padding: "12px 14px", borderRadius: 12, border: "1px solid rgba(67,182,110,0.25)", background: "rgba(67,182,110,0.08)", color: "#9ce5b1", fontSize: 13 }}>
                      {settingsSavedMessage}
                    </div>
                  ) : null}
                  {settingsError ? (
                    <div style={{ padding: "12px 14px", borderRadius: 12, border: "1px solid rgba(255,107,107,0.25)", background: "rgba(255,107,107,0.08)", color: "#ff9191", fontSize: 13 }}>
                      {settingsError}
                    </div>
                  ) : (
                    <div className="empty-note">{t.saveDescription}</div>
                  )}
                </div>
                <button
                  className="dashboard-logout"
                  style={{ minWidth: 180, height: 48, background: "linear-gradient(135deg, #3576f6, #44d2c8)", border: "none", color: "#fff", boxShadow: "0 14px 34px rgba(53,118,246,0.24)" }}
                  onClick={saveSettings}
                  disabled={settingsSaving}
                >
                  {settingsSaving ? t.saving : t.saveSettings}
                </button>
              </div>
            </section>
          </section>
        )}
      </div>
    </div>
  );
}

export default App;

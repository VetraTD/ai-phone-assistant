import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useTranslations } from "../LanguageSwitcher";
import { useBusiness } from "../shell/BusinessContext";
import "../Dashboard.css";

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

// Moved out of the old one-page App.jsx; markup unchanged apart from the email
// range picker. Part 2 replaces it.
export default function LegacyAppointments() {
  const t = useTranslations();
  const navigate = useNavigate();
  const { business, businessId } = useBusiness();
  const [appointmentsList, setAppointmentsList] = useState([]);
  const [appointmentsLoading, setAppointmentsLoading] = useState(false);
  const [appointmentsError, setAppointmentsError] = useState(null);
  const [appointmentsRange, setAppointmentsRange] = useState("upcoming");
  const [emailRange, setEmailRange] = useState("today");
  const [toast, setToast] = useState(null);

  useEffect(() => {
    if (!businessId) return;
    // Moved unchanged from App.jsx; part 2 rebuilds this page.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAppointmentsLoading(true);
    setAppointmentsError(null);
    api.get("/api/appointments", { params: { range: appointmentsRange } })
      .then((res) => { setAppointmentsList(Array.isArray(res.data) ? res.data : []); })
      .catch((err) => {
        setAppointmentsError(err?.response?.data?.error || err?.message || "Failed to load appointments");
        setAppointmentsList([]);
      })
      .finally(() => setAppointmentsLoading(false));
  }, [businessId, appointmentsRange]);

  useEffect(() => {
    if (!toast) return undefined;
    const id = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(id);
  }, [toast]);

  const emailBookings = async () => {
    if (!businessId) return;
    const to = business?.notification_email;
    if (!to) {
      setToast({ type: "error", message: "Add a notification email in Settings first." });
      return;
    }
    try {
      await api.post("/api/appointments/email", { range: emailRange });
      // The email is a nudge with a count and a link, not the list: bodies carry
      // no patient information (A1.3), so the copy must not promise one.
      setToast({ type: "success", message: `Sent a reminder to ${to}. Details stay here in the dashboard.` });
    } catch (err) {
      console.error(err);
      setToast({ type: "error", message: "Failed to send appointments email. Please try again." });
    }
  };

  return (
    <>
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
        <div className="appointments-email" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label htmlFor="appointments-email-range">
            <span style={{ marginRight: 6 }}>Email range</span>
            <select
              id="appointments-email-range"
              value={emailRange}
              onChange={(e) => setEmailRange(e.target.value)}
            >
              <option value="today">{t.appointmentsRangeToday}</option>
              <option value="7days">{t.appointmentsRange7Days}</option>
              <option value="upcoming">{t.appointmentsRangeUpcoming}</option>
            </select>
          </label>
          <button type="button" className="reset-button" onClick={emailBookings}>
            Email me bookings
          </button>
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
                    onClick={() => navigate(`/inbox/${appt.call_id}`)}
                  >
                    {t.viewCall}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>
      {toast && (
        <div className={`dashboard-toast dashboard-toast-${toast.type}`}>
          {toast.message}
        </div>
      )}
    </>
  );
}

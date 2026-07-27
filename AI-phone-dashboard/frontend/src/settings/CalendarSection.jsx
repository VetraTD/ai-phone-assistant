import { CircleCheck } from "lucide-react";

/**
 * Google Calendar connection — now rendered INSIDE the Appointments capability
 * card (via SettingsPage `extras.appointments.node`), because syncing to a
 * calendar only means anything once the receptionist is booking. So this is a
 * light embedded sub-section, not a standalone Panel — nesting a full card
 * inside the capability card would read as a card-in-card.
 *
 * Every handler still lives in App.jsx; this only draws what it's handed.
 * Copy reflects the auto-sync model (appointments are pushed automatically);
 * the manual button remains as an immediate "push now" for the impatient.
 */
export default function CalendarSection({ connected, loading, syncing, onSync, onDisconnect, onConnect, t }) {
  return (
    <div className="set-subcard">
      <div className="set-row-between">
        <strong style={{ fontSize: 14 }}>{t?.calendarSync || "Google Calendar"}</strong>
        {connected ? (
          <span className="set-pill set-pill-on">
            <CircleCheck size={13} aria-hidden="true" />
            Connected
          </span>
        ) : (
          <span className="set-pill">Not connected</span>
        )}
      </div>

      <p className="set-hint" style={{ maxWidth: "none" }}>
        {connected
          ? "New bookings appear in your Google Calendar automatically, within a minute or two. Use “Sync now” if you want them there this second."
          : "Connect a Google Calendar and every appointment the receptionist books will show up in it automatically."}
      </p>

      {loading ? (
        <p className="set-hint">Loading…</p>
      ) : connected ? (
        <div className="set-row">
          <button type="button" className="set-btn set-btn-sm" disabled={syncing} onClick={onSync}>
            {syncing ? "Syncing…" : t?.syncToCalendarNow || "Sync now"}
          </button>
          <button type="button" className="set-btn-danger set-btn-sm" onClick={onDisconnect}>
            {t?.disconnectCalendar || "Disconnect"}
          </button>
        </div>
      ) : (
        <div className="set-row">
          <button type="button" className="set-btn-primary set-btn-sm" onClick={onConnect}>
            {t?.connectGoogleCalendar || "Connect Google Calendar"}
          </button>
        </div>
      )}
    </div>
  );
}

import Panel from "./Panel";
import { DAY_KEYS, DAY_LABELS } from "./constants";

// Weekly business_hours editor. Backend validateBusinessHours
// (settingsValidation.js) requires every day with closed !== true to carry
// valid HH:MM open+close — a day can never be emitted as
// { closed: false, open: "", close: "" } or the save 400s. The guards below
// (never writing an empty string into open/close, and filling in a sane
// default the moment a day is un-closed) keep every day in a valid shape at
// all times, not just at submit time.
const FALLBACK_OPEN = "09:00";
const FALLBACK_CLOSE = "17:00";

export default function BusinessHoursEditor({ value, onChange }) {
  const hours = value.business_hours;

  const updateDay = (day, patch) => {
    onChange({ business_hours: { ...hours, [day]: { ...hours[day], ...patch } } });
  };

  const setClosed = (day, closed) => {
    if (closed) {
      updateDay(day, { closed: true, open: null, close: null });
    } else {
      const current = hours[day] || {};
      updateDay(day, {
        closed: false,
        open: current.open || FALLBACK_OPEN,
        close: current.close || FALLBACK_CLOSE,
      });
    }
  };

  const setTime = (day, field, rawValue) => {
    // Never let a cleared time input produce an empty string — fall back to
    // the day's previous value, or the default, so the day always stays
    // valid even mid-edit.
    const current = hours[day] || {};
    updateDay(day, { [field]: rawValue || current[field] || (field === "open" ? FALLBACK_OPEN : FALLBACK_CLOSE) });
  };

  const openDays = DAY_KEYS.filter((day) => !hours[day]?.closed).length;

  return (
    <Panel
      title="Opening hours"
      description="Read in your business timezone."
      badge={
        <span className="set-pill">
          {openDays === 7 ? "Open every day" : `Open ${openDays} ${openDays === 1 ? "day" : "days"} a week`}
        </span>
      }
    >
      <div className="set-stack">
        {DAY_KEYS.map((day) => {
          const d = hours[day] || { open: null, close: null, closed: true };
          return (
            <div key={day} className="set-day">
              <span className="set-day-name">{DAY_LABELS[day]}</span>
              <label className="set-check">
                <input type="checkbox" checked={!!d.closed} onChange={(e) => setClosed(day, e.target.checked)} />
                <span className="set-check-text">Closed</span>
              </label>
              <input
                type="time"
                aria-label={`${DAY_LABELS[day]} opening time`}
                value={d.open || ""}
                disabled={!!d.closed}
                onChange={(e) => setTime(day, "open", e.target.value)}
              />
              <span className="set-day-dash" aria-hidden="true">
                –
              </span>
              <input
                type="time"
                aria-label={`${DAY_LABELS[day]} closing time`}
                value={d.close || ""}
                disabled={!!d.closed}
                onChange={(e) => setTime(day, "close", e.target.value)}
              />
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

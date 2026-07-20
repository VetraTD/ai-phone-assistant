import SectionCard from "./SectionCard";

export default function NotificationsSection({ value, onChange }) {
  return (
    <SectionCard title="Notifications">
      <div className="filter-field">
        <label>Notification email</label>
        <input
          type="email"
          value={value.notification_email}
          onChange={(e) => onChange({ notification_email: e.target.value })}
          placeholder="you@business.com"
        />
      </div>
      <div className="filter-field">
        <label>Notification phone</label>
        <input
          value={value.notification_phone}
          onChange={(e) => onChange({ notification_phone: e.target.value })}
          placeholder="+447700900123"
        />
      </div>
      <label className="checkbox-item">
        <input
          type="checkbox"
          checked={value.notifications_enabled}
          onChange={(e) => onChange({ notifications_enabled: e.target.checked })}
        />
        <span>Send notifications for new appointments, messages, and callbacks</span>
      </label>
    </SectionCard>
  );
}

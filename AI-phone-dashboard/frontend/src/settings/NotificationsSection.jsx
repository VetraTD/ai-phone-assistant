import Panel from "./Panel";
import Field, { CheckField } from "./Field";

// Texts are off in production (no SMS sender is configured), so this panel
// offers only what works: the alert email and its switch. The alert phone and
// the caller follow-up text, with its wording overrides, are not rendered;
// their columns stay writable and are listed as NOT_SHOWN in
// tests/dashboardSettingsEffects.test.js. They come back when texts do.
export default function NotificationsSection({ value, onChange, appointmentsEnabled }) {
  // Owner alerts fire on messages/callbacks always, on bookings only when
  // appointments are on. Don't promise appointment alerts to a business that
  // doesn't book.
  const ownerEvents = appointmentsEnabled
    ? "leaves a message, asks for a callback, or books an appointment"
    : "leaves a message or asks for a callback";

  return (
    <Panel title="How we reach you" description="Where alerts about your calls are sent.">
      <Field label="Notification email" optional>
        {(p) => (
          <input
            {...p}
            type="email"
            autoComplete="email"
            value={value.notification_email}
            onChange={(e) => onChange({ notification_email: e.target.value })}
            placeholder="you@business.com"
          />
        )}
      </Field>

      <CheckField
        checked={value.notifications_enabled}
        onChange={(notifications_enabled) => onChange({ notifications_enabled })}
      >
        {`Email me when a caller ${ownerEvents}`}
      </CheckField>
    </Panel>
  );
}

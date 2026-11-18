import { useState } from "react";
import Panel from "./Panel";
import Field, { CheckField } from "./Field";
import { SMS_TEMPLATE_KINDS, SMS_TEMPLATE_MAX_LENGTH, SMS_TEMPLATE_META } from "./constants";

export default function NotificationsSection({ value, onChange, appointmentsEnabled }) {
  const [showTemplates, setShowTemplates] = useState(false);

  // Owner alerts fire on messages/callbacks always, on bookings only when
  // appointments are on. Don't promise appointment alerts to a business that
  // doesn't book. Same for the caller-SMS kinds.
  const ownerEvents = appointmentsEnabled
    ? "leaves a message, asks for a callback, or books an appointment"
    : "leaves a message or asks for a callback";
  const callerCovers = appointmentsEnabled
    ? "Covers appointment confirmations, message receipts and missed calls."
    : "Covers message receipts and missed calls.";

  const templates = value.sms_templates && typeof value.sms_templates === "object" ? value.sms_templates : {};
  const followupEnabled = !!value.sms_followup_enabled;

  // Always emit the WHOLE sms_templates object — the backend validator
  // replaces the column wholesale, so a partial patch would drop the other
  // kinds' overrides. A cleared field drops its key entirely rather than
  // persisting "" (which the voice server would just fall back from anyway).
  const patchTemplate = (kind, text) => {
    const next = { ...templates };
    if (text.trim()) next[kind] = text;
    else delete next[kind];
    onChange({ sms_templates: next });
  };

  return (
    <>
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

        <Field label="Notification phone" optional>
          {(p) => (
            <input
              {...p}
              type="tel"
              autoComplete="tel"
              value={value.notification_phone}
              onChange={(e) => onChange({ notification_phone: e.target.value })}
              placeholder="+447700900123"
            />
          )}
        </Field>

        <CheckField
          checked={value.notifications_enabled}
          onChange={(notifications_enabled) => onChange({ notifications_enabled })}
        >
          {`Email or text me when a caller ${ownerEvents}`}
        </CheckField>
      </Panel>

      <Panel
        title="What callers get afterwards"
        description="An automatic text message once the call ends, so the caller has something in writing."
      >
        <CheckField
          checked={followupEnabled}
          onChange={(sms_followup_enabled) => onChange({ sms_followup_enabled })}
          hint={callerCovers}
        >
          Text callers a follow-up SMS
        </CheckField>

        {followupEnabled ? (
          <>
            <button
              type="button"
              className="set-btn set-btn-sm"
              style={{ justifySelf: "start" }}
              aria-expanded={showTemplates}
              onClick={() => setShowTemplates((s) => !s)}
            >
              {showTemplates ? "Hide message wording" : "Customise message wording"}
            </button>

            {showTemplates ? (
              <div className="set-stack" style={{ gap: 18 }}>
                <p className="set-hint">Leave a message blank and we use our own wording.</p>
                {SMS_TEMPLATE_KINDS.map((kind) => {
                  const meta = SMS_TEMPLATE_META[kind];
                  return (
                    <Field key={kind} label={meta.label} hint={meta.hint}>
                      {(p) => (
                        <textarea
                          {...p}
                          rows={3}
                          maxLength={SMS_TEMPLATE_MAX_LENGTH}
                          value={templates[kind] || ""}
                          onChange={(e) => patchTemplate(kind, e.target.value)}
                          placeholder={meta.placeholder}
                        />
                      )}
                    </Field>
                  );
                })}
              </div>
            ) : null}
          </>
        ) : null}
      </Panel>
    </>
  );
}

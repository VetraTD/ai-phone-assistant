import { useState } from "react";
import SectionCard from "./SectionCard";
import { SMS_TEMPLATE_KINDS, SMS_TEMPLATE_MAX_LENGTH, SMS_TEMPLATE_META } from "./constants";

export default function NotificationsSection({ value, onChange }) {
  const [showTemplates, setShowTemplates] = useState(false);

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

      <label className="checkbox-item">
        <input
          type="checkbox"
          checked={followupEnabled}
          onChange={(e) => onChange({ sms_followup_enabled: e.target.checked })}
        />
        <span>Text callers a follow-up SMS (appointment confirmations, message receipts, missed calls)</span>
      </label>

      {followupEnabled ? (
        <>
          <button
            type="button"
            className="dashboard-logout"
            style={{ justifySelf: "start" }}
            onClick={() => setShowTemplates((s) => !s)}
          >
            {showTemplates ? "Hide message wording" : "Customise message wording"}
          </button>

          {showTemplates ? (
            <div style={{ display: "grid", gap: 14 }}>
              <p className="field-hint" style={{ margin: 0 }}>
                Leave a field blank to use our default wording.
              </p>
              {SMS_TEMPLATE_KINDS.map((kind) => {
                const meta = SMS_TEMPLATE_META[kind];
                return (
                  <div className="filter-field" key={kind}>
                    <label htmlFor={`sms-template-${kind}`}>{meta.label}</label>
                    <textarea
                      id={`sms-template-${kind}`}
                      rows={3}
                      maxLength={SMS_TEMPLATE_MAX_LENGTH}
                      value={templates[kind] || ""}
                      onChange={(e) => patchTemplate(kind, e.target.value)}
                      placeholder={meta.placeholder}
                    />
                    <p className="field-hint" style={{ margin: 0 }}>
                      {meta.hint}
                    </p>
                  </div>
                );
              })}
            </div>
          ) : null}
        </>
      ) : null}
    </SectionCard>
  );
}

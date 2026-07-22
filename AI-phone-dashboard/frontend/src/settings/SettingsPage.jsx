import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import BusinessInfoSection from "./BusinessInfoSection";
import BusinessHoursEditor from "./BusinessHoursEditor";
import AIBehaviorSection from "./AIBehaviorSection";
import CapabilitiesSection from "./CapabilitiesSection";
import TransferRulesSection from "./TransferRulesSection";
import AfterHoursSection from "./AfterHoursSection";
import KnowledgeBaseEditor from "./KnowledgeBaseEditor";
import VoicePickerSection from "./VoicePickerSection";
import NotificationsSection from "./NotificationsSection";
import LanguagesSection from "./LanguagesSection";
import { errorBoxStyle } from "./styles";
import { DAY_KEYS, MODULE_TASKS, AFTER_HOURS_POLICIES, TRANSFER_POLICIES } from "./constants";

const MODULE_TASK_KEYS = MODULE_TASKS.map((t) => t.key);
const AFTER_HOURS_KEYS = AFTER_HOURS_POLICIES.map((p) => p.key);
const TRANSFER_POLICY_KEYS = TRANSFER_POLICIES.map((p) => p.key);

// Default weekly business_hours shape (Mon-Fri 9-5, Sat/Sun closed) — matches
// database/014_business_hours_weekly.sql's column default for new rows.
// Used whenever a business row predates that migration and still carries
// business_hours=null (which legitimately means "always open" — see
// services/gemini.js isBusinessOpen) or the legacy {open_time,close_time}
// shape: rather than leave the editor with nothing to show, we materialize
// this default as BOTH the editable draft and the save baseline, so opening
// the page doesn't itself mark business_hours dirty. It's only included in
// a save once the user actually edits a day (see diffSnapshots below).
const DEFAULT_HOURS = DAY_KEYS.reduce((acc, day) => {
  acc[day] =
    day === "sat" || day === "sun"
      ? { open: null, close: null, closed: true }
      : { open: "09:00", close: "17:00", closed: false };
  return acc;
}, {});

// Editable snapshot built from a `businesses` row. Every key here is a key
// in backend SETTINGS_FIELD_VALIDATORS (settingsValidation.js) — that
// whitelist is the write contract this page targets 1:1. Unknown/legacy
// values (e.g. a pre-4A after_hours_policy of "take-message") are normalized
// to a valid default rather than passed through, so the <select> always has
// a matching <option>.
function snapshotFromBusiness(b) {
  const hasWeeklyHours = b?.business_hours && typeof b.business_hours === "object" && "mon" in b.business_hours;
  return {
    name: b?.name || "",
    timezone: b?.timezone || "America/Chicago",
    main_phone: b?.main_phone || "",
    general_info: b?.general_info || "",
    business_hours: hasWeeklyHours ? b.business_hours : DEFAULT_HOURS,
    greeting: b?.greeting || "",
    custom_instructions: b?.custom_instructions || "",
    allowed_tasks: Array.isArray(b?.allowed_tasks) ? b.allowed_tasks.filter((k) => MODULE_TASK_KEYS.includes(k)) : [],
    transfer_policy: TRANSFER_POLICY_KEYS.includes(b?.transfer_policy) ? b.transfer_policy : "business_hours_only",
    transfer_phone_number: b?.transfer_phone_number || "",
    after_hours_policy: AFTER_HOURS_KEYS.includes(b?.after_hours_policy) ? b.after_hours_policy : "take_message",
    voice_provider: b?.voice_provider === "google" ? "google" : "elevenlabs",
    voice_id: b?.voice_id || "",
    notification_email: b?.notification_email || "",
    notification_phone: b?.notification_phone || "",
    notifications_enabled: b?.notifications_enabled !== false,
    // Caller-facing SMS follow-ups (businesses.sms_followup_enabled /
    // sms_templates). Both must be in this snapshot, not just in
    // NotificationsSection's markup — diffSnapshots only ever sends keys that
    // exist here, so a control editing a key absent from the snapshot would
    // silently never be saved.
    sms_followup_enabled: !!b?.sms_followup_enabled,
    sms_templates:
      b?.sms_templates && typeof b.sms_templates === "object" && !Array.isArray(b.sms_templates)
        ? b.sms_templates
        : {},
    languages_spoken: Array.isArray(b?.languages_spoken) && b.languages_spoken.length ? b.languages_spoken : ["en"],
    recording_disclosure_enabled: !!b?.recording_disclosure_enabled,
    recording_disclosure_text: b?.recording_disclosure_text || "",
  };
}

function valuesEqual(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  }
  if (a && typeof a === "object" && b && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

// Only changed top-level keys are sent to PUT /api/business/:id/settings —
// the backend's dynamic UPDATE only touches whitelisted keys present in the
// body, so an unchanged key is simply omitted rather than resent.
function diffSnapshots(current, baseline) {
  const changed = {};
  for (const key of Object.keys(current)) {
    if (!valuesEqual(current[key], baseline[key])) changed[key] = current[key];
  }
  return changed;
}

export default function SettingsPage({ business, businessId, onBusinessUpdate, onDirtyChange }) {
  const [baseline, setBaseline] = useState(() => snapshotFromBusiness(business));
  const [draft, setDraft] = useState(() => snapshotFromBusiness(business));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");

  // Reload the editable snapshot when the business identity changes (e.g.
  // after onboarding completes). Deliberately NOT keyed on `business` itself
  // — after our own save, App.jsx's `business` object is refreshed via
  // onBusinessUpdate, and we already update baseline/draft directly in
  // handleSave, so re-deriving here would just be redundant (and would risk
  // clobbering in-flight edits if any other part of the app ever touches
  // `business` while this page is open).
  useEffect(() => {
    const snap = snapshotFromBusiness(business);
    setBaseline(snap);
    setDraft(snap);
    setError("");
    setSavedMessage("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId]);

  const changed = useMemo(() => diffSnapshots(draft, baseline), [draft, baseline]);
  const dirty = Object.keys(changed).length > 0;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const patch = (fields) => {
    setDraft((prev) => ({ ...prev, ...fields }));
    setSavedMessage("");
  };

  const handleSave = async () => {
    if (!businessId || !dirty) return;
    setSaving(true);
    setError("");
    setSavedMessage("");
    try {
      const res = await api.put(`/api/business/${businessId}/settings`, changed);
      const updated = res.data;
      onBusinessUpdate?.(updated);
      const snap = snapshotFromBusiness(updated);
      setBaseline(snap);
      setDraft(snap);
      setSavedMessage("Settings saved successfully.");
    } catch (err) {
      setError(err?.response?.data?.error || "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <section style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16 }}>
        <BusinessInfoSection value={draft} onChange={patch} phoneNumber={business?.phone_number} />
        <BusinessHoursEditor value={draft} onChange={patch} />
        <AIBehaviorSection value={draft} onChange={patch} />
        <TransferRulesSection value={draft} onChange={patch} />
        <AfterHoursSection value={draft} onChange={patch} />
        <VoicePickerSection value={draft} onChange={patch} />
        <NotificationsSection value={draft} onChange={patch} />
        <LanguagesSection value={draft} onChange={patch} />
      </section>

      {/* Capability settings live in their own table (business_capabilities),
          not on the businesses row, so this section loads and saves itself
          rather than joining the draft/diff flow above. Each card saves
          independently: a validation error in one must not discard edits in
          another. It replaces the old Tasks checkboxes, which could say THAT a
          business books appointments but never HOW. */}
      <section style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16, marginTop: 16 }}>
        <CapabilitiesSection businessId={businessId} />
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16, marginTop: 16 }}>
        <KnowledgeBaseEditor businessId={businessId} />
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-header">
          <h2 className="panel-title">Save changes</h2>
        </div>
        <div
          className="panel-body"
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}
        >
          <div style={{ display: "grid", gap: 8 }}>
            {error ? (
              <div style={errorBoxStyle}>{error}</div>
            ) : savedMessage ? (
              <div className="empty-note" style={{ color: "#1f8a4c" }}>
                {savedMessage}
              </div>
            ) : (
              <div className="empty-note">{dirty ? "You have unsaved changes." : "Everything is saved."}</div>
            )}
          </div>
          <button
            type="button"
            className="dashboard-logout dashboard-save-button"
            onClick={handleSave}
            disabled={saving || !dirty}
          >
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      </section>
    </>
  );
}

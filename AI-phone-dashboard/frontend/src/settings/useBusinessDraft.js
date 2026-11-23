import { useCallback, useMemo, useState } from "react";
import { api } from "../api";
import { DAY_KEYS, MODULE_TASKS, AFTER_HOURS_POLICIES, TRANSFER_POLICIES } from "./constants";

// One draft-and-save for the business's settings, shared by the old Settings
// page and the Voice agent tab: a draft copied from the business, what changed
// against it, Save (sending only the changed keys) and Discard. Moved out of
// SettingsPage.jsx unchanged in behaviour.

const MODULE_TASK_KEYS = MODULE_TASKS.map((t) => t.key);
const AFTER_HOURS_KEYS = AFTER_HOURS_POLICIES.map((p) => p.key);
const TRANSFER_POLICY_KEYS = TRANSFER_POLICIES.map((p) => p.key);
const SAVE_ERROR = "Couldn't save. Check your connection, then try again.";

const DEFAULT_HOURS = DAY_KEYS.reduce((acc, day) => {
  acc[day] =
    day === "sat" || day === "sun"
      ? { open: null, close: null, closed: true }
      : { open: "09:00", close: "17:00", closed: false };
  return acc;
}, {});

/** The editable settings, from a business row, with every default filled in. */
export function snapshotFromBusiness(b) {
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
    locale: b?.locale || "",
    live_voice: b?.live_voice || "",
    notification_email: b?.notification_email || "",
    notification_phone: b?.notification_phone || "",
    notifications_enabled: b?.notifications_enabled !== false,
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

export function valuesEqual(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  }
  if (a && typeof a === "object" && b && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

export function diffSnapshots(current, baseline) {
  const changed = {};
  for (const key of Object.keys(current)) {
    if (!valuesEqual(current[key], baseline[key])) changed[key] = current[key];
  }
  return changed;
}

/**
 * @returns {{ draft: object, changed: object, changedKeys: string[], dirty: boolean,
 *   patch: (fields: object) => void, discard: () => void, save: () => Promise<boolean>,
 *   saving: boolean, error: string, savedMessage: string }}
 */
export function useBusinessDraft({ business, businessId, onBusinessUpdate }) {
  const [baseline, setBaseline] = useState(() => snapshotFromBusiness(business));
  const [draft, setDraft] = useState(() => snapshotFromBusiness(business));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");

  // A different business (an account switch) starts from its own settings.
  const [forBusiness, setForBusiness] = useState(businessId);
  if (businessId !== forBusiness) {
    setForBusiness(businessId);
    const snap = snapshotFromBusiness(business);
    setBaseline(snap);
    setDraft(snap);
    setError("");
    setSavedMessage("");
  }

  const changed = useMemo(() => diffSnapshots(draft, baseline), [draft, baseline]);
  const changedKeys = useMemo(() => Object.keys(changed), [changed]);
  const dirty = changedKeys.length > 0;

  const patch = useCallback((fields) => {
    setDraft((prev) => ({ ...prev, ...fields }));
    setSavedMessage("");
  }, []);

  const discard = useCallback(() => {
    setDraft(baseline);
    setError("");
    setSavedMessage("");
  }, [baseline]);

  const save = useCallback(async () => {
    if (!businessId || !dirty) return true;
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
      return true;
    } catch (err) {
      // The draft stays as typed, so nothing is lost; the message says why.
      setError(err?.response?.data?.error || SAVE_ERROR);
      return false;
    } finally {
      setSaving(false);
    }
  }, [businessId, dirty, changed, onBusinessUpdate]);

  return { draft, changed, changedKeys, dirty, patch, discard, save, saving, error, savedMessage };
}

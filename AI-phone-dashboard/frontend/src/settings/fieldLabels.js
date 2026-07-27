/**
 * Draft keys, in the owner's words, and where to find them.
 *
 * Feeds the save bar's "what changed" list. "You have unsaved changes" is not
 * an answer to the question an owner is actually asking, which is *which*
 * setting they touched and whether it was the one they meant.
 *
 * Keys are the snapshot keys from SettingsPage.snapshotFromBusiness, which are
 * themselves the backend's SETTINGS_FIELD_VALIDATORS whitelist. A key missing
 * from this map still saves — it just falls back to showing the raw key, so a
 * new setting degrades to ugly rather than to invisible.
 */
export const FIELD_LABELS = {
  name: { label: "Business name", group: "general" },
  timezone: { label: "Timezone", group: "general" },
  main_phone: { label: "Main phone", group: "general" },
  general_info: { label: "About your business", group: "general" },
  business_hours: { label: "Opening hours", group: "general" },
  after_hours_policy: { label: "When you're closed", group: "general" },

  greeting: { label: "Greeting", group: "voice" },
  custom_instructions: { label: "House rules", group: "voice" },
  voice_provider: { label: "Voice", group: "voice" },
  voice_id: { label: "Voice", group: "voice" },
  languages_spoken: { label: "Languages spoken", group: "voice" },
  recording_disclosure_enabled: { label: "Recording announcement", group: "voice" },
  recording_disclosure_text: { label: "Recording announcement wording", group: "voice" },

  transfer_policy: { label: "When to transfer a caller", group: "capabilities" },
  transfer_phone_number: { label: "Transfer phone number", group: "capabilities" },
  // Vestigial: nothing edits this since the Tasks checkboxes were replaced by
  // capability packs. Mapped anyway so it can never surface as a raw key.
  allowed_tasks: { label: "Allowed tasks", group: "capabilities" },

  notification_email: { label: "Notification email", group: "notifications" },
  notification_phone: { label: "Notification phone", group: "notifications" },
  notifications_enabled: { label: "Notify me about calls", group: "notifications" },
  sms_followup_enabled: { label: "Text callers a follow-up", group: "notifications" },
  sms_templates: { label: "Follow-up text wording", group: "notifications" },
};

/**
 * Changed keys → one row per human-visible setting.
 *
 * Deduplicated by label because picking a voice changes voice_provider and
 * voice_id together; the owner made one decision and should be shown one line.
 */
export function describeChanges(changedKeys) {
  const seen = new Set();
  const rows = [];
  for (const key of changedKeys) {
    const meta = FIELD_LABELS[key] || { label: key, group: null };
    if (seen.has(meta.label)) continue;
    seen.add(meta.label);
    rows.push({ key, label: meta.label, group: meta.group });
  }
  return rows;
}

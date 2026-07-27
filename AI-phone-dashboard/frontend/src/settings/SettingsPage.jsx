import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import AccountSection from "./AccountSection";
import CalendarSection from "./CalendarSection";
import SettingsNav from "./SettingsNav";
import SaveBar from "./SaveBar";
import { FIELD_LABELS } from "./fieldLabels";
import { GROUPS, GROUP_IDS, DEFAULT_GROUP } from "./groups";
import { DAY_KEYS, MODULE_TASKS, AFTER_HOURS_POLICIES, TRANSFER_POLICIES } from "./constants";
import "./Settings.css";

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

// Deep link, so "open your Capabilities settings" can be a link rather than a
// list of directions. replaceState rather than a route: settings is a tab
// inside App.jsx, not a router destination, and pushing history here would
// make Back walk group-by-group out of the page.
function groupFromLocation() {
  if (typeof window === "undefined") return DEFAULT_GROUP;
  const requested = new URLSearchParams(window.location.search).get("section");
  return GROUP_IDS.includes(requested) ? requested : DEFAULT_GROUP;
}

export default function SettingsPage({
  business,
  businessId,
  onBusinessUpdate,
  onDirtyChange,
  // Billing & Integrations. The data and its handlers stay owned by App.jsx —
  // only the markup moved here, so these panels could join the group rail
  // instead of floating above and below the page in a different visual style.
  usage,
  usageLoading,
  usageError,
  planName,
  billingStatus,
  calendarConnected,
  calendarLoading,
  calendarSyncing,
  onCalendarSync,
  onCalendarDisconnect,
  onCalendarConnect,
  t,
}) {
  const [baseline, setBaseline] = useState(() => snapshotFromBusiness(business));
  const [draft, setDraft] = useState(() => snapshotFromBusiness(business));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  const [activeGroup, setActiveGroup] = useState(groupFromLocation);
  const [capabilityCounts, setCapabilityCounts] = useState(null);
  const [knowledgeCount, setKnowledgeCount] = useState(null);
  // Which capabilities are on, known page-wide — not just while the
  // Capabilities group is mounted. Sections in *other* groups depend on this:
  // After-hours hides "book for later" without appointments, and Notifications
  // only promises appointment alerts when appointments are on. Fetched once
  // here, then kept live by CapabilitiesSection via onCapabilityEnabledChange.
  const [capEnabled, setCapEnabled] = useState({});
  const panelRef = useRef(null);
  // Set once focus should follow a group change — not on first render, where
  // stealing focus from wherever the user was is hostile.
  const shouldFocusPanel = useRef(false);

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

  // Learn the enabled capabilities up front so cross-group gating works on
  // first paint, before the Capabilities group has ever been opened. Core
  // capabilities read as enabled; everything else follows its stored row.
  useEffect(() => {
    if (!businessId) return undefined;
    let cancelled = false;
    api
      .get(`/api/business/${businessId}/capabilities`)
      .then((res) => {
        if (cancelled) return;
        const map = {};
        for (const c of res.data.capabilities || []) map[c.capability_id] = c.enabled;
        setCapEnabled(map);
      })
      .catch(() => {
        /* gating just stays at defaults if this fails; never blocks the page */
      });
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  const appointmentsEnabled = !!capEnabled.appointments;

  const changed = useMemo(() => diffSnapshots(draft, baseline), [draft, baseline]);
  const changedKeys = useMemo(() => Object.keys(changed), [changed]);
  const dirty = changedKeys.length > 0;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Which rail entries get an unsaved dot.
  const dirtyGroups = useMemo(() => {
    const groups = new Set();
    for (const key of changedKeys) {
      const group = FIELD_LABELS[key]?.group;
      if (group) groups.add(group);
    }
    return groups;
  }, [changedKeys]);

  // Rail navigation (click, arrow keys): selection changes, focus stays where
  // the tablist put it — that's what lets ArrowDown/Up keep walking the rail.
  const goToGroup = useCallback((id) => {
    setActiveGroup(id);
  }, []);

  // Jump from the save-bar popover: the user is navigating out of a menu and
  // wants to land IN the group's content, so here — and only here — focus
  // follows into the panel.
  const jumpToGroup = useCallback((id) => {
    shouldFocusPanel.current = true;
    setActiveGroup(id);
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("section", activeGroup);
    window.history.replaceState({}, "", url);

    if (shouldFocusPanel.current) {
      shouldFocusPanel.current = false;
      panelRef.current?.focus();
    }
  }, [activeGroup]);

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

  // Live captions for the rail, so a group says what is in it before you open
  // it. Falls back to the static caption until the count is known.
  const captions = useMemo(() => {
    const out = {};
    if (capabilityCounts) {
      out.capabilities = `${capabilityCounts.on} of ${capabilityCounts.total} turned on`;
    }
    if (knowledgeCount != null) {
      out.knowledge = knowledgeCount === 1 ? "1 answer saved" : `${knowledgeCount} answers saved`;
    }
    const langs = draft.languages_spoken?.length || 0;
    if (langs) out.voice = langs === 1 ? "1 language" : `${langs} languages`;
    return out;
  }, [capabilityCounts, knowledgeCount, draft.languages_spoken]);

  const group = GROUPS.find((g) => g.id === activeGroup) || GROUPS[0];

  // The transfer capability is core (always registered), but "always on" reads
  // as a lie when the policy is "never". The badge reflects the policy the
  // owner actually set. Passed into the transfer card via extras so the schema
  // renderer never has to know which capability this is.
  const transferBadge =
    draft.transfer_policy === "never" ? (
      <span className="set-pill">Won't transfer</span>
    ) : draft.transfer_policy === "business_hours_only" ? (
      <span className="set-pill set-pill-locked">Business hours only</span>
    ) : (
      <span className="set-pill set-pill-on">On</span>
    );

  // Calendar sync only means something once appointments exist, so it lives
  // inside the appointments card rather than off in Billing.
  const calendarNode = (
    <CalendarSection
      connected={calendarConnected}
      loading={calendarLoading}
      syncing={calendarSyncing}
      onSync={onCalendarSync}
      onDisconnect={onCalendarDisconnect}
      onConnect={onCalendarConnect}
      t={t}
    />
  );

  return (
    <div className="set-root">
      <SaveBar
        dirtyKeys={changedKeys}
        saving={saving}
        error={error}
        saved={!!savedMessage}
        onSave={handleSave}
        onJump={jumpToGroup}
      />

      <div className="set-body">
        <SettingsNav active={activeGroup} onChange={goToGroup} dirtyGroups={dirtyGroups} captions={captions} />

        <div
          className="set-group"
          role="tabpanel"
          id={`set-panel-${group.id}`}
          aria-labelledby={`set-tab-${group.id}`}
          tabIndex={-1}
          ref={panelRef}
        >
          <div className="set-group-head">
            <h2 className="set-group-title">{group.title}</h2>
            <p className="set-group-desc">{group.description}</p>
          </div>

          {activeGroup === "general" ? (
            <>
              <BusinessInfoSection value={draft} onChange={patch} phoneNumber={business?.phone_number} />
              <BusinessHoursEditor value={draft} onChange={patch} />
              <AfterHoursSection value={draft} onChange={patch} appointmentsEnabled={appointmentsEnabled} />
            </>
          ) : null}

          {activeGroup === "voice" ? (
            <>
              <VoicePickerSection value={draft} onChange={patch} />
              <AIBehaviorSection value={draft} onChange={patch} />
              <LanguagesSection value={draft} onChange={patch} />
            </>
          ) : null}

          {/* Capability settings live in their own table (business_capabilities),
              not on the businesses row, so this section loads and saves itself
              rather than joining the draft/diff flow above. Each card saves
              independently: a validation error in one must not discard edits in
              another. It replaces the old Tasks checkboxes, which could say THAT a
              business books appointments but never HOW.

              Transfer policy/number and calendar sync DO belong elsewhere (the
              page draft and the dashboard's own OAuth flow), but they are
              meaningless read apart from their capability — so they are rendered
              inside that capability's card via `extras`, an { node, badge } map
              keyed by capability id. The renderer stays generic (it only asks
              "is there an override for this id?"); the one coupling lives here,
              where deciding what sits next to what is already this file's job. */}
          {activeGroup === "capabilities" ? (
            <CapabilitiesSection
              businessId={businessId}
              onCountsChange={setCapabilityCounts}
              onEnabledChange={setCapEnabled}
              extras={{
                transfer: { node: <TransferRulesSection value={draft} onChange={patch} />, badge: transferBadge },
                appointments: { node: calendarNode },
              }}
            />
          ) : null}

          {activeGroup === "knowledge" ? (
            <KnowledgeBaseEditor businessId={businessId} onCountChange={setKnowledgeCount} />
          ) : null}

          {activeGroup === "notifications" ? (
            <NotificationsSection value={draft} onChange={patch} appointmentsEnabled={appointmentsEnabled} />
          ) : null}

          {activeGroup === "billing" ? (
            <AccountSection
              usage={usage}
              usageLoading={usageLoading}
              usageError={usageError}
              planName={planName}
              billingStatus={billingStatus}
              phoneNumber={business?.phone_number}
              t={t}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

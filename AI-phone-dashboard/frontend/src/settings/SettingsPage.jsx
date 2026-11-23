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
import SettingsNav from "./SettingsNav";
import SaveBar from "./SaveBar";
import { FIELD_LABELS } from "./fieldLabels";
import { GROUPS, GROUP_IDS, DEFAULT_GROUP } from "./groups";
import { useBusinessDraft } from "./useBusinessDraft";
import "./Settings.css";

// `groups` limits the page to some of GROUPS (the new shell shows only what the
// Voice agent tab does not own: Notifications and Usage & number).
function groupFromLocation(allowed = GROUP_IDS) {
  if (typeof window === "undefined") return allowed.includes(DEFAULT_GROUP) ? DEFAULT_GROUP : allowed[0];
  const requested = new URLSearchParams(window.location.search).get("section");
  return allowed.includes(requested) ? requested : allowed.includes(DEFAULT_GROUP) ? DEFAULT_GROUP : allowed[0];
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
  groups,
}) {
  const shownGroups = groups?.length ? GROUPS.filter((g) => groups.includes(g.id)) : GROUPS;
  const shownIds = shownGroups.map((g) => g.id);
  const { draft, changedKeys, dirty, patch, save, saving, error, savedMessage } = useBusinessDraft({
    business,
    businessId,
    onBusinessUpdate,
  });
  const [activeGroup, setActiveGroup] = useState(() => groupFromLocation(shownIds));
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

  // The draft, Save and the reset when the business changes live in
  // useBusinessDraft (shared with the Voice agent tab).

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
    // Keep the router's own history state: replacing it with {} broke the
    // index the unsaved-changes guard relies on for the Back button.
    window.history.replaceState(window.history.state, "", url);

    if (shouldFocusPanel.current) {
      shouldFocusPanel.current = false;
      panelRef.current?.focus();
    }
  }, [activeGroup]);

  const handleSave = async () => {
    await save();
  };

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

  const group = shownGroups.find((g) => g.id === activeGroup) || shownGroups[0];

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
        <SettingsNav groups={shownGroups} active={activeGroup} onChange={goToGroup} dirtyGroups={dirtyGroups} captions={captions} />

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

              Transfer policy/number DOES belong elsewhere (the page draft), but
              it is meaningless read apart from its capability — so it renders
              inside that capability's card via `extras`, an { node, badge } map
              keyed by capability id. The renderer stays generic (it only asks
              "is there an override for this id?"); the one coupling lives here,
              where deciding what sits next to what is already this file's job.

              A1.1 removed the second `extras` entry (Google Calendar sync on the
              appointments card). The mechanism is still worth its generality —
              it is how anything page-owned reaches a capability card. */}
          {activeGroup === "capabilities" ? (
            <CapabilitiesSection
              businessId={businessId}
              onCountsChange={setCapabilityCounts}
              onEnabledChange={setCapEnabled}
              extras={{
                transfer: { node: <TransferRulesSection value={draft} onChange={patch} />, badge: transferBadge },
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
              phoneNumber={business?.phone_number}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

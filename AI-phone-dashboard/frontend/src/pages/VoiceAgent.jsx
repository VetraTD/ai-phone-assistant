import { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { useBusiness } from "../shell/BusinessContext";
import { useUnsavedChangesGuard } from "../shell/useUnsavedChangesGuard";
import DraftSaveBar from "../shell/DraftSaveBar";
import { useBusinessDraft } from "../settings/useBusinessDraft";
import { CapabilityPanel } from "../settings/CapabilitiesSection";
import AIBehaviorSection from "../settings/AIBehaviorSection";
import VoicePickerSection from "../settings/VoicePickerSection";
import LanguagesSection from "../settings/LanguagesSection";
import BusinessInfoSection from "../settings/BusinessInfoSection";
import BusinessHoursEditor from "../settings/BusinessHoursEditor";
import AfterHoursSection from "../settings/AfterHoursSection";
import KnowledgeBaseEditor from "../settings/KnowledgeBaseEditor";
import TransferRulesSection from "../settings/TransferRulesSection";
import { TRANSFER_POLICIES } from "../settings/constants";
import { buildSections, DEFAULT_ITEM, DEFAULT_SECTION } from "./voiceAgent/items";
import { formatPhone } from "./voiceAgent/formatPhone";
import "../settings/Settings.css";
import "./voiceAgent/voice-agent.css";

// Panels a pack asks for by name (its `dashboardPanel` property), for settings
// that live on the business row rather than the pack's own config.
const PACK_PANELS = { transferRules: TransferRulesSection };

const TOGGLE_ERROR = "Couldn't change that. Check your connection, then try again.";
const ACTIONS_ERROR = "Couldn't load your actions. Check your connection, then refresh the page.";

function policyLabel(key) {
  return TRANSFER_POLICIES.find((p) => p.key === key)?.label || "";
}

/**
 * The Voice agent tab (spec §8): what the agent says, what it knows about the
 * business, and what it can do on a call. Text settings use one draft with
 * Save and Discard; switching an action on or off applies at once; an action's
 * own settings and each question-and-answer save themselves.
 */
export default function VoiceAgent() {
  const params = useParams();
  const navigate = useNavigate();
  const { business, businessId, setBusiness, definitions, capabilityRows, capabilitiesStatus, reloadCapabilities } =
    useBusiness();
  // Actions switched during this visit stay listed even if now off.
  const [touched, setTouched] = useState(() => new Set());
  const sections = buildSections(definitions, capabilityRows, touched);
  const hasItem = !!params.item;
  const sectionId = params.section || DEFAULT_SECTION;
  const section = sections.find((s) => s.id === sectionId) || sections[0];
  const item =
    section.items.find((i) => i.id === (params.item || (params.section ? section.items[0]?.id : DEFAULT_ITEM))) ||
    section.items[0];

  const { draft, changedKeys, dirty, patch, discard, save, saving, error, savedMessage } = useBusinessDraft({
    business,
    businessId,
    onBusinessUpdate: (updated) => setBusiness((prev) => ({ ...(prev || {}), ...updated })),
  });

  // An action's settings and a half-written answer keep their own drafts, which
  // opening another item or leaving the tab would lose: those ask first.
  const [panelDirty, setPanelDirty] = useState(false);
  const onPanelDirty = useCallback((d) => setPanelDirty(!!d), []);
  const leaveDialog = useUnsavedChangesGuard(dirty || panelDirty, {
    stayWithin: panelDirty ? undefined : "/voice-agent",
  });

  const rows = new Map((capabilityRows || []).map((r) => [r.capability_id, r]));
  const appointmentsOn = (definitions?.capabilities || []).some(
    (d) => d.adapterKind === "scheduling" && rows.get(d.id)?.enabled
  );

  const [toggling, setToggling] = useState(null);
  const [toggleError, setToggleError] = useState("");
  const [copied, setCopied] = useState(false);

  // Opening an item moves focus to it (on a phone the list it came from is gone).
  const panelRef = useRef(null);
  const itemKey = `${section.id}/${item?.id}`;
  const firstItem = useRef(itemKey);
  useEffect(() => {
    if (itemKey === firstItem.current) return;
    firstItem.current = itemKey;
    panelRef.current?.focus();
  }, [itemKey]);

  const toggle = async (def) => {
    if (toggling) return;
    const current = rows.get(def.id) || {};
    setToggling(def.id);
    setToggleError("");
    setTouched((prev) => new Set(prev).add(def.id));
    try {
      // Only the on/off changes. The action's settings go back as stored; the
      // booking system's connection settings are left for the server to keep.
      await api.put(`/api/business/${businessId}/capabilities/${def.id}`, {
        enabled: !current.enabled,
        adapter: current.adapter ?? null,
        config: current.config ?? {},
      });
      await reloadCapabilities?.();
    } catch (err) {
      setToggleError(err?.response?.data?.error || TOGGLE_ERROR);
    } finally {
      setToggling(null);
    }
  };

  const number = business?.phone_number || "";
  const copyNumber = async () => {
    try {
      await navigator.clipboard?.writeText(number);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      /* the number is on screen to copy by hand */
    }
  };

  function renderPanel() {
    if (!item) return null;
    if (section.id === "voice") {
      if (["greeting", "tone", "rules"].includes(item.id)) return <AIBehaviorSection value={draft} onChange={patch} only={item.id} />;
      if (item.id === "voice") return <VoicePickerSection value={draft} onChange={patch} />;
      return <LanguagesSection value={draft} onChange={patch} only={item.id === "notice" ? "notice" : "languages"} />;
    }
    if (section.id === "info") {
      if (item.id === "details") return <BusinessInfoSection value={draft} onChange={patch} phoneNumber={number} />;
      if (item.id === "hours") return <BusinessHoursEditor value={draft} onChange={patch} />;
      if (item.id === "closed") return <AfterHoursSection value={draft} onChange={patch} appointmentsEnabled={appointmentsOn} />;
      return <KnowledgeBaseEditor businessId={businessId} onDirtyChange={onPanelDirty} />;
    }
    const def = item.def;
    const Extra = def?.dashboardPanel ? PACK_PANELS[def.dashboardPanel] : null;
    return (
      <CapabilityPanel
        key={def.id}
        def={def}
        adapters={definitions?.adapters || {}}
        row={rows.get(def.id)}
        businessId={businessId}
        hideEnabledToggle
        onDirtyChange={onPanelDirty}
        onSaved={() => reloadCapabilities?.()}
        extra={
          Extra
            ? {
                node: <Extra value={draft} onChange={patch} />,
                badge: <span className="set-pill">{policyLabel(draft.transfer_policy)}</span>,
              }
            : undefined
        }
      />
    );
  }

  const saveMessage = error
    ? error
    : dirty
      ? `${changedKeys.length} unsaved ${changedKeys.length === 1 ? "change" : "changes"}`
      : savedMessage
        ? "Saved. It applies from the next call."
        : "";

  return (
    <div className={`vt-va${hasItem ? " vt-va-has-item" : ""}`}>
      <header className="vt-va-head">
        <h1>Voice agent</h1>
        <p>
          {`To try a change, call ${formatPhone(number)}. Saved changes apply from the next call.`}{" "}
          <button type="button" className="vt-link" onClick={copyNumber}>
            Copy number
          </button>
          <span role="status" className="vt-va-copied">
            {copied ? "Copied" : ""}
          </span>
        </p>
      </header>

      <nav className="vt-va-list" aria-label="Voice agent settings">
        {sections.map((s) => (
          <section key={s.id} className="vt-va-sec">
            <h2 id={`vt-va-${s.id}`}>{s.label}</h2>
            {s.id === "actions" && capabilitiesStatus === "error" ? <p className="vt-va-error">{ACTIONS_ERROR}</p> : null}
            <ul aria-label={s.label}>
              {s.items.map((i) => {
                const def = i.def;
                const row = def ? rows.get(def.id) : null;
                const selected = s.id === section.id && i.id === item?.id;
                const showsPolicy = def?.dashboardPanel === "transferRules";
                return (
                  <li key={i.id} className={`vt-va-row${selected ? " vt-va-row-sel" : ""}`}>
                    <NavLink to={`/voice-agent/${s.id}/${i.id}`} className="vt-va-link" aria-current={selected ? "page" : undefined}>
                      <span className="vt-va-name">{i.label}</span>
                    </NavLink>
                    {showsPolicy ? (
                      <span className="vt-va-always">{policyLabel(draft.transfer_policy)}</span>
                    ) : def ? (
                      def.core ? (
                        <span className="vt-va-always">Always on</span>
                      ) : (
                        <button
                          type="button"
                          role="switch"
                          aria-checked={!!row?.enabled}
                          aria-label={i.label}
                          aria-disabled={toggling === def.id || undefined}
                          className={`vt-switch${row?.enabled ? " vt-switch-on" : ""}`}
                          onClick={() => toggle(def)}
                        >
                          <span className="vt-sr-only">{row?.enabled ? "On" : "Off"}</span>
                        </button>
                      )
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        <div role="status" aria-live="polite" className="vt-inline-error">
          {toggleError ? <p>{toggleError}</p> : null}
        </div>
      </nav>

      <section className="vt-va-panel" aria-label={item?.label || "Setting"} tabIndex={-1} ref={panelRef}>
        <Link
          className="vt-pback"
          to="/voice-agent"
          onClick={(e) => {
            if (window.history.state?.idx > 0) {
              e.preventDefault();
              navigate(-1);
            }
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="m15 6-6 6 6 6" />
          </svg>
          Voice agent
        </Link>
        <div className="set-root vt-va-set">{renderPanel()}</div>
      </section>

      <DraftSaveBar message={saveMessage} dirty={dirty} saving={saving} onSave={save} onDiscard={discard} />
      {leaveDialog}
    </div>
  );
}

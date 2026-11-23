import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { currentUser, sendPasswordReset, signOut } from "../auth";
import { useBusiness } from "../shell/BusinessContext";
import { useUnsavedChangesGuard } from "../shell/useUnsavedChangesGuard";
import DraftSaveBar from "../shell/DraftSaveBar";
import { useBusinessDraft } from "../settings/useBusinessDraft";
import NotificationsSection from "../settings/NotificationsSection";
import Panel from "../settings/Panel";
import { formatPhone } from "../calls/format";
import { DEFAULT_SETTINGS_ITEM, SETTINGS_ITEMS } from "./settings/items";
import "../settings/Settings.css";
import "./voiceAgent/voice-agent.css";
import "./settings/settings-page.css";

const USAGE_ERROR = "Couldn't load your usage. Check your connection, then try again.";
const RESET_ERROR = "Couldn't send the link. Try again in a minute.";

/**
 * Settings (spec §8): where alerts go, the number callers reach, the login,
 * this month's usage and help. The Voice agent's list-and-panel layout; only
 * the alert address and its switch are a draft with Save and Discard.
 */
export default function Settings() {
  const params = useParams();
  const navigate = useNavigate();
  const { business, businessId, setBusiness, definitions, capabilityRows } = useBusiness();
  const hasItem = !!params.item;
  const item = SETTINGS_ITEMS.find((i) => i.id === (params.item || DEFAULT_SETTINGS_ITEM)) || SETTINGS_ITEMS[0];

  const { draft, changedKeys, dirty, patch, discard, save, saving, error, savedMessage } = useBusinessDraft({
    business,
    businessId,
    onBusinessUpdate: (updated) => setBusiness((prev) => ({ ...(prev || {}), ...updated })),
  });
  const leaveDialog = useUnsavedChangesGuard(dirty, { stayWithin: "/settings" });

  // Alerts about bookings are promised only to a business that books.
  const rows = new Map((capabilityRows || []).map((r) => [r.capability_id, r]));
  const bookingsOn = (definitions?.capabilities || []).some((d) => d.adapterKind === "scheduling" && rows.get(d.id)?.enabled);

  // Opening an item moves focus to it (on a phone the list it came from is gone).
  const panelRef = useRef(null);
  const firstItem = useRef(item.id);
  useEffect(() => {
    if (item.id === firstItem.current) return;
    firstItem.current = item.id;
    panelRef.current?.focus();
  }, [item.id]);

  const saveMessage = error
    ? error
    : dirty
      ? `${changedKeys.length} unsaved ${changedKeys.length === 1 ? "change" : "changes"}`
      : savedMessage
        ? "Saved."
        : "";

  function renderPanel() {
    if (item.id === "alerts") return <NotificationsSection value={draft} onChange={patch} appointmentsEnabled={bookingsOn} />;
    if (item.id === "number") return <NumberPanel number={business?.phone_number || ""} />;
    if (item.id === "login") return <LoginPanel />;
    if (item.id === "usage") return <UsagePanel />;
    return <HelpPanel />;
  }

  return (
    <div className={`vt-va vt-set${hasItem ? " vt-va-has-item" : ""}`}>
      <header className="vt-va-head">
        <h1>Settings</h1>
      </header>

      <nav className="vt-va-list" aria-label="Settings">
        <ul aria-label="Settings" className="vt-set-items">
          {SETTINGS_ITEMS.map((i) => {
            const selected = i.id === item.id;
            return (
              <li key={i.id} className={`vt-va-row${selected ? " vt-va-row-sel" : ""}`}>
                <NavLink to={`/settings/${i.id}`} className="vt-va-link" aria-current={selected ? "page" : undefined}>
                  <span className="vt-va-name">{i.label}</span>
                </NavLink>
              </li>
            );
          })}
        </ul>
        <div className="vt-set-signout">
          <button type="button" className="vt-btn vt-btn-quiet" onClick={() => signOut()}>
            Sign out
          </button>
        </div>
      </nav>

      <section className="vt-va-panel" aria-label={item.label} tabIndex={-1} ref={panelRef}>
        <Link
          className="vt-pback"
          to="/settings"
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
          Settings
        </Link>
        <div className="set-root vt-va-set">{renderPanel()}</div>
      </section>

      <DraftSaveBar message={saveMessage} dirty={dirty} saving={saving} onSave={save} onDiscard={discard} />
      {leaveDialog}
    </div>
  );
}

function NumberPanel({ number }) {
  const [copied, setCopied] = useState(false);
  const copyNumber = async () => {
    try {
      await navigator.clipboard?.writeText(number);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      /* the number is on screen to copy by hand */
    }
  };
  return (
    <Panel title="Your number" description="The number your callers reach VetraTD on.">
      {number ? (
        <p className="vt-set-figure vt-num">
          {formatPhone(number)}{" "}
          <button type="button" className="vt-link" onClick={copyNumber}>
            Copy number
          </button>
          <span role="status" className="vt-va-copied">
            {copied ? "Copied" : ""}
          </span>
        </p>
      ) : null}
      <p className="vt-set-text">
        Callers reach VetraTD on this number. If your own business number forwards here, calls ring through the way we
        set up together. To change how calls reach us, <Link to="/contact">message us</Link>.
      </p>
    </Panel>
  );
}

function LoginPanel() {
  const email = currentUser()?.email || "";
  const [state, setState] = useState({ kind: "idle" });
  async function sendLink() {
    if (!email || state.kind === "sending") return;
    setState({ kind: "sending" });
    const { error } = await sendPasswordReset(email);
    setState(error ? { kind: "error" } : { kind: "sent" });
  }
  return (
    <Panel title="Your login" description="The email you sign in with.">
      {email ? <p className="vt-set-figure">{email}</p> : null}
      <p>
        <button type="button" className="vt-btn vt-btn-quiet" onClick={sendLink} aria-disabled={!email || state.kind === "sending" || undefined}>
          Email me a link to change my password
        </button>
      </p>
      <div role="status" aria-live="polite" className="vt-set-status">
        {state.kind === "sent" ? <p>{`We've sent a link to ${email}. Open it to choose a new password.`}</p> : null}
        {state.kind === "error" ? <p className="vt-set-warn">{RESET_ERROR}</p> : null}
      </div>
    </Panel>
  );
}

function UsagePanel() {
  const [usage, setUsage] = useState({ status: "loading", data: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api
      .get("/api/usage")
      .then((res) => {
        if (!cancelled) setUsage({ status: "ready", data: res.data });
      })
      .catch(() => {
        if (!cancelled) setUsage({ status: "error", data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <Panel title="Usage" description="Counts from the 1st, in your business's time zone.">
      {usage.status === "loading" ? <p role="status">Loading your usage…</p> : null}
      {usage.status === "error" ? (
        <div className="vt-set-status">
          <p className="vt-set-warn">{USAGE_ERROR}</p>
          <button
            type="button"
            className="vt-btn vt-btn-quiet"
            onClick={() => {
              setUsage({ status: "loading", data: null });
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </div>
      ) : null}
      {usage.status === "ready" ? (
        <dl className="vt-set-usage">
          <div>
            <dt>Minutes used this month</dt>
            <dd className="vt-num">{Number(usage.data?.minutes_this_month ?? 0).toLocaleString("en-GB")}</dd>
          </div>
          <div>
            <dt>Calls answered this month</dt>
            <dd className="vt-num">{Number(usage.data?.calls_this_month ?? 0).toLocaleString("en-GB")}</dd>
          </div>
        </dl>
      ) : null}
      <p>
        <Link className="vt-link vt-set-inline" to="/trends">
          See call trends
        </Link>
      </p>
    </Panel>
  );
}

function HelpPanel() {
  return (
    <Panel title="Help" description="How VetraTD works.">
      <ul className="vt-set-help">
        <li>VetraTD answers your calls, takes messages and call-back requests, and books appointments if you have bookings switched on.</li>
        <li>When a call needs you, we email your alert address straight after the call.</li>
        <li>Changes you save under Voice agent apply from the next call.</li>
      </ul>
      <p>
        Something else? <Link to="/contact">Message us</Link>.
      </p>
    </Panel>
  );
}

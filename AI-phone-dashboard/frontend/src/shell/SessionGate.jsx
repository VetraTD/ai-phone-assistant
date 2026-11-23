import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { onAuthChange, signOut } from "../auth";
import { useIdleLogout } from "../useIdleLogout";
import Login from "../Login";
import Onboarding from "../Onboarding";
import { BusinessContext } from "./BusinessContext";
import "./tokens.css";
import "./states.css";

const LOAD_ERROR = "We couldn't load your account. Check your connection, then refresh the page.";

function FullScreen({ children }) {
  return (
    <div className="vt-app vt-state">
      <div className="vt-state-card">{children}</div>
    </div>
  );
}

/**
 * Everything between "someone opened the dashboard" and "a page can render":
 * the Identity Platform session, automatic sign-out when idle, the /api/me
 * business, onboarding for a business without a number, and the business's
 * actions (capability definitions and rows). Children render only for a
 * signed-in user whose business is set up, and read all of it through
 * useBusiness().
 */
export default function SessionGate({ children }) {
  const [session, setSession] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [business, setBusiness] = useState(null);
  const [meState, setMeState] = useState("idle"); // idle | loading | ready | error
  const [attempt, setAttempt] = useState(0);
  const [definitions, setDefinitions] = useState(null);
  const [capabilityRows, setCapabilityRows] = useState([]);
  const [openCount, setOpenCount] = useState(0);

  useEffect(
    () =>
      // One subscription: it fires once with the restored user (or null) as soon
      // as Identity Platform has read persisted storage, so there is no window
      // where a signed-in person sees the sign-in screen.
      onAuthChange((user) => {
        setSession(user || null);
        setCheckingSession(false);
      }),
    []
  );

  // HIPAA 164.312(a)(2)(iii) automatic logoff: an unattended front-desk browser
  // must not stay signed in overnight in front of patient records.
  const idle = useIdleLogout({
    enabled: !!session,
    onLogout: async () => {
      await signOut();
    },
  });

  useEffect(() => {
    if (!session) {
      setBusiness(null);
      setMeState("idle");
      setDefinitions(null);
      setCapabilityRows([]);
      setOpenCount(0);
      return;
    }
    let cancelled = false;
    setMeState("loading");
    api
      .get("/api/me")
      .then((res) => {
        if (cancelled) return;
        setBusiness(res.data?.business || null);
        setMeState("ready");
      })
      .catch(() => {
        if (!cancelled) setMeState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [session, attempt]);

  const businessId = business?.id || null;
  const setUp = !!business?.phone_number;

  const reloadCapabilities = useCallback(async () => {
    if (!businessId) return;
    try {
      const [defs, rows] = await Promise.all([
        api.get("/api/capabilities/definitions"),
        api.get(`/api/business/${businessId}/capabilities`),
      ]);
      setDefinitions(defs.data);
      setCapabilityRows(Array.isArray(rows.data?.capabilities) ? rows.data.capabilities : []);
    } catch {
      // Pages that need these say so themselves; the shell still works.
      setDefinitions(null);
      setCapabilityRows([]);
    }
  }, [businessId]);

  useEffect(() => {
    if (setUp) reloadCapabilities();
  }, [setUp, reloadCapabilities]);

  const value = useMemo(
    () => ({
      business,
      businessId,
      setBusiness,
      definitions,
      capabilityRows,
      reloadCapabilities,
      openCount,
      setOpenCount,
    }),
    [business, businessId, definitions, capabilityRows, reloadCapabilities, openCount]
  );

  if (checkingSession) {
    return (
      <FullScreen>
        <p role="status">Checking your sign-in…</p>
      </FullScreen>
    );
  }

  // Sign-up is closed: onboarding is concierge until an invite token exists
  // (see Login.jsx), so a signed-out visitor only ever gets the sign-in screen.
  if (!session) return <Login />;

  if (meState === "error") {
    return (
      <FullScreen>
        <h1 className="vt-state-title">Your account didn't load</h1>
        <p className="vt-state-text">{LOAD_ERROR}</p>
        <div className="vt-state-actions">
          <button type="button" className="vt-btn vt-btn-primary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
          <button
            type="button"
            className="vt-btn vt-btn-quiet"
            onClick={async () => {
              await signOut();
            }}
          >
            Sign out
          </button>
        </div>
      </FullScreen>
    );
  }

  if (meState !== "ready") {
    return (
      <FullScreen>
        <p role="status">Loading your calls…</p>
      </FullScreen>
    );
  }

  if (!setUp) {
    return (
      <Onboarding
        existingBusiness={business && !business.phone_number ? business : null}
        onBack={() => signOut()}
        onComplete={(biz) => setBusiness(biz)}
      />
    );
  }

  return (
    <BusinessContext.Provider value={value}>
      {idle.warning ? (
        <div className="vt-app vt-idle" role="alert" aria-live="assertive">
          <span>
            {`You will be signed out in ${Math.floor(idle.secondsRemaining / 60)}:${String(
              idle.secondsRemaining % 60
            ).padStart(2, "0")} for security.`}
          </span>
          <button type="button" className="vt-btn vt-btn-primary" onClick={idle.stayActive}>
            Stay signed in
          </button>
        </div>
      ) : null}
      {children}
    </BusinessContext.Provider>
  );
}

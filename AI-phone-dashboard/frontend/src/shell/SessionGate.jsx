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

async function fetchCapabilities(businessId) {
  try {
    const [defs, rows] = await Promise.all([
      api.get("/api/capabilities/definitions"),
      api.get(`/api/business/${businessId}/capabilities`),
    ]);
    return {
      status: "ready",
      definitions: defs.data,
      capabilityRows: Array.isArray(rows.data?.capabilities) ? rows.data.capabilities : [],
    };
  } catch {
    // Pages that need these say so themselves (capabilitiesStatus "error");
    // the shell still works.
    return { status: "error", definitions: null, capabilityRows: [] };
  }
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

  return (
    <>
      {idle.warning ? (
        <div className="vt-app vt-idle">
          {/* Said in whole minutes, so a screen reader hears it once a minute
              at most; the ticking clock beside it is for the eye only. */}
          <span role="alert">{signedOutIn(idle.secondsRemaining)}</span>
          <span className="vt-num vt-idle-clock" aria-hidden="true">
            {`${Math.floor(idle.secondsRemaining / 60)}:${String(idle.secondsRemaining % 60).padStart(2, "0")}`}
          </span>
          <button type="button" className="vt-btn vt-btn-primary" onClick={idle.stayActive}>
            Stay signed in
          </button>
        </div>
      ) : null}
      {/* Keyed by the account, so signing out or switching account starts clean. */}
      <SignedIn key={session.uid || session.id || "signed-in"}>{children}</SignedIn>
    </>
  );
}

function signedOutIn(seconds) {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `You will be signed out in ${minutes} ${minutes === 1 ? "minute" : "minutes"} for security.`;
}

function SignedIn({ children }) {
  const [me, setMe] = useState({ status: "loading", business: null });
  const [attempt, setAttempt] = useState(0);
  const [caps, setCaps] = useState({ status: "loading", definitions: null, capabilityRows: [] });
  const [openCount, setOpenCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .get("/api/me")
      .then((res) => {
        if (!cancelled) setMe({ status: "ready", business: res.data?.business || null });
      })
      .catch(() => {
        if (!cancelled) setMe({ status: "error", business: null });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const business = me.business;
  const businessId = business?.id || null;
  const setUp = !!business?.phone_number;

  useEffect(() => {
    if (!setUp || !businessId) return undefined;
    let cancelled = false;
    fetchCapabilities(businessId).then((next) => {
      if (!cancelled) setCaps(next);
    });
    return () => {
      cancelled = true;
    };
  }, [setUp, businessId]);

  const reloadCapabilities = useCallback(async () => {
    if (businessId) setCaps(await fetchCapabilities(businessId));
  }, [businessId]);

  const setBusiness = useCallback(
    (next) =>
      setMe((prev) => ({
        ...prev,
        business: typeof next === "function" ? next(prev.business) : next,
      })),
    []
  );

  const value = useMemo(
    () => ({
      business,
      businessId,
      setBusiness,
      definitions: caps.definitions,
      capabilityRows: caps.capabilityRows,
      capabilitiesStatus: caps.status,
      reloadCapabilities,
      openCount,
      setOpenCount,
    }),
    [business, businessId, setBusiness, caps, reloadCapabilities, openCount]
  );

  if (me.status === "error") {
    return (
      <FullScreen>
        <h1 className="vt-state-title">Your account didn't load</h1>
        <p className="vt-state-text">{LOAD_ERROR}</p>
        <div className="vt-state-actions">
          <button
            type="button"
            className="vt-btn vt-btn-primary"
            onClick={() => {
              setMe({ status: "loading", business: null });
              setAttempt((n) => n + 1);
            }}
          >
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

  if (me.status !== "ready") {
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
        // Onboarding.jsx calls onComplete() with no argument once the number
        // is bought, so load the business again rather than trust an argument.
        onComplete={() => {
          setMe({ status: "loading", business: null });
          setAttempt((n) => n + 1);
        }}
      />
    );
  }

  return <BusinessContext.Provider value={value}>{children}</BusinessContext.Provider>;
}

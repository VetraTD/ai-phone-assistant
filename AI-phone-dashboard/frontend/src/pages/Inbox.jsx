import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useBusiness } from "../shell/BusinessContext";
import CallList from "./inbox/CallList";
import CallView from "./inbox/CallView";
import CallerPanel from "./inbox/CallerPanel";
import "../shell/states.css";
import "./home.css";
import "./inbox.css";

const LIST_ERROR = "Couldn't load your calls. Check your connection, then try again.";

/**
 * Inbox (spec §8): the list, the call, and the caller. Everything that matters
 * lives in the address: /inbox/:callId selects a call, ?view=all switches from
 * "Needs you", ?q= is the search. So the back button walks through selections
 * and an alert email's link opens the right call.
 */
export default function Inbox() {
  const { callId } = useParams();
  const [params, setParams] = useSearchParams();
  const view = params.get("view") === "all" ? "all" : "open";
  const q = params.get("q") || "";
  const { business, setOpenCount } = useBusiness();
  const tz = business?.timezone || "America/Chicago";

  const [list, setList] = useState({ status: "loading", calls: [] });
  const [listAttempt, setListAttempt] = useState(0);
  const [openTotal, setOpenTotal] = useState(null);
  const [countAttempt, setCountAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .get("/api/calls", { params: { view, ...(q ? { q } : {}), limit: 200 } })
      .then((res) => {
        if (!cancelled) setList({ status: "ready", calls: Array.isArray(res.data?.calls) ? res.data.calls : [] });
      })
      .catch(() => {
        if (!cancelled) setList({ status: "error", calls: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [view, q, listAttempt]);

  // "Needs you (n)" and the navigation badge, whichever view is showing.
  useEffect(() => {
    let cancelled = false;
    api
      .get("/api/calls", { params: { view: "open", limit: 1 } })
      .then((res) => {
        if (cancelled) return;
        const total = Number(res.data?.total) || 0;
        setOpenTotal(total);
        setOpenCount?.(total);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [countAttempt, setOpenCount]);

  // A call's item was marked done or reopened in the call view.
  const onHandledChange = useCallback(
    (id, handled) => {
      setList((l) => ({
        ...l,
        calls:
          handled && view === "open"
            ? l.calls.filter((c) => c.id !== id)
            : l.calls.map((c) => (c.id === id ? { ...c, ...handled } : c)),
      }));
      if (!handled || view === "open") setListAttempt((n) => n + 1);
      setCountAttempt((n) => n + 1);
    },
    [view]
  );

  const setView = (next) => {
    const p = new URLSearchParams(params);
    if (next === "all") p.set("view", "all");
    else p.delete("view");
    setParams(p);
  };
  const setQuery = (text) => {
    const p = new URLSearchParams(params);
    if (text) p.set("q", text);
    else p.delete("q");
    setParams(p, { replace: true });
  };

  return (
    <div className={`vt-inbox${callId ? " vt-inbox-has-call" : ""}`}>
      <CallList
        calls={list.calls}
        status={list.status}
        errorText={LIST_ERROR}
        onRetry={() => setListAttempt((n) => n + 1)}
        view={view}
        onView={setView}
        query={q}
        onQuery={setQuery}
        openTotal={openTotal}
        selectedId={callId}
        search={params.toString()}
        tz={tz}
      />
      {callId ? (
        <CallView key={callId} callId={callId} tz={tz} backSearch={params.toString()} onHandledChange={onHandledChange}>
          {(history) => <CallerPanel history={history} tz={tz} />}
        </CallView>
      ) : (
        <div className="vt-inbox-empty">
          <p>Choose a call to read what was said and done.</p>
        </div>
      )}
    </div>
  );
}

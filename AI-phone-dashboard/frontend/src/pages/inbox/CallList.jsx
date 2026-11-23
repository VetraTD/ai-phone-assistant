import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { buildCallsCsv } from "../../callsCsv";
import { callerLabel, dayHeading, formatTime, localDay } from "../../calls/format";
import { needText } from "../../calls/callStatus";

const SEARCH_DELAY_MS = 300;
const CSV_ERROR = "Couldn't prepare the download. Try again in a minute.";

function downloadCsv(csv, filename) {
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** The line under a caller's name in the list. */
function rowKind(call) {
  const open = call.is_open ?? (call.has_request && !call.handled_at);
  if (open) return { tone: "needs", text: needText({ type: call.request_type }) };
  if (call.has_request) return { tone: "done", text: "Marked done" };
  return null;
}

/**
 * The Inbox list: "Needs you (n)" / "All calls", search, Download calls (CSV),
 * and the calls grouped by day in the business's timezone.
 */
export default function CallList({
  calls,
  status,
  errorText,
  onRetry,
  view,
  onView,
  query,
  onQuery,
  openTotal,
  selectedId,
  search,
  tz,
}) {
  const [text, setText] = useState(query);
  // When the search in the address changes from outside (the Inbox tab, the
  // back button), the box follows it.
  const [shownQuery, setShownQuery] = useState(query);
  const [csvError, setCsvError] = useState("");
  if (query !== shownQuery) {
    setShownQuery(query);
    if (query !== text.trim()) setText(query);
  }
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onType = (value) => {
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onQuery(value.trim()), SEARCH_DELAY_MS);
  };

  const groups = [];
  for (const call of calls) {
    const heading = dayHeading(call.started_at, tz);
    const last = groups[groups.length - 1];
    if (last && last.heading === heading) last.calls.push(call);
    else groups.push({ heading, calls: [call] });
  }

  const suffix = search ? `?${search}` : "";

  return (
    <nav className="vt-ilist" aria-label="Calls">
      <div className="vt-ihead">
        <h1>Inbox</h1>
        <div className="vt-seg" role="group" aria-label="Which calls">
          <button type="button" aria-pressed={!query && view === "open"} onClick={() => onView("open")}>
            {openTotal == null ? "Needs you" : `Needs you (${openTotal})`}
          </button>
          <button type="button" aria-pressed={!!query || view === "all"} onClick={() => onView("all")}>
            All calls
          </button>
        </div>
        <label className="vt-search">
          <span className="vt-sr-only">Search calls</span>
          <input
            type="search"
            aria-label="Search calls"
            placeholder="Search names, numbers or words"
            value={text}
            onChange={(e) => onType(e.target.value)}
          />
        </label>
        {query ? <p className="vt-search-note">Searching all calls.</p> : null}
        <button
          type="button"
          className="vt-link vt-csv"
          disabled={!calls.length}
          onClick={async () => {
            setCsvError("");
            // Recorded in the access log as an export first; a download that
            // cannot be recorded is not made.
            try {
              await api.post("/api/calls/export-record", { ids: calls.map((c) => c.id) });
            } catch {
              setCsvError(CSV_ERROR);
              return;
            }
            const csv = buildCallsCsv(calls);
            if (csv) downloadCsv(csv, `vetratd-calls-${localDay(new Date().toISOString(), tz)}.csv`);
          }}
        >
          Download calls (CSV)
        </button>
        <div role="status" aria-live="polite" className="vt-inline-error">
          {csvError ? <p>{csvError}</p> : null}
        </div>
      </div>

      {status === "error" ? (
        <div className="vt-ilist-state">
          <p>{errorText}</p>
          <button type="button" className="vt-btn vt-btn-quiet" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : status === "loading" ? (
        <p className="vt-ilist-state" role="status">
          Loading calls…
        </p>
      ) : !calls.length ? (
        <p className="vt-ilist-state">
          {query
            ? "No calls match that search."
            : view === "open"
              ? "Nothing needs you right now."
              : "No calls yet."}
        </p>
      ) : (
        groups.map((g) => (
          <section key={g.heading} className="vt-igroup">
            <h2 className="vt-grp">{g.heading}</h2>
            <ul className="vt-irows">
              {g.calls.map((call) => {
                const kind = rowKind(call);
                const selected = call.id === selectedId;
                return (
                  <li key={call.id}>
                    <Link
                      className={`vt-irow${selected ? " vt-irow-sel" : ""}`}
                      to={`/inbox/${call.id}${suffix}`}
                      aria-current={selected ? "true" : undefined}
                    >
                      <span className="vt-irow-top">
                        <span className="vt-nm">{callerLabel({ callerName: call.caller_name_guess, callerNumber: call.caller_number })}</span>
                        <span className="vt-tm vt-num">{formatTime(call.started_at, tz)}</span>
                      </span>
                      {kind ? <span className={`vt-kind vt-kind-${kind.tone}`}>{kind.text}</span> : null}
                      {call.summary ? <span className="vt-ln vt-clamp">{call.summary}</span> : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </nav>
  );
}

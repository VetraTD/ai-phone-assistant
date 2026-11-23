import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { useBusiness } from "../../shell/BusinessContext";
import { calendarAvailable } from "../../shell/nav";
import { callerLabel, formatDateTime, localDay, telHref } from "../../calls/format";
import { didList, statusLine } from "../../calls/callStatus";
import CallOutcomeAnswers from "../../components/CallOutcomeAnswers";

const FIRST_LINES = 4;
const NOT_FOUND = "That call isn't here. The link may be wrong, or the call belongs to another business.";
const LOAD_ERROR = "Couldn't load this call. Check your connection, then try again.";
const DONE_ERROR = "Couldn't mark that as done. Check your connection, then try again.";
const REOPEN_ERROR = "Couldn't reopen that. Check your connection, then try again.";

function lengthText(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return null;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  if (!m) return `${r} sec`;
  return r ? `${m} min ${r} sec` : `${m} min`;
}

function StatusIcon({ tone }) {
  return tone === "done" ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M5 12.5 10 17l9-10" />
    </svg>
  ) : tone === "needs" ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="5" />
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M6 12h12" />
    </svg>
  );
}

/**
 * One call, in one place (spec §8 Inbox): who and when, what is needed, the
 * summary, what VetraTD did, the booking it made, the message, and the whole
 * conversation. Every piece of caller speech or AI text is rendered as text.
 * `children(history)` renders the caller panel.
 */
export default function CallView({ callId, tz, backSearch, onHandledChange, children }) {
  const { definitions, capabilityRows } = useBusiness();
  const [state, setState] = useState({ status: "loading", data: null });
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/api/calls/${callId}`)
      .then((res) => {
        if (!cancelled) setState({ status: "ready", data: res.data });
      })
      .catch((err) => {
        if (!cancelled) setState({ status: err?.response?.status === 404 ? "missing" : "error", data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [callId, attempt]);

  const back = (
    <Link className="vt-pback" to={`/inbox${backSearch ? `?${backSearch}` : ""}`}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="m15 6-6 6 6 6" />
      </svg>
      Inbox
    </Link>
  );

  if (state.status !== "ready") {
    return (
      <div className="vt-idetail">
        {back}
        <div className="vt-db">
          {state.status === "loading" ? (
            <p role="status">Loading the call…</p>
          ) : state.status === "missing" ? (
            <p>{NOT_FOUND}</p>
          ) : (
            <>
              <p>{LOAD_ERROR}</p>
              <button
                type="button"
                className="vt-btn vt-btn-quiet"
                onClick={() => {
                  setState({ status: "loading", data: null });
                  setAttempt((n) => n + 1);
                }}
              >
                Try again
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  const { call, transcript = [], appointments = [], customer_requests: requests = [], caller_history } = state.data;
  const request = requests[0] || null;
  const callerName = request?.caller_name || appointments[0]?.client_name || null;
  const label = callerLabel({ callerName, callerNumber: call.caller_number });
  const callHref = telHref(request?.callback_number) || telHref(call.caller_number);
  const showNumber = callHref && label !== call.caller_number ? call.caller_number : null;
  const line = statusLine({ call, appointments, requests });
  const did = didList({ call, appointments, requests, tz });
  const booking = appointments[0] || null;
  const lines = expanded ? transcript : transcript.slice(0, FIRST_LINES);
  const answers = Array.isArray(request?.details?.answers) ? request.details.answers : [];

  const setHandled = async (done) => {
    setBusy(true);
    setError("");
    try {
      const res = done ? await api.put(`/api/calls/${callId}/handled`) : await api.delete(`/api/calls/${callId}/handled`);
      const handled = { handled_at: res.data?.handled_at ?? null, handled_by: res.data?.handled_by ?? null };
      setState((s) => ({ ...s, data: { ...s.data, call: { ...s.data.call, ...handled } } }));
      onHandledChange?.(callId, done ? handled : null);
    } catch {
      setError(done ? DONE_ERROR : REOPEN_ERROR);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="vt-idetail" aria-labelledby="vt-call-h">
        {back}
        <header className="vt-dh">
          <h2 id="vt-call-h">{label}</h2>
          <p className="vt-meta">
            {showNumber ? <span className="vt-num">{showNumber}</span> : null}
            {call.started_at ? <span>{formatDateTime(call.started_at, tz)}</span> : null}
            {lengthText(call.duration_seconds) ? <span>{lengthText(call.duration_seconds)}</span> : null}
          </p>
          <div className="vt-dacts">
            {callHref ? (
              <a className="vt-btn vt-btn-primary" href={callHref}>
                Call back
              </a>
            ) : null}
            {requests.length ? (
              call.handled_at ? (
                <button type="button" className="vt-btn vt-btn-quiet" disabled={busy} onClick={() => setHandled(false)}>
                  Reopen
                </button>
              ) : (
                <button type="button" className="vt-btn vt-btn-quiet" disabled={busy} onClick={() => setHandled(true)}>
                  Done
                </button>
              )
            ) : null}
          </div>
          <div role="status" aria-live="polite" className="vt-inline-error">
            {error ? <p>{error}</p> : null}
          </div>
        </header>

        <div className="vt-db">
          <p className={`vt-state vt-state-${line.tone}`}>
            <StatusIcon tone={line.tone} />
            <span>{line.text}</span>
          </p>

          {call.summary ? (
            <>
              <h3>Summary</h3>
              <p className="vt-sum">{call.summary}</p>
            </>
          ) : null}

          {request && (request.message || request.preferred_time || answers.length) ? (
            <>
              <h3>{request.request_type === "callback" ? "Their call-back request" : "Their message"}</h3>
              <dl className="vt-msg">
                {request.message ? (
                  <>
                    <dt>Message</dt>
                    <dd>{request.message}</dd>
                  </>
                ) : null}
                {request.preferred_time ? (
                  <>
                    <dt>Best time</dt>
                    <dd>{request.preferred_time}</dd>
                  </>
                ) : null}
                {request.callback_number && request.callback_number !== call.caller_number ? (
                  <>
                    <dt>Number to ring</dt>
                    <dd className="vt-num">{request.callback_number}</dd>
                  </>
                ) : null}
                {answers.map((a, i) => (
                  <div key={i} className="vt-msg-row">
                    <dt>{a.label}</dt>
                    <dd>{a.answer}</dd>
                  </div>
                ))}
              </dl>
            </>
          ) : null}

          {/* Answers the agent recorded on the call (calls.answers), shown as
              plain text; renders nothing for a call that recorded none. */}
          <div className="vt-answers">
            <CallOutcomeAnswers call={call} t={{ outcomeAnswersTitle: "What they told VetraTD" }} />
          </div>

          {did.length ? (
            <>
              <h3>What VetraTD did</h3>
              <ul className="vt-did">
                {did.map((d) => (
                  <li key={d}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                      <path d="M5 12.5 10 17l9-10" />
                    </svg>
                    <span>{d}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {booking && calendarAvailable(definitions, capabilityRows) ? (
            <p className="vt-bkref">
              <span>{`Booking: ${formatDateTime(booking.scheduled_at, tz)}${booking.status === "cancelled" ? " (cancelled)" : ""}`}</span>
              <Link className="vt-link" to={`/calendar?date=${localDay(booking.scheduled_at, tz)}`}>
                See it in the calendar
              </Link>
            </p>
          ) : null}

          <h3>Conversation</h3>
          {transcript.length ? (
            <>
              <dl className="vt-tx">
                {lines.map((l, i) => (
                  <div key={l.sequence ?? i} className="vt-tx-row">
                    <dt className={l.speaker === "ai" ? "vt-who vt-who-ai" : "vt-who"}>{l.speaker === "ai" ? "VetraTD" : "Caller"}</dt>
                    <dd>{l.message}</dd>
                  </div>
                ))}
              </dl>
              {transcript.length > FIRST_LINES ? (
                <button type="button" className="vt-link" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
                  {expanded ? "Show less" : "Show the whole conversation"}
                </button>
              ) : null}
            </>
          ) : (
            <p className="vt-muted">No conversation was saved for this call.</p>
          )}
        </div>
      </section>
      {children ? children(caller_history || { calls: [], bookings: [] }) : null}
    </>
  );
}

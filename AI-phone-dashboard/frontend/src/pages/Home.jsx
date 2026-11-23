import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useBusiness } from "../shell/BusinessContext";
import { callerLabel, dayHeading, formatTime, telHref } from "../calls/format";
import { needText } from "../calls/callStatus";
import "./home.css";

const LOAD_ERROR = "Couldn't load your calls. Check your connection, then try again.";
const DONE_ERROR = "Couldn't mark that as done. Check your connection, then try again.";
const REOPEN_ERROR = "Couldn't reopen that. Check your connection, then try again.";
const EMPTY = "Nothing needs you right now. New calls that need you will show up here, and you'll get an email.";

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function greeting(tz, now = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(now)
  );
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function firstSentence(text) {
  if (typeof text !== "string" || !text.trim()) return "";
  const trimmed = text.trim();
  const end = trimmed.search(/[.!?](\s|$)/);
  return end === -1 ? trimmed : trimmed.slice(0, end + 1);
}

/** The one line under a need: the caller's message, else the summary's first sentence. */
function needLine(item) {
  const message = item.request?.message;
  if (typeof message === "string" && message.trim()) return message.trim();
  return firstSentence(item.summary);
}

/** The line under a done row. */
function doneLine(row) {
  if (row.handledBy) return "Marked done";
  return firstSentence(row.summary) || "No message was left.";
}

function briefSentence(openCount, today) {
  const who = openCount === 0 ? "No callers need you." : `${plural(openCount, "caller needs", "callers need")} you.`;
  return `${who} VetraTD answered ${plural(today.answered, "call", "calls")} today and made ${plural(
    today.bookingsMade,
    "booking",
    "bookings"
  )}.`;
}

const byStartedAsc = (a, b) => new Date(a.startedAt) - new Date(b.startedAt);

/**
 * Home (spec §8): what needs the owner, with Call back and Done on the row;
 * what was done today; today's bookings and the week so far.
 */
export default function Home() {
  const { business, setOpenCount } = useBusiness();
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [attempt, setAttempt] = useState(0);
  const [toast, setToast] = useState("");
  // Every open item this page has seen, so Reopen can put one back as it was.
  const seenOpen = useRef(new Map());

  useEffect(() => {
    let cancelled = false;
    api
      .get("/api/home")
      .then((res) => {
        if (cancelled) return;
        for (const item of res.data.openItems || []) seenOpen.current.set(item.callId, item);
        setData(res.data);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const openItems = data?.openItems || [];
  const openTotal = openItems.length;
  useEffect(() => {
    if (status === "ready") setOpenCount?.(openTotal);
  }, [status, openTotal, setOpenCount]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(""), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  const markDone = useCallback(async (item) => {
    const doneRow = {
      callId: item.callId,
      startedAt: item.startedAt,
      callerNumber: item.callerNumber,
      callerName: item.callerName,
      summary: item.summary,
      status: null,
      handledAt: new Date().toISOString(),
      handledBy: "you",
      hadRequest: true,
    };
    setData((d) => ({
      ...d,
      openItems: d.openItems.filter((i) => i.callId !== item.callId),
      doneToday: [doneRow, ...d.doneToday.filter((r) => r.callId !== item.callId)],
    }));
    try {
      await api.put(`/api/calls/${item.callId}/handled`);
    } catch {
      setData((d) => ({
        ...d,
        openItems: [...d.openItems.filter((i) => i.callId !== item.callId), item].sort(byStartedAsc),
        doneToday: d.doneToday.filter((r) => r.callId !== item.callId),
      }));
      setToast(DONE_ERROR);
    }
  }, []);

  const reopen = useCallback(async (row) => {
    const known = seenOpen.current.get(row.callId);
    setData((d) => ({
      ...d,
      doneToday: d.doneToday.filter((r) => r.callId !== row.callId),
      openItems: known ? [...d.openItems.filter((i) => i.callId !== row.callId), known].sort(byStartedAsc) : d.openItems,
    }));
    try {
      await api.delete(`/api/calls/${row.callId}/handled`);
      // An item marked done before this page loaded: fetch it back with its request.
      if (!known) setAttempt((n) => n + 1);
    } catch {
      setData((d) => ({
        ...d,
        openItems: d.openItems.filter((i) => i.callId !== row.callId),
        doneToday: [row, ...d.doneToday.filter((r) => r.callId !== row.callId)],
      }));
      setToast(REOPEN_ERROR);
    }
  }, []);

  if (status === "error") {
    return (
      <div className="vt-page vt-home-state">
        <p>{LOAD_ERROR}</p>
        <button
          type="button"
          className="vt-btn vt-btn-primary"
          onClick={() => {
            setStatus("loading");
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  if (status !== "ready" || !data) {
    return (
      <p className="vt-page" role="status">
        Loading your calls…
      </p>
    );
  }

  const tz = data.timezone || business?.timezone || "America/Chicago";

  return (
    <div className="vt-home">
      <div className="vt-home-main">
        <h1 className="vt-hello">{greeting(tz)}</h1>
        <p className="vt-brief">{briefSentence(openTotal, data.today)}</p>

        <section className="vt-home-section">
          <div className="vt-sech">
            <h2 id="vt-needs-h">Needs you</h2>
            {openTotal ? <span className="vt-num">{openTotal}</span> : null}
          </div>
          {openTotal ? (
            <ul className="vt-card vt-tasks" aria-labelledby="vt-needs-h">
              {openItems.map((item) => {
                const href = telHref(item.request?.callbackNumber) || telHref(item.callerNumber);
                return (
                  <li key={item.callId} className="vt-task">
                    <span className="vt-when vt-num">
                      {dayHeading(item.startedAt, tz) !== "Today" ? (
                        <span className="vt-when-day">{dayHeading(item.startedAt, tz)}</span>
                      ) : null}
                      {formatTime(item.startedAt, tz)}
                    </span>
                    <Link className="vt-task-body" to={`/inbox/${item.callId}`}>
                      <span className="vt-kind">{needText(item.request || {})}</span>
                      <span className="vt-nm">{callerLabel(item)}</span>
                      <span className="vt-ln">{needLine(item)}</span>
                    </Link>
                    <div className={`vt-acts${href ? "" : " vt-acts-one"}`}>
                      {href ? (
                        <a className="vt-btn vt-btn-primary" href={href}>
                          Call back
                        </a>
                      ) : null}
                      <button type="button" className="vt-btn vt-btn-quiet" onClick={() => markDone(item)}>
                        Done
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="vt-card">
              <p className="vt-empty">{EMPTY}</p>
            </div>
          )}
        </section>

        <section className="vt-home-section">
          <div className="vt-sech">
            <h2 id="vt-done-h">Done today</h2>
            {data.doneToday.length ? <span className="vt-num">{data.doneToday.length}</span> : null}
          </div>
          {data.doneToday.length ? (
            <ul className="vt-card vt-drows" aria-labelledby="vt-done-h">
              {data.doneToday.map((row) => (
                <li key={row.callId} className="vt-drow">
                  <span className="vt-when vt-num">{formatTime(row.startedAt, tz)}</span>
                  <Link className="vt-drow-body" to={`/inbox/${row.callId}`}>
                    <span className="vt-nm">{callerLabel(row)}</span>
                    <span className="vt-ln">{doneLine(row)}</span>
                  </Link>
                  {row.handledBy ? (
                    <button type="button" className="vt-link" onClick={() => reopen(row)}>
                      Reopen
                    </button>
                  ) : (
                    <span />
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="vt-card">
              <p className="vt-empty">Nothing yet today.</p>
            </div>
          )}
        </section>
      </div>

      <aside className="vt-rail" aria-label="Today">
        <h2 className="vt-rail-h">Today's bookings</h2>
        <TodaysBookings bookings={data.todaysBookings} tz={tz} />
        <p className="vt-week">
          {`This week so far: ${plural(data.week.calls, "call", "calls")}, ${plural(
            data.week.bookingsMade,
            "booking",
            "bookings"
          )} made.`}{" "}
          <Link className="vt-link" to="/trends">
            See call trends
          </Link>
        </p>
      </aside>

      <div className="vt-toast" role="status" aria-live="polite">
        {toast ? <p>{toast}</p> : null}
      </div>
    </div>
  );
}

/** The time now, refreshed each minute so the "now" line moves. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function TodaysBookings({ bookings, tz }) {
  const now = useNow();
  if (!bookings?.length) return <p className="vt-rail-empty">No bookings today.</p>;
  let nowShown = false;
  const out = [];
  for (const b of bookings) {
    const at = new Date(b.scheduledAt).getTime();
    if (!nowShown && at > now) {
      nowShown = true;
      out.push(
        <li key="now" className="vt-nowline" aria-label={`Now, ${formatTime(new Date(now).toISOString(), tz)}`}>
          <span>Now</span>
        </li>
      );
    }
    const cancelled = b.status === "cancelled";
    const body = (
      <>
        <span className="vt-tl-t vt-num">{formatTime(b.scheduledAt, tz)}</span>
        <span className="vt-tl-name">{b.clientName || "Booking"}</span>
        {cancelled ? <span className="vt-tl-w">Cancelled</span> : null}
      </>
    );
    out.push(
      <li key={b.id} className={`vt-tl${at < now ? " vt-tl-past" : ""}${cancelled ? " vt-tl-cancelled" : ""}`}>
        {b.callId ? (
          <Link className="vt-tl-row" to={`/inbox/${b.callId}`}>
            {body}
          </Link>
        ) : (
          <span className="vt-tl-row">{body}</span>
        )}
      </li>
    );
  }
  return <ul className="vt-tls">{out}</ul>;
}

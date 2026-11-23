import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useBusiness } from "../shell/BusinessContext";
import { useAutoRefresh } from "../shell/useAutoRefresh";
import { formatTime } from "../calls/format";
import {
  GRID_START_MIN,
  GRID_END_MIN,
  addDays,
  gridSlot,
  isValidDay,
  mondayOf,
  placeBooking,
  todayIn,
  weekDays,
} from "./calendar/week";
import BookingDetail from "./calendar/BookingDetail";
import "./calendar/calendar.css";

const LOAD_ERROR = "Couldn't load your bookings. Check your connection, then try again.";
const SEND_ERROR = "Couldn't send the email. Try again in a minute.";
const RANGES = [
  ["today", "Today"],
  ["7days", "Next 7 days"],
  ["upcoming", "Upcoming"],
];
// Below this content width the week grid becomes a day strip and a list.
const NARROW = 760;
// Minutes a booking takes up when deciding whether two sit side by side.
const BLOCK_MIN = 45;
const HOURS = Array.from({ length: (GRID_END_MIN - GRID_START_MIN) / 60 + 1 }, (_, i) => GRID_START_MIN / 60 + i);

// Days are "YYYY-MM-DD" on the business's calendar; formatting them at noon
// UTC in UTC keeps the viewer's timezone out of it.
const dayParts = (day, options) => {
  const out = {};
  for (const p of new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...options }).formatToParts(new Date(`${day}T12:00:00Z`))) {
    out[p.type] = p.value;
  }
  return out;
};
/** "Tuesday 24 November" */
const dayLong = (day) => {
  const p = dayParts(day, { weekday: "long", day: "numeric", month: "long" });
  return `${p.weekday} ${p.day} ${p.month}`;
};

/** "23–28 November 2026", "30 November – 5 December 2026", "28 December 2026 – 2 January 2027" */
function weekLabel(first, last) {
  const a = dayParts(first, { day: "numeric", month: "long", year: "numeric" });
  const b = dayParts(last, { day: "numeric", month: "long", year: "numeric" });
  if (a.year !== b.year) return `${a.day} ${a.month} ${a.year} – ${b.day} ${b.month} ${b.year}`;
  if (a.month !== b.month) return `${a.day} ${a.month} – ${b.day} ${b.month} ${b.year}`;
  return `${a.day}–${b.day} ${b.month} ${b.year}`;
}

const hourLabel = (h) => (h === 12 ? "12 pm" : h > 12 ? `${h - 12} pm` : `${h} am`);

/** The time now, refreshed each minute so the "now" line moves. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Whether the page itself (not the window) is wider than NARROW. */
function useWide(ref) {
  const [wide, setWide] = useState(() => typeof window === "undefined" || window.innerWidth > NARROW);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w > 0) setWide(w > NARROW);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return wide;
}

/** Side-by-side lanes for bookings that would overlap in one day column. */
function withLanes(items) {
  const ends = [];
  const out = items.map((it) => {
    let lane = ends.findIndex((end) => end <= it.minutes);
    if (lane === -1) {
      lane = ends.length;
      ends.push(0);
    }
    ends[lane] = it.minutes + BLOCK_MIN;
    return { ...it, lane };
  });
  return { items: out, lanes: Math.max(1, ends.length) };
}

function BookingButton({ placed, tz, withDay, open, onOpen, className = "", style }) {
  const { b } = placed;
  const name = b.client_name?.trim() || "Caller";
  const time = formatTime(b.scheduled_at, tz);
  const cancelled = b.status === "cancelled";
  const label = `${withDay ? `${dayLong(placed.day)}, ` : ""}${time}, ${name}${cancelled ? ", cancelled" : ""}`;
  return (
    <button
      type="button"
      data-booking=""
      className={`vt-cal-booking${cancelled ? " vt-cal-cancelled" : ""} ${className}`.trim()}
      style={style}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={(e) => onOpen(b, e.currentTarget)}
    >
      <span className="vt-cal-b-time vt-num">
        {withDay ? `${dayLong(placed.day)}, ` : ""}
        {time}
      </span>
      <span className="vt-cal-b-name">{name}</span>
      {cancelled ? <span className="vt-cal-b-tag">Cancelled</span> : null}
    </button>
  );
}

/**
 * Calendar (spec §8): the week's bookings on the business's clock. A week grid
 * from 8 am to 6 pm, Monday to Saturday, on wide screens, with anything outside
 * it listed underneath; a day strip and a day list on phones. Read-only: calls
 * make, move and cancel bookings.
 */
export default function Calendar() {
  const { business } = useBusiness();
  const tz = business?.timezone || "America/Chicago";
  const [params, setParams] = useSearchParams();
  const raw = params.get("date");
  const today = todayIn(tz);
  const date = isValidDay(raw) ? raw : today;
  const monday = mondayOf(date);
  const sunday = addDays(monday, 6);

  const rootRef = useRef(null);
  const wide = useWide(rootRef);
  const now = useNow();

  const [data, setData] = useState({ status: "loading", week: null, bookings: [] });
  const [attempt, setAttempt] = useState(0);
  useAutoRefresh(() => setAttempt((n) => n + 1));

  useEffect(() => {
    let cancelled = false;
    api
      .get("/api/appointments", { params: { from: monday, to: sunday } })
      .then((res) => {
        if (!cancelled) setData({ status: "ready", week: monday, bookings: Array.isArray(res.data) ? res.data : [] });
      })
      .catch(() => {
        if (cancelled) return;
        // A background refresh that fails keeps the week already shown.
        setData((d) => (d.week === monday && d.status === "ready" ? d : { status: "error", week: monday, bookings: [] }));
      });
    return () => {
      cancelled = true;
    };
  }, [monday, sunday, attempt]);

  const status = data.week === monday ? data.status : "loading";

  const placed = useMemo(
    () =>
      data.bookings
        .map((b) => ({ b, ...placeBooking(b.scheduled_at, tz) }))
        .sort((x, y) => new Date(x.b.scheduled_at) - new Date(y.b.scheduled_at)),
    [data.bookings, tz]
  );

  // The open booking, kept to the week it was opened in.
  const [open, setOpen] = useState(null);
  const opener = useRef(null);
  const openNow = open && open.week === monday ? open : null;
  function openBooking(b, el) {
    opener.current = el;
    let position;
    if (wide && typeof window !== "undefined") {
      const r = el.getBoundingClientRect();
      const width = 320;
      let left = r.right + 8;
      if (left + width > window.innerWidth - 16) left = Math.max(16, r.left - 8 - width);
      const top = Math.max(16, Math.min(r.top, window.innerHeight - 360));
      position = { left, top };
    }
    setOpen({ week: monday, booking: b, position });
  }
  function closeBooking() {
    setOpen(null);
    opener.current?.focus();
  }

  const [range, setRange] = useState("today");
  const [mail, setMail] = useState({ kind: "idle" });
  async function emailBookings(e) {
    e.preventDefault();
    const to = typeof business?.notification_email === "string" ? business.notification_email.trim() : "";
    if (!to) {
      setMail({ kind: "missing" });
      return;
    }
    setMail({ kind: "sending" });
    try {
      await api.post("/api/appointments/email", { range });
      setMail({ kind: "sent", to });
    } catch (err) {
      const reason = err?.response?.data?.error;
      setMail({ kind: "error", text: typeof reason === "string" && reason ? reason : SEND_ERROR, settings: Boolean(reason) });
    }
  }

  const go = (day) => setParams({ date: day });
  const days = weekDays(monday, wide ? 6 : 7);

  return (
    <div className="vt-cal" ref={rootRef}>
      <header className="vt-cal-head">
        <div className="vt-cal-titles">
          <h1>Calendar</h1>
          <p className="vt-cal-week vt-num">{weekLabel(days[0], days[days.length - 1])}</p>
        </div>
        <div className="vt-cal-nav">
          <button type="button" className="vt-btn vt-btn-quiet vt-cal-arrow" aria-label="Previous week" onClick={() => go(addDays(date, -7))}>
            <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
              <path d="M12.5 4.5 7 10l5.5 5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button type="button" className="vt-btn vt-btn-quiet" onClick={() => go(today)}>
            Today
          </button>
          <button type="button" className="vt-btn vt-btn-quiet vt-cal-arrow" aria-label="Next week" onClick={() => go(addDays(date, 7))}>
            <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
              <path d="M7.5 4.5 13 10l-5.5 5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        <form className="vt-cal-email" onSubmit={emailBookings}>
          <label htmlFor="vt-cal-range" className="vt-sr-only">
            Bookings to email
          </label>
          <select id="vt-cal-range" className="vt-cal-select" value={range} onChange={(e) => setRange(e.target.value)}>
            {RANGES.map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
          <button type="submit" className="vt-btn vt-btn-primary" disabled={mail.kind === "sending"}>
            {mail.kind === "sending" ? "Sending…" : "Email me bookings"}
          </button>
        </form>
      </header>

      <div className="vt-cal-mail" role="status" aria-live="polite">
        {mail.kind === "missing" ? (
          <p className="vt-cal-mail-warn">
            <span>Add an alert email first.</span>{" "}
            <Link className="vt-link" to="/settings/alerts">
              Go to Email alerts
            </Link>
          </p>
        ) : null}
        {mail.kind === "sent" ? <p>{`Sent to ${mail.to}. It says how many bookings there are; the details stay here.`}</p> : null}
        {mail.kind === "error" ? (
          <p className="vt-cal-mail-warn">
            <span>{mail.text}</span>{" "}
            {mail.settings ? (
              <Link className="vt-link" to="/settings/alerts">
                Go to Email alerts
              </Link>
            ) : null}
          </p>
        ) : null}
      </div>

      {status === "loading" ? (
        <p className="vt-cal-state" role="status">
          Loading your bookings…
        </p>
      ) : status === "error" ? (
        <div className="vt-cal-state">
          <p>{LOAD_ERROR}</p>
          <button
            type="button"
            className="vt-btn vt-btn-primary"
            onClick={() => {
              setData({ status: "loading", week: null, bookings: [] });
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          {placed.length === 0 ? <p className="vt-cal-empty">No bookings this week.</p> : null}
          {wide ? (
            <WeekGrid days={days} placed={placed} tz={tz} today={today} now={now} openId={openNow?.booking.id} onOpen={openBooking} />
          ) : (
            <DayView days={days} date={date} today={today} placed={placed} tz={tz} openId={openNow?.booking.id} onOpen={openBooking} onPick={go} />
          )}
        </>
      )}

      {openNow ? (
        <BookingDetail
          booking={openNow.booking}
          tz={tz}
          onClose={closeBooking}
          position={openNow.position}
          variant={wide ? "popover" : "panel"}
        />
      ) : null}
    </div>
  );
}

function WeekGrid({ days, placed, tz, today, now, openId, onOpen }) {
  const columns = days.map(() => []);
  const outside = [];
  for (const p of placed) {
    const slot = gridSlot(p, days);
    if (slot) columns[slot.col].push({ ...p, top: slot.top });
    else outside.push(p);
  }
  const nowAt = placeBooking(new Date(now).toISOString(), tz);
  const nowSlot = gridSlot(nowAt, days);

  return (
    <>
      <div className="vt-cal-grid" style={{ "--cols": days.length }}>
        <div className="vt-cal-gridhead" aria-hidden="true">
          <span />
          {days.map((d) => {
            const p = dayParts(d, { weekday: "short", day: "numeric" });
            return (
              <div key={d} className={`vt-cal-dayh${d === today ? " vt-cal-dayh-today" : ""}`}>
                <span className="vt-cal-dayh-wd">{p.weekday}</span>
                <span className="vt-cal-dayh-num vt-num">{p.day}</span>
              </div>
            );
          })}
        </div>
        <div className="vt-cal-gridbody">
          <div className="vt-cal-hours" aria-hidden="true">
            {HOURS.map((h) => (
              <div key={h} className="vt-cal-hour" style={{ top: `${((h * 60 - GRID_START_MIN) / (GRID_END_MIN - GRID_START_MIN)) * 100}%` }}>
                <span className="vt-num">{hourLabel(h)}</span>
              </div>
            ))}
          </div>
          {days.map((d, i) => {
            const { items, lanes } = withLanes(columns[i]);
            return (
              <section
                key={d}
                className={`vt-cal-col${d === today ? " vt-cal-col-today" : ""}`}
                style={{ gridColumn: i + 2 }}
                aria-label={`${d === today ? "Today, " : ""}${dayLong(d)}`}
              >
                {items.length ? (
                  <ul>
                    {items.map((it) => (
                      <li key={it.b.id}>
                        <BookingButton
                          placed={it}
                          tz={tz}
                          open={openId === it.b.id}
                          onOpen={onOpen}
                          className="vt-cal-block"
                          style={{
                            top: `${it.top * 100}%`,
                            left: `calc(${(it.lane / lanes) * 100}% + 2px)`,
                            width: `calc(${100 / lanes}% - 4px)`,
                          }}
                        />
                      </li>
                    ))}
                  </ul>
                ) : null}
                {nowSlot && nowSlot.col === i ? (
                  <div className="vt-cal-now" style={{ top: `${nowSlot.top * 100}%` }} aria-hidden="true" />
                ) : null}
              </section>
            );
          })}
        </div>
      </div>

      {outside.length ? (
        <section className="vt-cal-outside">
          <h2 id="vt-cal-outside-h">Outside 8 am–6 pm</h2>
          <ul aria-labelledby="vt-cal-outside-h">
            {outside.map((p) => (
              <li key={p.b.id}>
                <BookingButton placed={p} tz={tz} withDay open={openId === p.b.id} onOpen={onOpen} className="vt-cal-row" />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function DayView({ days, date, today, placed, tz, openId, onOpen, onPick }) {
  const counts = new Map();
  for (const p of placed) counts.set(p.day, (counts.get(p.day) || 0) + 1);
  const list = placed.filter((p) => p.day === date);
  return (
    <>
      <div className="vt-cal-strip" role="group" aria-label="Days this week">
        {days.map((d) => {
          const p = dayParts(d, { weekday: "short", day: "numeric" });
          const n = counts.get(d) || 0;
          return (
            <button
              key={d}
              type="button"
              className={`vt-cal-stripday${d === today ? " vt-cal-stripday-today" : ""}`}
              aria-pressed={d === date}
              aria-label={`${d === today ? "Today, " : ""}${dayLong(d)}${n ? `, ${n} ${n === 1 ? "booking" : "bookings"}` : ""}`}
              onClick={() => onPick(d)}
            >
              <span className="vt-cal-dayh-wd">{p.weekday}</span>
              <span className="vt-cal-dayh-num vt-num">{p.day}</span>
              <span className="vt-cal-stripdot" aria-hidden="true">
                {n ? "•" : ""}
              </span>
            </button>
          );
        })}
      </div>
      <section className="vt-cal-day">
        <h2 id="vt-cal-day-h">{`${date === today ? "Today, " : ""}${dayLong(date)}`}</h2>
        {list.length ? (
          <ul aria-labelledby="vt-cal-day-h">
            {list.map((p) => (
              <li key={p.b.id}>
                <BookingButton placed={p} tz={tz} open={openId === p.b.id} onOpen={onOpen} className="vt-cal-row" />
              </li>
            ))}
          </ul>
        ) : (
          <p className="vt-cal-empty">No bookings on this day.</p>
        )}
      </section>
    </>
  );
}

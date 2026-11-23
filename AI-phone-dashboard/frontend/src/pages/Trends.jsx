import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import "./trends.css";

const LOAD_ERROR = "Couldn't load your call trends. Check your connection, then try again.";
const PERIODS = [
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
  ["90d", "Last 3 months"],
];
const OVER_TIME = { "7d": "Calls this week", "30d": "Calls by week", "90d": "Calls by month" };

const n = (v) => Number(v ?? 0) || 0;
const calls = (count) => `${count} ${count === 1 ? "call" : "calls"}`;

/**
 * One series of bars: the chart's title names it, so there is no legend. Each
 * bar shows its count on hover or keyboard focus and carries it in its name;
 * a zero is no bar at all, never a stub that reads as a few calls.
 */
function BarChart({ title, buckets, labelOf, height }) {
  const max = Math.max(...buckets.map((b) => n(b.total_calls)), 1);
  return (
    <ol className="vt-tr-bars" aria-label={title} style={{ "--bar-h": `${height}px` }}>
      {buckets.map((b, i) => {
        const count = n(b.total_calls);
        const label = labelOf(b) || "";
        return (
          <li key={`${label}-${i}`} className="vt-tr-col">
            <div className="vt-tr-plot" role="img" aria-label={`${label}: ${calls(count)}`} tabIndex={0}>
              {count ? <div className="vt-tr-bar" style={{ height: `max(4px, ${(count / max) * 100}%)` }} /> : null}
              <span className="vt-tr-tip vt-num" aria-hidden="true">
                {count}
              </span>
            </div>
            <span className="vt-tr-label" aria-hidden="true">
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function CountList({ rows }) {
  return (
    <dl className="vt-tr-counts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd className="vt-num">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** An hour of the day in the dashboard's words: "9 am", "noon", "11 pm", "midnight". */
function hourWords(h) {
  const hour = ((h % 24) + 24) % 24;
  if (hour === 0) return "midnight";
  if (hour === 12) return "noon";
  return hour < 12 ? `${hour} am` : `${hour - 12} pm`;
}

function insights(data) {
  const lines = [];
  const mix = data.caller_mix;
  if (mix) {
    const first = n(mix.first_time);
    const total = first + n(mix.returning);
    const firstPct = total > 0 ? Math.round((first / total) * 100) : 0;
    lines.push(`${firstPct}% first-time callers, ${total > 0 ? 100 - firstPct : 0}% returning`);
  }
  const peak = data.peak_hour;
  if (peak && typeof peak.hour === "number") {
    lines.push(`Busiest hour this period: ${hourWords(peak.hour)} to ${hourWords(peak.hour + 1)}`);
  }
  const bh = data.business_hours;
  // The business's own opening hours on its clock (analytics.js, the
  // receptionist's rule). No hours set means always open: no figure to give.
  if (bh?.opening_hours_set === true) {
    const total = n(bh.in_hours) + n(bh.out_hours);
    if (total > 0) {
      lines.push(`${Math.round((n(bh.out_hours) / total) * 100)}% of calls came outside your opening hours`);
    }
  }
  return lines;
}

/**
 * Call trends (spec §7): the old analytics page in the new style. Same charts,
 * same data, same periods, from GET /api/analytics-breakdown.
 */
export default function Trends() {
  const [period, setPeriod] = useState("90d");
  const [state, setState] = useState({ status: "loading", period: null, data: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .get("/api/analytics-breakdown", { params: { period } })
      .then((res) => {
        if (!cancelled) setState({ status: "ready", period, data: res.data || {} });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", period, data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [period, attempt]);

  const status = state.period === period ? state.status : "loading";
  const data = state.data;

  return (
    <div className="vt-tr">
      <Link className="vt-link vt-tr-back" to="/home">
        <span aria-hidden="true">← </span>Home
      </Link>
      <header className="vt-tr-head">
        <div>
          <h1>Call trends</h1>
          <p>Trends and totals for your calls.</p>
        </div>
        <div className="vt-tr-period">
          <label htmlFor="vt-tr-period">Period</label>
          <select id="vt-tr-period" value={period} onChange={(e) => setPeriod(e.target.value)}>
            {PERIODS.map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </div>
      </header>

      {status === "loading" ? (
        <p className="vt-tr-state" role="status">
          Loading your call trends…
        </p>
      ) : status === "error" ? (
        <div className="vt-tr-state">
          <p>{LOAD_ERROR}</p>
          <button
            type="button"
            className="vt-btn vt-btn-primary"
            onClick={() => {
              setState({ status: "loading", period: null, data: null });
              setAttempt((a) => a + 1);
            }}
          >
            Try again
          </button>
        </div>
      ) : n(data.total_calls_3m) === 0 ? (
        <p className="vt-tr-state">No calls in this period yet.</p>
      ) : (
        <TrendsBody data={data} period={period} />
      )}
    </div>
  );
}

function TrendsBody({ data, period }) {
  const sc = data.status_counts || {};
  const outcomes = [
    ["Completed", n(sc.completed)],
    ["Transferred", n(sc.transferred)],
    ["Failed", n(sc.failed)],
    ["No answer", n(sc.no_answer)],
    ["Busy", n(sc.busy)],
  ];
  if (n(sc.in_progress) > 0) outcomes.push(["In progress", n(sc.in_progress)]);
  const outcomeTotal = outcomes.reduce((sum, [, v]) => sum + v, 0);
  const answerRate = outcomeTotal > 0 ? Math.round((n(sc.completed) / outcomeTotal) * 100) : 0;
  const lines = insights(data);
  const sentiment = data.sentiment_counts || {};
  const actions = data.actions || {};
  const rated = n(sentiment.positive) + n(sentiment.neutral) + n(sentiment.negative) > 0;

  const tiles = [
    ["Calls", n(data.total_calls_3m)],
    ["Bookings made", n(actions.appointments)],
    ["Follow-ups needed", n(data.followups_needed)],
    // No call rated yet is not "0% positive".
    rated ? ["Positive calls", `${n(data.positive_calls_percent)}%`] : ["Positive calls", "–", "Not known yet"],
    ["Calls that became bookings", `${n(data.appointment_conversion_percent)}%`],
  ];
  if (data.caller_mix) tiles.push(["New callers", n(data.caller_mix.first_time)]);

  return (
    <>
      <section aria-labelledby="vt-tr-overview">
        <h2 id="vt-tr-overview" className="vt-sr-only">
          Overview
        </h2>
        <dl className="vt-tr-tiles">
          {tiles.map(([label, value, note]) => (
            <div key={label} className="vt-tr-tile">
              <dt>{label}</dt>
              <dd className="vt-num">
                {value}
                {note ? <span className="vt-tr-tile-note">{note}</span> : null}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {lines.length ? (
        <section className="vt-tr-card vt-tr-insights" aria-labelledby="vt-tr-insights-h">
          <h2 id="vt-tr-insights-h">This period</h2>
          <ul>
            {lines.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="vt-tr-grid">
        <section className="vt-tr-card vt-tr-wide" aria-labelledby="vt-tr-time-h">
          <h2 id="vt-tr-time-h">{OVER_TIME[period]}</h2>
          {data.calls_by_month?.length ? (
            <BarChart title={OVER_TIME[period]} buckets={data.calls_by_month} labelOf={(b) => b.month_label || b.bucket_label} height={160} />
          ) : (
            <p className="vt-tr-none">No calls in this period yet.</p>
          )}
        </section>

        <section className="vt-tr-card" aria-labelledby="vt-tr-actions-h">
          <h2 id="vt-tr-actions-h">What VetraTD did</h2>
          <CountList
            rows={[
              ["Bookings made", n(actions.appointments)],
              ["Call-backs requested", n(actions.callbacks)],
              ["Messages taken", n(actions.messages)],
            ]}
          />
        </section>

        <section className="vt-tr-card vt-tr-wide" aria-labelledby="vt-tr-weekday-h">
          <h2 id="vt-tr-weekday-h">Calls by day of the week</h2>
          {data.calls_by_weekday?.length ? (
            <BarChart title="Calls by day of the week" buckets={data.calls_by_weekday} labelOf={(d) => d.day_name} height={110} />
          ) : (
            <p className="vt-tr-none">No calls in this period yet.</p>
          )}
        </section>

        <section className="vt-tr-card" aria-labelledby="vt-tr-sentiment-h">
          <h2 id="vt-tr-sentiment-h">How callers sounded</h2>
          <CountList
            rows={[
              ["Positive", n(sentiment.positive)],
              ["Neutral", n(sentiment.neutral)],
              ["Negative", n(sentiment.negative)],
              ["Not known", n(sentiment.unknown)],
            ]}
          />
        </section>

        <section className="vt-tr-card" aria-labelledby="vt-tr-outcomes-h">
          <h2 id="vt-tr-outcomes-h">How calls ended</h2>
          <p className="vt-tr-rate">
            <span className="vt-num">{answerRate}%</span> completed
          </p>
          <CountList rows={outcomes} />
        </section>
      </div>
    </>
  );
}

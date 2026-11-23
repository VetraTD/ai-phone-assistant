import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useTranslations } from "../LanguageSwitcher";
import { useBusiness } from "../shell/BusinessContext";
import "../Dashboard.css";

function AnalyticsPeriodSelect({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (!ref.current || ref.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const options = [
    { value: "7d", label: "Last 7 days" },
    { value: "30d", label: "Last 30 days" },
    { value: "90d", label: "Last 3 months" },
  ];

  const current = options.find((o) => o.value === value) || options[1];

  return (
    <div className="analytics-period" ref={ref}>
      <button
        type="button"
        className="analytics-period-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="analytics-period-label">{current.label}</span>
        <span className="analytics-period-chevron">▾</span>
      </button>
      {open && (
        <div
          className="analytics-period-menu"
          role="listbox"
          aria-label="Analytics period"
        >
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`analytics-period-item ${
                opt.value === value ? "is-active" : ""
              }`}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              role="option"
              aria-selected={opt.value === value}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AnimatedNumber({ value, duration = 1200, suffix = "" }) {
  const num = Number(value);
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    if (typeof num !== "number" || isNaN(num) || num < 0) return;
    // Moved unchanged from App.jsx; part 2 rebuilds this page.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDisplay(0);
    const start = performance.now();
    let rafId;
    const tick = (now) => {
      const elapsed = now - start;
      const t = Math.min(elapsed / duration, 1);
      const easeOut = 1 - Math.pow(1 - t, 2);
      setDisplay(Math.round(easeOut * num));
      if (t < 1) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [num, duration]);

  if (typeof num !== "number" || isNaN(num)) return <>{String(0) + suffix}</>;
  return <>{display}{suffix}</>;
}


// Moved out of the old one-page App.jsx unchanged in markup; part 2 replaces it.
export default function LegacyTrends() {
  const t = useTranslations();
  const { business, businessId } = useBusiness();
  const [analyticsBreakdown, setAnalyticsBreakdown] = useState(null);
  const [analyticsPeriod, setAnalyticsPeriod] = useState("90d");

  useEffect(() => {
    if (!businessId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAnalyticsBreakdown(null);
    api.get("/api/analytics-breakdown", { params: { period: analyticsPeriod } })
      .then((res) => setAnalyticsBreakdown(res.data))
      .catch((err) => {
        console.error(err);
      });
  }, [businessId, analyticsPeriod]);

  return (
    <div className="vt-page">
      <section className="analytics-page">
        <div className="analytics-page-header">
          <div className="analytics-page-title-row">
            <h2 className="analytics-page-title">Call analytics</h2>
            <AnalyticsPeriodSelect
              value={analyticsPeriod}
              onChange={setAnalyticsPeriod}
            />
          </div>
          <p className="analytics-page-subtitle">Trends and totals for your receptionist calls</p>
        </div>

        {!analyticsBreakdown ? (
          <>
            <section className="analytics-overview">
              <h3 className="analytics-section-label">Overview</h3>
              <div className="dashboard-kpis analytics-kpis">
                <div className="kpi-card kpi-card-skeleton"><div className="kpi-label">Receptionist calls</div><div className="kpi-value kpi-skeleton" /></div>
                <div className="kpi-card kpi-card-skeleton"><div className="kpi-label">Appointments scheduled</div><div className="kpi-value kpi-skeleton" /></div>
                <div className="kpi-card kpi-card-skeleton"><div className="kpi-label">Follow-ups needed</div><div className="kpi-value kpi-skeleton" /></div>
                <div className="kpi-card kpi-card-skeleton"><div className="kpi-label">Positive calls</div><div className="kpi-value kpi-skeleton" /></div>
                <div className="kpi-card kpi-card-skeleton"><div className="kpi-label">Calls → appointments</div><div className="kpi-value kpi-skeleton" /></div>
              </div>
            </section>
            <section className="analytics-charts">
              <div className="panel analytics-chart-panel">
                <div className="panel-header">
                  <h3 className="panel-title">{analyticsPeriod === "7d" ? "Calls this week" : analyticsPeriod === "30d" ? "Calls by week" : "Calls last 3 months"}</h3>
                </div>
                <div className="panel-body"><div className="empty-note">{t.loadingAnalytics}</div></div>
              </div>
              <div className="panel analytics-chart-panel">
                <div className="panel-header"><h3 className="panel-title">Actions taken</h3></div>
                <div className="panel-body"><div className="empty-note">{t.loadingAnalytics}</div></div>
              </div>
            </section>
            <section className="analytics-charts analytics-charts-second-row">
              <div className="panel analytics-chart-panel">
                <div className="panel-header"><h3 className="panel-title">Calls by day of week</h3></div>
                <div className="panel-body"><div className="empty-note">{t.loadingAnalytics}</div></div>
              </div>
              <div className="panel analytics-chart-panel">
                <div className="panel-header"><h3 className="panel-title">Sentiment</h3></div>
                <div className="panel-body"><div className="empty-note">{t.loadingAnalytics}</div></div>
              </div>
              <div className="panel analytics-chart-panel">
                <div className="panel-header"><h3 className="panel-title">Call outcomes</h3></div>
                <div className="panel-body"><div className="empty-note">{t.loadingAnalytics}</div></div>
              </div>
            </section>
          </>
        ) : (
          <>
        <section className="analytics-overview">
          <h3 className="analytics-section-label">Overview</h3>
          <div className="dashboard-kpis analytics-kpis">
            <div className="kpi-card kpi-card-orange">
              <div className="kpi-value">
                <AnimatedNumber value={analyticsBreakdown?.total_calls_3m ?? 0} duration={1200} />
              </div>
              <div className="kpi-label">Receptionist calls</div>
            </div>
            <div className="kpi-card kpi-card-green">
              <div className="kpi-value">
                <AnimatedNumber value={analyticsBreakdown?.actions?.appointments ?? 0} duration={1200} />
              </div>
              <div className="kpi-label">Appointments scheduled</div>
            </div>
            <div className="kpi-card kpi-card-blue">
              <div className="kpi-value">
                <AnimatedNumber value={analyticsBreakdown?.followups_needed ?? 0} duration={1200} />
              </div>
              <div className="kpi-label">Follow-ups needed</div>
            </div>
            <div className="kpi-card kpi-card-teal">
              <div className="kpi-value">
                <AnimatedNumber value={analyticsBreakdown?.positive_calls_percent ?? 0} duration={1200} suffix="%" />
              </div>
              <div className="kpi-label">Positive calls</div>
            </div>
            <div className="kpi-card kpi-card-purple">
              <div className="kpi-value">
                <AnimatedNumber value={analyticsBreakdown?.appointment_conversion_percent ?? 0} duration={1200} suffix="%" />
              </div>
              <div className="kpi-label">Calls → appointments</div>
            </div>
            {analyticsBreakdown?.caller_mix && (
              <div className="kpi-card">
                <div className="kpi-value">
                  <AnimatedNumber
                    value={Number(analyticsBreakdown.caller_mix.first_time ?? 0)}
                    duration={1200}
                  />
                </div>
                <div className="kpi-label">New callers this period</div>
              </div>
            )}
          </div>
        </section>

        {analyticsBreakdown?.caller_mix && (
          <section className="panel analytics-insights">
            <div className="panel-body analytics-insights-body">
              {(() => {
                const mix = analyticsBreakdown.caller_mix || {};
                const first = Number(mix.first_time ?? 0);
                const returning = Number(mix.returning ?? 0);
                const total = first + returning;
                const firstPct = total > 0 ? Math.round((first / total) * 100) : 0;
                const returningPct = total > 0 ? 100 - firstPct : 0;
                const peak = analyticsBreakdown.peak_hour;
                const bh = analyticsBreakdown.business_hours;
                const lines = [];
                lines.push(`${firstPct}% first-time callers, ${returningPct}% returning`);
                if (peak && typeof peak.hour === "number") {
                  const h = peak.hour;
                  const pad = (n) => String(n).padStart(2, "0");
                  const next = (h + 1) % 24;
                  lines.push(`Peak hour this period: ${pad(h)}:00–${pad(next)}:00`);
                }
                if (bh) {
                  const inHours = Number(bh.in_hours ?? 0);
                  const outHours = Number(bh.out_hours ?? 0);
                  const totalBh = inHours + outHours;
                  if (totalBh > 0) {
                    const outPct = Math.round((outHours / totalBh) * 100);
                    const tzLabel = bh.timezone || (business?.timezone || "");
                    lines.push(
                      `${outPct}% of calls came outside typical hours (09:00–17:00${tzLabel ? `, ${tzLabel}` : ""})`
                    );
                  }
                }
                return (
                  <>
                    <p className="analytics-insights-title">Insights for this period</p>
                    <ul className="analytics-insights-list">
                      {lines.map((text) => (
                        <li key={text}>{text}</li>
                      ))}
                    </ul>
                  </>
                );
              })()}
            </div>
          </section>
        )}

        <section className="analytics-charts">
          <div className="panel analytics-chart-panel">
            <div className="panel-header">
              <h3 className="panel-title">
                {analyticsPeriod === "7d" ? "Calls this week" : analyticsPeriod === "30d" ? "Calls by week" : "Calls last 3 months"}
              </h3>
            </div>
            <div className="panel-body">
              {analyticsBreakdown?.calls_by_month?.length ? (
                <div className="calls-chart">
                  {(() => {
                    const chartHeightPx = 160;
                    const buckets = analyticsBreakdown.calls_by_month;
                    const max = Math.max(...buckets.map((b) => Number(b.total_calls) || 0), 1);
                    return buckets.map((b) => {
                      const count = Number(b.total_calls) || 0;
                      const pct = max > 0 ? count / max : 0;
                      const barPx = Math.max(Math.round(pct * chartHeightPx), 12);
                      return (
                        <div key={b.month_label} className="calls-chart-column">
                          <div
                            className="calls-chart-bar-wrap"
                            style={{ height: `${barPx}px` }}
                          >
                            <div
                              className="calls-chart-bar"
                              title={`${count} calls`}
                            />
                          </div>
                          <div className="calls-chart-label">{b.month_label || b.bucket_label}</div>
                        </div>
                      );
                    });
                  })()}
                </div>
              ) : (
                <div className="empty-note">
                  No call data for {analyticsPeriod === "7d" ? "the last 7 days" : analyticsPeriod === "30d" ? "the last 30 days" : "the last 3 months"}.
                </div>
              )}
            </div>
          </div>
          <div className="panel analytics-chart-panel">
            <div className="panel-header">
              <h3 className="panel-title">Actions taken</h3>
            </div>
            <div className="panel-body">
              <div className="actions-summary">
                <div className="actions-row">
                  <span className="actions-dot actions-dot-appointments" />
                  <span>Appointment scheduled</span>
                  <span className="actions-count">{analyticsBreakdown?.actions?.appointments ?? 0}</span>
                </div>
                <div className="actions-row">
                  <span className="actions-dot actions-dot-callbacks" />
                  <span>Callback requested</span>
                  <span className="actions-count">{analyticsBreakdown?.actions?.callbacks ?? 0}</span>
                </div>
                <div className="actions-row">
                  <span className="actions-dot actions-dot-messages" />
                  <span>Message taken</span>
                  <span className="actions-count">{analyticsBreakdown?.actions?.messages ?? 0}</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="analytics-charts analytics-charts-second-row">
          <div className="panel analytics-chart-panel">
            <div className="panel-header">
              <h3 className="panel-title">Calls by day of week</h3>
            </div>
            <div className="panel-body">
              {analyticsBreakdown?.calls_by_weekday?.length ? (
                <div className="calls-chart calls-chart-weekday">
                  {analyticsBreakdown.calls_by_weekday.map((d) => {
                    const count = Number(d.total_calls) || 0;
                    const max = Math.max(...analyticsBreakdown.calls_by_weekday.map((x) => Number(x.total_calls) || 0), 1);
                    const chartHeightPx = 100;
                    const barPx = Math.max(Math.round((count / max) * chartHeightPx), 8);
                    return (
                      <div key={d.day_name} className="calls-chart-column">
                        <div className="calls-chart-bar-wrap" style={{ height: `${barPx}px` }}>
                          <div className="calls-chart-bar" title={`${count} calls`} />
                        </div>
                        <div className="calls-chart-label">{d.day_name}</div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="empty-note">No call data for this period.</div>
              )}
            </div>
          </div>
          <div className="panel analytics-chart-panel">
            <div className="panel-header">
              <h3 className="panel-title">Sentiment</h3>
            </div>
            <div className="panel-body">
              <div className="sentiment-summary">
                <div className="sentiment-row sentiment-positive">
                  <span className="sentiment-dot" />
                  <span>Positive</span>
                  <span className="sentiment-count">{analyticsBreakdown?.sentiment_counts?.positive ?? 0}</span>
                </div>
                <div className="sentiment-row sentiment-neutral">
                  <span className="sentiment-dot" />
                  <span>Neutral</span>
                  <span className="sentiment-count">{analyticsBreakdown?.sentiment_counts?.neutral ?? 0}</span>
                </div>
                <div className="sentiment-row sentiment-negative">
                  <span className="sentiment-dot" />
                  <span>Negative</span>
                  <span className="sentiment-count">{analyticsBreakdown?.sentiment_counts?.negative ?? 0}</span>
                </div>
                <div className="sentiment-row sentiment-unknown">
                  <span className="sentiment-dot" />
                  <span>Unknown</span>
                  <span className="sentiment-count">{analyticsBreakdown?.sentiment_counts?.unknown ?? 0}</span>
                </div>
              </div>
            </div>
          </div>
          <div className="panel analytics-chart-panel">
            <div className="panel-header">
              <h3 className="panel-title">Call outcomes</h3>
            </div>
            <div className="panel-body">
              {(() => {
                const sc = analyticsBreakdown?.status_counts || {};
                const completed = Number(sc.completed ?? 0);
                const transferred = Number(sc.transferred ?? 0);
                const failed = Number(sc.failed ?? 0);
                const noAnswer = Number(sc.no_answer ?? 0);
                const busy = Number(sc.busy ?? 0);
                const inProgress = Number(sc.in_progress ?? 0);
                const total = completed + transferred + failed + noAnswer + busy + inProgress;
                const answerRate = total > 0 ? Math.round((completed / total) * 100) : 0;
                return (
                  <>
                    <div className="outcome-rate">
                      <span className="outcome-rate-value">{answerRate}%</span>
                      <span className="outcome-rate-label">answered / completed</span>
                    </div>
                    <div className="outcomes-list">
                      <div className="outcome-row outcome-completed">
                        <span className="outcome-dot" />
                        <span>Completed</span>
                        <span className="outcome-count">{completed}</span>
                      </div>
                      <div className="outcome-row outcome-transferred">
                        <span className="outcome-dot" />
                        <span>Transferred</span>
                        <span className="outcome-count">{transferred}</span>
                      </div>
                      <div className="outcome-row outcome-missed">
                        <span className="outcome-dot" />
                        <span>Failed</span>
                        <span className="outcome-count">{failed}</span>
                      </div>
                      <div className="outcome-row outcome-missed">
                        <span className="outcome-dot" />
                        <span>No answer</span>
                        <span className="outcome-count">{noAnswer}</span>
                      </div>
                      <div className="outcome-row outcome-missed">
                        <span className="outcome-dot" />
                        <span>Busy</span>
                        <span className="outcome-count">{busy}</span>
                      </div>
                      {inProgress > 0 && (
                        <div className="outcome-row outcome-pending">
                          <span className="outcome-dot" />
                          <span>In progress</span>
                          <span className="outcome-count">{inProgress}</span>
                        </div>
                      )}
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        </section>
          </>
        )}
      </section>
    </div>
  );
}

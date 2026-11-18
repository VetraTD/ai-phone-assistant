import Panel from "./Panel";

/**
 * Usage and plan.
 *
 * Lifted out of App.jsx's settings branch so it can sit inside the group rail
 * instead of floating above the rest of the page in the old visual style. The
 * data and every handler still belong to App.jsx — this file only knows how to
 * draw what it is handed.
 */
export default function AccountSection({
  usage,
  usageLoading,
  usageError,
  planName,
  billingStatus,
  phoneNumber,
  t,
}) {
  return (
    <>
      <Panel
        title="Usage this month"
        description="Resets on the 1st. Useful for keeping an eye on your plan."
      >
        {usageLoading ? (
          <p className="set-hint">Loading…</p>
        ) : usageError ? (
          <p className="set-hint">{usageError}</p>
        ) : usage ? (
          <div className="set-stat-row">
            <div>
              <div className="set-stat-value">{usage.calls_this_month ?? 0}</div>
              <div className="set-stat-label">Calls answered</div>
            </div>
            <div>
              <div className="set-stat-value">{usage.minutes_this_month ?? 0}</div>
              <div className="set-stat-label">Minutes used</div>
            </div>
          </div>
        ) : (
          <p className="set-hint">No usage recorded yet.</p>
        )}
      </Panel>

      <Panel title={t?.billingPlan || "Billing & plan"}>
        <dl className="set-defs">
          <dt>{t?.currentPlan || "Current plan"}</dt>
          <dd>
            <span className="set-pill set-pill-locked">{planName}</span>
          </dd>

          <dt>{t?.billingStatus || "Billing status"}</dt>
          <dd>{billingStatus}</dd>

          <dt>{t?.usageThisMonth || "Usage this month"}</dt>
          <dd>
            {usage
              ? `${usage.calls_this_month ?? 0} calls, ${usage.minutes_this_month ?? 0} min`
              : t?.comingSoon || "Coming soon"}
          </dd>

          <dt>{t?.phoneNumber || "Phone number"}</dt>
          <dd>{phoneNumber || t?.notConnectedYet || "Not connected yet"}</dd>
        </dl>

        <p className="set-alert set-alert-info">
          <span>{t?.stripeComing || "Card payments are coming soon."}</span>
        </p>
      </Panel>
    </>
  );
}

import Panel from "./Panel";

/**
 * Usage and the business's VetraTD number. No plan or billing panel: billing is
 * not built, so showing one would be a control that reaches nothing.
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
  phoneNumber,
}) {
  return (
    <>
      <Panel
        title="Usage this month"
        description="Resets on the 1st."
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

      <Panel title="Your VetraTD number">
        <dl className="set-defs">
          <dt>Number callers ring</dt>
          <dd>{phoneNumber || "No number set up yet"}</dd>
        </dl>
      </Panel>
    </>
  );
}

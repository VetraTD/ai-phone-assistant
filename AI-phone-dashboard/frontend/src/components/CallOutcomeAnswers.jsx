import { humanise, splitAnswers } from "../callOutcome";

// Outcome + recorded answers for one call (pilot review). Read-only.
// Renders nothing for a call with no outcome_code and no answers, so plain
// inbound calls look exactly as before.

export default function CallOutcomeAnswers({ call, t = {} }) {
  if (!call) return null;
  const { rows, note } = splitAnswers(call.answers);
  const outcome = call.outcome_code;
  if (!outcome && !rows.length && !note) return null;

  return (
    <div className="detail-card" data-testid="call-outcome-answers">
      <h3 className="detail-card-title">{t.outcomeAnswersTitle || "Outcome & answers"}</h3>
      <div className="info-grid">
        {outcome ? (
          <>
            <div className="info-label">{t.outcomeLabel || "Outcome"}</div>
            <div className="info-value">{humanise(outcome)}</div>
          </>
        ) : null}
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <div className="info-label">{humanise(k)}</div>
            <div className="info-value">{v}</div>
          </div>
        ))}
        {note ? (
          <>
            <div className="info-label">{t.outcomeNoteLabel || "Note"}</div>
            <div className="info-value">{note}</div>
          </>
        ) : null}
      </div>
    </div>
  );
}

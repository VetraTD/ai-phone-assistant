import { CALL_MOMENTS, OTHER_CALLS } from "../content/callMoments.js";
import "./CallMoments.css";

/**
 * What happened on the call above, as a ruled page: the clock in the margin,
 * what the receptionist did on the line, and its actual words beneath. "Hear
 * it" seeks the hero's player to that moment.
 */
export default function CallMoments({ onHear }) {
  return (
    <div className="moments site-page site-page--lined">
      <ol className="moments__list">
        {CALL_MOMENTS.map((m) => (
          <li key={m.at} className="moments__row site-row">
            <span className="site-row__margin moments__time">{m.label}</span>
            <div className="site-row__entry moments__entry">
              <p className="moments__does">{m.does}</p>
              <blockquote className="moments__excerpt">{m.excerpt}</blockquote>
              {onHear ? (
                <button type="button" className="moments__hear" onClick={() => onHear(m.at)}>
                  Hear it
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      <div className="moments__others site-row">
        <span className="site-row__margin moments__time">Also</span>
        <ul className="site-row__entry moments__otherlist">
          {OTHER_CALLS.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

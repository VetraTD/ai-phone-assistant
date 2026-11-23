import { Link } from "react-router-dom";
import { dayHeading, formatDateTime, formatTime } from "../../calls/format";

function firstSentence(text) {
  if (typeof text !== "string" || !text.trim()) return "";
  const t = text.trim();
  const end = t.search(/[.!?](\s|$)/);
  return end === -1 ? t : t.slice(0, end + 1);
}

/**
 * The caller column: their other calls to this business and their bookings
 * from yesterday to a week ahead. A third column on wide screens, under the
 * call on narrower ones.
 */
export default function CallerPanel({ history, tz }) {
  const calls = history?.calls || [];
  const bookings = history?.bookings || [];
  return (
    <aside className="vt-ictx" aria-label="This caller">
      <div className="vt-blk">
        <h3>Other calls from this number</h3>
        {calls.length ? (
          <ul className="vt-evs">
            {calls.map((c) => (
              <li key={c.id}>
                <Link className="vt-ev" to={`/inbox/${c.id}`}>
                  <b>{`${dayHeading(c.started_at, tz)}, ${formatTime(c.started_at, tz)}`}</b>
                  {c.summary ? <span>{firstSentence(c.summary)}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p>No other calls from this number.</p>
        )}
      </div>
      <div className="vt-blk">
        <h3>Their bookings this week</h3>
        {bookings.length ? (
          <ul className="vt-evs">
            {bookings.map((b) => (
              <li key={b.id} className="vt-ev">
                <b>{formatDateTime(b.scheduled_at, tz)}</b>
                <span>{b.status === "cancelled" ? "Cancelled" : b.client_name || "Booking"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No bookings this week.</p>
        )}
      </div>
    </aside>
  );
}

import "./DiaryPage.css";

const HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
// Rows kept on narrow screens: the booking's hour and its neighbours.
const MOBILE_WINDOW = new Set([12, 13, 14, 15, 16]);

function slotState(hour, currentTime, call) {
  if (hour !== call.booking.hour) return "empty";
  if (currentTime >= call.moments.bookedAt) return "booked";
  if (currentTime >= call.moments.offeredAt) return "offered";
  return "empty";
}

/**
 * Today's page of the appointments diary. It stays empty until the
 * receptionist offers the slot, is outlined while the caller decides, and is
 * written in the moment the booking is confirmed. Nothing here is invented:
 * the entry is what the call above actually books. Below the last hour the
 * page ends with the day's notes, as a diary page does.
 */
export default function DiaryPage({ currentTime, call }) {
  const { booking } = call;
  const state = slotState(booking.hour, currentTime, call);

  return (
    <div className="diary site-page" aria-live="polite">
      <div className="diary__head">
        <h2 className="diary__date">{booking.dayLabel}</h2>
        <span className="diary__clinic site-muted site-small">{call.clinic}</span>
      </div>

      <ol className="diary__slots">
        {HOURS.map((h) => {
          const label = `${String(h).padStart(2, "0")}:00`;
          const s = h === booking.hour ? state : "empty";
          return (
            <li
              key={h}
              className={`diary__slot site-row ${MOBILE_WINDOW.has(h) ? "" : "diary__slot--wide"} is-${s}`.trim()}
            >
              <span className="site-row__margin diary__time">{label}</span>
              <span className="site-row__entry diary__entry">
                {s === "offered" ? (
                  <span className="diary__pending">
                    <span className="diary__marker" aria-hidden="true" />
                    Offered to the caller
                  </span>
                ) : null}
                {s === "booked" ? (
                  <span className="diary__written">
                    <span className="diary__marker diary__marker--ink" aria-hidden="true" />
                    <strong className="diary__who">{booking.who}</strong>
                    <span className="diary__what">
                      {booking.what}, {booking.minutes} min
                    </span>
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="diary__notes site-row">
        <span className="site-row__margin diary__time">Notes</span>
        <p className="site-row__entry diary__note">
          {state === "booked"
            ? "Closed from 18:00. Booked after hours by the receptionist; the caller was told the cancellation terms and what to bring."
            : state === "offered"
              ? "Closed from 18:00. The receptionist has offered this slot; play on to hear it booked."
              : "Closed from 18:00. Calls are still answered, and bookings go into the next open day. Play the call to see one written in."}
        </p>
      </div>
    </div>
  );
}

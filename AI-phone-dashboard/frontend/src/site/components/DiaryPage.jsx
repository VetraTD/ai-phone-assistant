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
 * the entry is what the call above actually books.
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
                    <strong>{booking.who}</strong>
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

      <p className="diary__foot site-small site-muted">
        {state === "booked"
          ? "Written into the book by the receptionist during the call."
          : state === "offered"
            ? "The receptionist has offered this slot. Play on to hear it booked."
            : "Play the call to see the booking written in."}
      </p>
    </div>
  );
}

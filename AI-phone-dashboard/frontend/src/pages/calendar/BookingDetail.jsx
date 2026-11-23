import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { formatDate, formatDateTime, telHref } from "../../calls/format";

// The newest change a call made to this booking (migration 062).
const CHANGE_WORDS = {
  moved: { line: "Moved here", link: "Open the call that moved it" },
  cancelled: { line: "Cancelled", link: "Open the call that cancelled it" },
};

/**
 * One booking: when, who, their number, its notes, and the call that made it.
 * A popover on desktop (`position` places it beside the booking) and a panel
 * across the bottom on phones. Escape, Close or a click outside closes it; the
 * Calendar puts focus back on the booking.
 */
export default function BookingDetail({ booking, tz, onClose, position, variant = "popover" }) {
  const ref = useRef(null);
  const latestClose = useRef(onClose);
  useEffect(() => {
    latestClose.current = onClose;
  });

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") latestClose.current();
    };
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target) && !e.target.closest?.("[data-booking]")) latestClose.current();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, []);

  const name = booking.client_name?.trim() || "Caller";
  const phone = typeof booking.client_phone === "string" ? booking.client_phone.trim() : "";
  const href = telHref(phone);
  const notes = typeof booking.notes === "string" ? booking.notes.trim() : "";
  const cancelled = booking.status === "cancelled";
  const when = formatDateTime(booking.scheduled_at, tz);
  const bookedOn = booking.booked_on ? ` on ${formatDate(booking.booked_on, tz)}` : "";
  const change = booking.last_change && CHANGE_WORDS[booking.last_change.kind] ? booking.last_change : null;
  const changeWords = change ? CHANGE_WORDS[change.kind] : null;
  const changedOn = change?.created_at ? ` on ${formatDate(change.created_at, tz)}` : "";

  return (
    <div
      ref={ref}
      className={`vt-cal-detail vt-cal-detail-${variant}`}
      role="dialog"
      aria-label={`${when}, ${name}`}
      tabIndex={-1}
      style={variant === "popover" ? position : undefined}
    >
      <p className="vt-cal-detail-when vt-num">{when}</p>
      {cancelled ? <p className="vt-cal-detail-cancelled">Cancelled</p> : null}
      <p className="vt-cal-detail-name">{name}</p>
      {phone ? (
        href ? (
          <a className="vt-link vt-cal-detail-phone vt-num" href={href}>
            {phone}
          </a>
        ) : (
          <p className="vt-cal-detail-phone vt-num">{phone}</p>
        )
      ) : null}
      {notes ? <p className="vt-cal-detail-notes">{notes}</p> : null}
      <div className="vt-cal-detail-source">
        <p>{`Booked by VetraTD on a call${bookedOn}`}</p>
        {booking.call_id ? (
          <Link className="vt-link" to={`/inbox/${booking.call_id}`}>
            Open the call
          </Link>
        ) : null}
        {change ? (
          <>
            <p className="vt-cal-detail-change">
              {change.call_id ? `${changeWords.line} by VetraTD on a call${changedOn}` : `${changeWords.line}${changedOn}`}
            </p>
            {change.call_id ? (
              <Link className="vt-link" to={`/inbox/${change.call_id}`} aria-label={changeWords.link}>
                Open the call
              </Link>
            ) : null}
          </>
        ) : null}
      </div>
      <button type="button" className="vt-btn vt-btn-quiet vt-cal-detail-close" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

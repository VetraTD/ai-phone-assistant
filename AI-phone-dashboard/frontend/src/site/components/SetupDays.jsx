import { SETUP_DAYS } from "../content/setupDays.js";
import "./SetupDays.css";

/** Onboarding as three consecutive diary pages. */
export default function SetupDays() {
  return (
    <ol className="days">
      {SETUP_DAYS.map((d) => (
        <li key={d.day} className="days__page site-page site-page--lined">
          <div className="days__head">
            <h3 className="days__day">{d.day}</h3>
            <p className="days__title">{d.title}</p>
          </div>
          <ul className="days__rows">
            {d.rows.map((row) => (
              <li key={row} className="days__row">
                {row}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

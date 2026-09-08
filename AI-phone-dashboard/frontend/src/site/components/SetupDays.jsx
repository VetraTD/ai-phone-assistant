import { SETUP_DAYS } from "../content/setupDays.js";
import "./SetupDays.css";

/** Onboarding as three consecutive days on one page of the diary. */
export default function SetupDays() {
  return (
    <ol className="days site-page site-page--lined">
      {SETUP_DAYS.map((d) => (
        <li key={d.day} className="days__day site-row">
          <span className="site-row__margin days__label">{d.day}</span>
          <div className="site-row__entry days__entry">
            <h3 className="days__title">{d.title}</h3>
            {d.rows.map((row) => (
              <p key={row} className="days__row">
                {row}
              </p>
            ))}
          </div>
        </li>
      ))}
    </ol>
  );
}

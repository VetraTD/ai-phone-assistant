import { CALL_RECORD } from "../content/callRecord.js";
import "./CallRecord.css";

/** The dashboard's record of the call above, as a ruled page. */
export default function CallRecord() {
  return (
    <dl className="record site-page site-page--lined">
      {CALL_RECORD.map((row) => (
        <div key={row.label} className="record__row site-row">
          <dt className="site-row__margin record__label">{row.label}</dt>
          <dd className="site-row__entry record__value">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

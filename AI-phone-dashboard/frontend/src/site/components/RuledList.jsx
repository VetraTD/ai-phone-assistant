import "./RuledList.css";

/**
 * A ruled page of label/value rows: the label in the diary's margin, the
 * entry on the line. Used for the call record, "who it is for", and any
 * other short list of facts.
 */
export default function RuledList({ rows, className = "", labelWidth }) {
  const style = labelWidth ? { "--site-margin": labelWidth } : undefined;
  return (
    <dl className={`ruled site-page site-page--lined ${className}`.trim()} style={style}>
      {rows.map((row) => (
        <div key={row.label} className="ruled__row site-row">
          <dt className="site-row__margin ruled__label">{row.label}</dt>
          <dd className="site-row__entry ruled__value">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

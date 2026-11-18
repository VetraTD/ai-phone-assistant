// Shared panel wrapper matching the dashboard's existing
// panel/panel-header/panel-title/panel-body classNames (Dashboard.css) — no
// new design system, just the same shell the rest of the dashboard uses.
export default function SectionCard({ title, description, action, children, fullWidth }) {
  return (
    <section className="panel" style={fullWidth ? { gridColumn: "1 / -1" } : undefined}>
      <div
        className="panel-header"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
      >
        <h2 className="panel-title">{title}</h2>
        {action || null}
      </div>
      <div className="panel-body" style={{ display: "grid", gap: 14 }}>
        {description ? (
          <p className="field-hint" style={{ margin: 0 }}>
            {description}
          </p>
        ) : null}
        {children}
      </div>
    </section>
  );
}

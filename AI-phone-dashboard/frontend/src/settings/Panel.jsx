/**
 * The one card shell every settings section uses.
 *
 * Replaces SectionCard's borrowed .panel/.panel-header/.panel-body classes from
 * Dashboard.css. The important addition is `saveOwner`: the page mixes two save
 * models — most panels edit a shared draft committed by one page-level diff,
 * while capability cards and the knowledge base save themselves — and until now
 * nothing on screen told you which kind you were looking at.
 *
 *   saveOwner="page"  → no button; the sticky save bar owns it. A dirty panel
 *                       shows an "Unsaved" pill pointing back at that bar.
 *   saveOwner="self"  → renders `footer`, which carries its own Save + status.
 *
 * Clean page-owned panels get no save chrome at all, which is the point: the
 * absence is only readable as "the bar has this" if it is consistent.
 */
export default function Panel({
  title,
  description,
  badge,
  actions,
  unsaved = false,
  muted = false,
  footer,
  children,
  id,
}) {
  const showHeadRight = badge || unsaved || actions;

  return (
    <section className={`set-panel${muted ? " is-muted" : ""}`} id={id}>
      <div className="set-panel-head">
        <div className="set-panel-headings">
          <h3 className="set-panel-title">{title}</h3>
          {description ? <p className="set-panel-desc">{description}</p> : null}
        </div>
        {showHeadRight ? (
          <div className="set-panel-head-right">
            {badge}
            {unsaved ? <span className="set-pill set-pill-unsaved">Unsaved</span> : null}
            {actions}
          </div>
        ) : null}
      </div>

      <div className="set-panel-body">{children}</div>

      {footer ? <div className="set-panel-foot">{footer}</div> : null}
    </section>
  );
}

import "./LegalDocument.css";

/**
 * A legal document as a page: title, the date it was last changed (a fixed
 * string in the content file, never "today"), a contents list, and the
 * sections. Contents sit beside the text on wide screens and above it on
 * narrow ones.
 */
export default function LegalDocument({ doc }) {
  return (
    <article className="legal">
      <header className="legal__head">
        <div className="site-container">
          <h1 className="site-h1 legal__title">{doc.title}</h1>
          <p className="legal__meta site-muted">
            Last updated {doc.updated}
            {doc.entity ? <span className="legal__entity"> · {doc.entity}</span> : null}
          </p>
          {doc.intro ? <div className="legal__intro site-prose">{doc.intro}</div> : null}
        </div>
      </header>

      <div className="site-container legal__grid">
        <nav className="legal__toc" aria-label="Contents">
          <h2 className="legal__toc-title">Contents</h2>
          <ol className="legal__toc-list">
            {doc.sections.map((s, i) => (
              <li key={s.id}>
                <a className="legal__toc-link" href={`#${s.id}`}>
                  <span className="legal__toc-num site-tabular">{i + 1}</span>
                  {s.heading}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="legal__body">
          {doc.sections.map((s, i) => (
            <section key={s.id} id={s.id} className="legal__section site-anchor" aria-labelledby={`${s.id}-h`}>
              <h2 id={`${s.id}-h`} className="legal__h2">
                <span className="legal__num site-tabular">{i + 1}</span>
                {s.heading}
              </h2>
              <div className="site-prose">{s.body}</div>
            </section>
          ))}
        </div>
      </div>
    </article>
  );
}

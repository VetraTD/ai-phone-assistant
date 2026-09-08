import "./PageHero.css";

/** Heading block for the secondary pages. The heading carries its own weight. */
export default function PageHero({ title, lead, children }) {
  return (
    <header className="page-hero">
      <div className="site-container">
        <h1 className="site-h1 page-hero__title">{title}</h1>
        {lead ? <p className="site-lead page-hero__lead">{lead}</p> : null}
        {children}
      </div>
    </header>
  );
}

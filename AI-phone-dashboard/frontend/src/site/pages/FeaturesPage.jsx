import { usePageMeta } from "../usePageMeta.js";
import { FEATURE_GROUPS, NOT_YET } from "../content/features.js";
import PageHero from "../components/PageHero.jsx";
import ClosingBand from "../components/ClosingBand.jsx";
import "./FeaturesPage.css";

export default function FeaturesPage() {
  usePageMeta({
    title: "Features",
    description: "What Vetra does on a call, after a call, and the controls you keep. Everything here is running today.",
    path: "/features",
  });

  return (
    <>
      <PageHero
        title="What Vetra does"
        lead="On the call, after the call, and the controls you keep. Everything on this page is running today; if it is not here, we do not claim it."
      />

      {FEATURE_GROUPS.map((group, i) => (
        <section
          key={group.id}
          id={group.id}
          className={`site-section site-anchor flist ${i % 2 === 0 ? "site-section--tint" : ""}`.trim()}
          aria-labelledby={`${group.id}-title`}
        >
          <div className="site-container site-split">
            <div className="site-split__head">
              <h2 id={`${group.id}-title`} className="site-h2">
                {group.title}
              </h2>
            </div>
            <dl className="site-split__body flist__page site-page site-page--lined">
              {group.items.map((item) => (
                <div key={item.name} className="flist__row site-row">
                  <dt className="site-row__margin flist__name">{item.name}</dt>
                  <dd className="site-row__entry flist__detail">{item.detail}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      ))}

      <section className="site-section site-anchor" id="not-yet" aria-labelledby="notyet-title">
        <div className="site-container site-split">
          <div className="site-split__head">
            <h2 id="notyet-title" className="site-h2">
              Not yet
            </h2>
            <p className="site-lead">Asked for often. Said plainly, so nobody finds out after they have signed.</p>
          </div>
          <div className="site-split__body">
            <ul className="flist__notyet">
              {NOT_YET.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="site-p site-muted flist__notyet-foot">
              If one of these matters to you, say so when you request access and we will tell you where it stands.
            </p>
          </div>
        </div>
      </section>

      <ClosingBand id="features-closing" title="Hear it on your own line." />
    </>
  );
}

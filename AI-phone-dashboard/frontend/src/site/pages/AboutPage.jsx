import { usePageMeta } from "../usePageMeta.js";
import { ABOUT, isAboutReady } from "../content/about.js";
import { GO_LIVE } from "../content/siteConfig.js";
import PageHero from "../components/PageHero.jsx";
import SiteButton from "../components/SiteButton.jsx";
import "./AboutPage.css";

// Content comes from content/about.js. Until the owner fills its OWNER_TODO
// slots this page renders them as-is for review and stays out of the nav.
export default function AboutPage() {
  usePageMeta({ title: "About", description: "Who makes Vetra and how it is run.", path: "/about" });
  const ready = isAboutReady();

  return (
    <>
      <PageHero title="About Vetra" lead={ABOUT.headline} />

      {!ready ? (
        <div className="site-container">
          <p className="about__todo" role="status">
            Draft: the OWNER_TODO lines below are placeholders waiting for the founders’ own words. This page is not
            linked from the site until they are filled in.
          </p>
        </div>
      ) : null}

      <section className="site-section site-anchor" id="story" aria-labelledby="story-title">
        <div className="site-container site-split">
          <div className="site-split__head">
            <h2 id="story-title" className="site-h2">
              Why Vetra exists
            </h2>
          </div>
          <div className="site-split__body site-prose about__story">
            {ABOUT.story.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
        </div>
      </section>

      <section className="site-section site-section--tint site-anchor" id="founders" aria-labelledby="founders-title">
        <div className="site-container site-split">
          <div className="site-split__head">
            <h2 id="founders-title" className="site-h2">
              Who makes it
            </h2>
          </div>
          <ul className="site-split__body about__people">
            {ABOUT.founders.map((f) => (
              <li key={f.name} className="about__person site-page site-page--lined">
                {f.photo ? <img className="about__photo" src={f.photo} alt="" width="96" height="96" /> : null}
                <div className="about__person-text">
                  <h3 className="about__name">{f.name}</h3>
                  <p className="about__role">{f.role}</p>
                  <p className="about__bio">{f.bio}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="site-section site-anchor" id="how" aria-labelledby="how-title">
        <div className="site-container site-split">
          <div className="site-split__head">
            <h2 id="how-title" className="site-h2">
              How it is run
            </h2>
          </div>
          <ul className="site-split__body about__facts site-page site-page--lined">
            {ABOUT.facts.map((fact) => (
              <li key={fact} className="about__fact">
                {fact}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="site-section site-section--ink closing" aria-labelledby="about-closing">
        <div className="site-container closing__inner">
          <h2 id="about-closing" className="site-h2 closing__title">
            Talk to us.
          </h2>
          <p className="closing__lead">We set every business up ourselves, and you are {GO_LIVE}.</p>
          <SiteButton to="/contact" variant="on-ink">
            Request access
          </SiteButton>
        </div>
      </section>
    </>
  );
}

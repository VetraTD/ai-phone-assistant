import { GO_LIVE } from "../content/siteConfig.js";
import SiteButton from "./SiteButton.jsx";

/** The last page of the diary: one heading, one line, one button, on ink. */
export default function ClosingBand({ id, title, lead }) {
  return (
    <section className="site-section site-section--ink closing" aria-labelledby={id}>
      <div className="site-container">
        <div className="closing__row">
          <span className="closing__margin">Next</span>
          <div className="closing__entry">
            <h2 id={id} className="site-h2 closing__title">
              {title}
            </h2>
            <p className="closing__lead">
              {lead || `Tell us about your business. We set it up with you, and you are ${GO_LIVE}.`}
            </p>
            <SiteButton to="/contact" variant="on-ink">
              Request access
            </SiteButton>
          </div>
        </div>
      </div>
    </section>
  );
}

import VetraLogo from "../../components/VetraLogo";
import { FOOTER_COLUMNS, HOSTING_REGION, LEGAL_ENTITY, SUPPORT_EMAIL } from "../content/siteConfig.js";
import { isAboutReady } from "../content/about.js";
import { appLoginHref, isAppBuild, siteHref } from "../siteLinks.js";
import SiteLink from "./SiteLink.jsx";
import DemoNumberLink from "./DemoNumberLink.jsx";
import "./SiteFooter.css";

export default function SiteFooter() {
  const aboutReady = isAboutReady();
  const year = new Date().getFullYear();

  return (
    <footer className="site-footer">
      <div className="site-container site-footer__inner">
        <div className="site-footer__brand">
          {isAppBuild ? (
            <VetraLogo href={siteHref("/")} className="site-footer__logo" />
          ) : (
            <VetraLogo to="/" className="site-footer__logo" />
          )}
          <p className="site-footer__tagline">
            A receptionist that answers your phone and keeps your diary. Set up with you, by hand.
          </p>
          <p className="site-footer__hosting">Data hosted in {HOSTING_REGION}.</p>
        </div>

        {FOOTER_COLUMNS.map((col) => (
          <nav key={col.heading} className="site-footer__col" aria-label={col.heading}>
            <h2 className="site-footer__heading">{col.heading}</h2>
            <ul className="site-footer__list">
              {col.links
                .filter((l) => !l.needsAbout || aboutReady)
                .map((l) => (
                  <li key={l.to}>
                    <SiteLink to={l.to} className="site-footer__link">
                      {l.label}
                    </SiteLink>
                  </li>
                ))}
            </ul>
          </nav>
        ))}

        <nav className="site-footer__col" aria-label="Contact">
          <h2 className="site-footer__heading">Contact</h2>
          <ul className="site-footer__list">
            <li>
              <a href={`mailto:${SUPPORT_EMAIL}`} className="site-footer__link">
                {SUPPORT_EMAIL}
              </a>
            </li>
            <li>
              <DemoNumberLink className="site-footer__link" />
            </li>
            <li>
              <a href={appLoginHref} className="site-footer__link">
                Log in to your dashboard
              </a>
            </li>
          </ul>
        </nav>
      </div>

      <div className="site-container site-footer__legal">
        <p className="site-footer__copy">
          © {year} {LEGAL_ENTITY}, trading as Vetra.
        </p>
        <p className="site-footer__copy">Calls are not recorded. Every call is transcribed and summarised in writing.</p>
      </div>
    </footer>
  );
}

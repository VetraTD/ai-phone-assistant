import { useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import "./styles/tokens.css";
import "./styles/base.css";
import SiteHeader from "./components/SiteHeader.jsx";
import SiteFooter from "./components/SiteFooter.jsx";

/**
 * Shell for every public page on both builds: skip link, header, the page,
 * footer. Everything under .site-root reads the --site-* tokens, and nothing
 * outside it (the dashboard) can.
 */
export default function SiteLayout() {
  const { pathname, hash } = useLocation();

  // New page: start at the top. Hash: land on the section.
  useEffect(() => {
    if (hash) {
      const el = document.getElementById(hash.slice(1));
      if (el) {
        el.scrollIntoView({ block: "start" });
        return;
      }
    }
    window.scrollTo(0, 0);
  }, [pathname, hash]);

  return (
    <div className="site-root">
      <a className="site-skip" href="#main">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="site-main" tabIndex={-1}>
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  );
}

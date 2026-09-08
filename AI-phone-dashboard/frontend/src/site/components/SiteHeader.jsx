import { useState } from "react";
import { useLocation } from "react-router-dom";
import { Menu } from "lucide-react";
import VetraLogo from "../../components/VetraLogo";
import { visibleNavItems } from "../nav.js";
import { appLoginHref, isAppBuild, siteHref } from "../siteLinks.js";
import SiteLink from "./SiteLink.jsx";
import SiteButton from "./SiteButton.jsx";
import DemoNumberLink from "./DemoNumberLink.jsx";
import MobileMenu from "./MobileMenu.jsx";
import "./SiteHeader.css";

export default function SiteHeader() {
  const { pathname } = useLocation();
  // The sheet remembers the path it was opened on; navigating anywhere else
  // (a link inside it, or the browser's back button) closes it without an
  // effect having to watch the location.
  const [openedOn, setOpenedOn] = useState(null);
  const open = openedOn === pathname;
  const openMenu = () => setOpenedOn(pathname);
  const closeMenu = () => setOpenedOn(null);

  const items = visibleNavItems();

  return (
    <header className="site-header">
      <div className="site-container site-header__inner">
        {isAppBuild ? <VetraLogo href={siteHref("/")} /> : <VetraLogo to="/" />}

        <nav className="site-nav" aria-label="Site">
          {items.map((item) => (
            <SiteLink
              key={item.to}
              to={item.to}
              className="site-nav__link"
              aria-current={pathname === item.to ? "page" : undefined}
            >
              {item.label}
            </SiteLink>
          ))}
        </nav>

        <div className="site-header__actions">
          <DemoNumberLink className="site-header__phone" />
          <a href={appLoginHref} className="site-header__login">
            Log in
          </a>
          <SiteButton to="/contact" className="site-header__cta">
            Request access
          </SiteButton>
          <button
            type="button"
            className="site-header__menu"
            aria-expanded={open}
            aria-controls="site-menu"
            aria-label="Open menu"
            onClick={openMenu}
          >
            <Menu size={22} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </div>

      <MobileMenu id="site-menu" open={open} onClose={closeMenu} items={items} />
    </header>
  );
}

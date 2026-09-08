import { useCallback, useRef } from "react";
import { X } from "lucide-react";
import VetraLogo from "../../components/VetraLogo";
import { appLoginHref, isAppBuild, siteHref } from "../siteLinks.js";
import SiteLink from "./SiteLink.jsx";
import { useFocusTrap } from "../hooks/useFocusTrap.js";
import { useLockBodyScroll } from "../hooks/useLockBodyScroll.js";
import SiteButton from "./SiteButton.jsx";
import DemoNumberLink from "./DemoNumberLink.jsx";

/**
 * Full-screen navigation sheet for narrow screens. A modal dialog: focus is
 * trapped inside, Escape closes it, the page behind stops scrolling, and
 * focus returns to the button that opened it.
 */
export default function MobileMenu({ id, open, onClose, items }) {
  const ref = useRef(null);
  const close = useCallback(() => onClose(), [onClose]);
  useFocusTrap(ref, open, { onEscape: close });
  useLockBodyScroll(open);

  if (!open) return null;

  return (
    <div className="site-menu" id={id} role="dialog" aria-modal="true" aria-label="Menu" ref={ref} tabIndex={-1}>
      <div className="site-container site-menu__bar">
        {isAppBuild ? <VetraLogo href={siteHref("/")} /> : <VetraLogo to="/" />}
        <button type="button" className="site-menu__close" aria-label="Close menu" onClick={close}>
          <X size={22} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <nav className="site-container site-menu__nav" aria-label="Site">
        {items.map((item) => (
          <SiteLink key={item.to} to={item.to} className="site-menu__link" onClick={close}>
            {item.label}
          </SiteLink>
        ))}
      </nav>

      <div className="site-container site-menu__actions">
        <SiteButton to="/contact" onClick={close}>
          Request access
        </SiteButton>
        <a href={appLoginHref} className="site-menu__login">
          Log in
        </a>
        <DemoNumberLink className="site-menu__phone" />
      </div>
    </div>
  );
}

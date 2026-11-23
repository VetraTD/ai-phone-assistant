import { Suspense } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useBusiness } from "./BusinessContext";
import { calendarAvailable, navItems } from "./nav";
import "./tokens.css";
import "./shell.css";

/**
 * The frame every signed-in page sits in. Desktop: a navy side navigation with
 * the mark, the business name and the tabs, Settings pinned at the bottom.
 * Phone (760 px and below): a bottom tab bar with the short labels. Both
 * navigations are in the DOM and CSS shows one, so nothing flips on resize.
 */
export default function AppShell() {
  const { business, definitions, capabilityRows, openCount } = useBusiness();
  const items = navItems({ calendarAvailable: calendarAvailable(definitions, capabilityRows) });
  const main = items.filter((i) => i.to !== "/settings");
  const settings = items.find((i) => i.to === "/settings");
  const count = openCount > 0 ? openCount : 0;

  const badge = (to, className) =>
    to === "/home" && count ? (
      <>
        <span className={className} aria-hidden="true">
          {count}
        </span>
        <span className="vt-sr-only">{`, ${count} ${count === 1 ? "caller needs" : "callers need"} you`}</span>
      </>
    ) : null;

  return (
    <div className="vt-app vt-shell">
      <a className="vt-skip" href="#main">
        Skip to content
      </a>

      <nav className="vt-sidenav" aria-label="Main">
        <div className="vt-brand">
          <img src="/vetra-mark-64.png" alt="" width="30" height="30" />
          <span>VetraTD</span>
        </div>
        <p className="vt-bizname">{business?.name}</p>
        <ul className="vt-navlist">
          {main.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} className="vt-navitem">
                <item.Icon />
                <span>{item.label}</span>
                {badge(item.to, "vt-navcount vt-num")}
              </NavLink>
            </li>
          ))}
        </ul>
        <ul className="vt-navlist vt-navlist-end">
          <li>
            <NavLink to={settings.to} className="vt-navitem">
              <settings.Icon />
              <span>{settings.label}</span>
            </NavLink>
          </li>
        </ul>
      </nav>

      <main id="main" className="vt-main" tabIndex={-1}>
        {/* A page still loading keeps the navigation on screen. */}
        <Suspense
          fallback={
            <p className="vt-page" role="status">
              Loading this page…
            </p>
          }
        >
          <Outlet />
        </Suspense>
      </main>

      <nav className="vt-tabbar" aria-label="Main" style={{ "--vt-tabs": items.length }}>
        {items.map((item) => (
          <NavLink key={item.to} to={item.to} className="vt-tab">
            <item.Icon size={24} />
            <span>{item.short}</span>
            {badge(item.to, "vt-tabcount vt-num")}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

import { Suspense, lazy, useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { MARKETING_URL, APP_URL, BUILD_TARGET } from "./siteUrl";
import SiteLayout from "./site/SiteLayout.jsx";
import HomePage from "./site/pages/HomePage.jsx";

// ---------------------------------------------------------------------------
// ONE CODEBASE, TWO SITES.
//
//   marketing  vetratd.com, on Vercel, auto-deployed from this repository.
//              Public pages at /, /features, /about, /contact, /privacy,
//              /terms; every route into the product is an ABSOLUTE link to
//              the app origin.
//   app        app.vetratd.com, on Firebase Hosting. Dashboard at `/`. Serves
//              /contact, /privacy and /terms itself (footers link to them);
//              /features and /about leave for the marketing origin.
//
// This split is new only in being DELIBERATE. Both deployments already existed
// and both built the same route table, which is why vetratd.com's "Log in"
// button pointed at a relative /app — correct on the origin it was written for,
// and on vetratd.com a stale dashboard with no Firebase config that loaded
// nothing at all.
//
// It also removes a live hazard: with the dashboard moved to `/`, a merge to
// main would have had Vercel rebuild vetratd.com as a login screen. The public
// marketing site would have disappeared on a push, with nothing in this
// repository mentioning Vercel to suggest why.
//
// THE DASHBOARD IS THE ROOT on the app build. app.vetratd.com/app said "app"
// twice; the origin IS the app.
//
// /app, /login and /signin all redirect there. Notification emails already sent
// carry /app links and DASHBOARD_URL still points at one until the cutover, and
// the fallback route is a 404 — so without the redirect the first thing someone
// clicking "you have a new appointment" would see is "This page doesn't exist."
//
// /legal was the single privacy-and-terms page. It is now two pages; the old
// path redirects so nothing already printed or linked breaks.
//
// HomePage is imported eagerly: it is the marketing build's first paint and
// must not wait on a chunk. Vite tree-shakes it out of the app build. App
// stays lazy so the marketing bundle never carries the dashboard.
//
// Extracted from main.jsx so it can be rendered in a MemoryRouter and tested;
// main.jsx calls createRoot at module scope and cannot be imported by a test.
// ---------------------------------------------------------------------------

const App = lazy(() => import("./App.jsx"));
const ResetPassword = lazy(() => import("./resetPassword.jsx"));
const FeaturesPage = lazy(() => import("./site/pages/FeaturesPage.jsx"));
const AboutPage = lazy(() => import("./site/pages/AboutPage.jsx"));
const ContactPage = lazy(() => import("./site/pages/ContactPage.jsx"));
const PrivacyPage = lazy(() => import("./site/pages/PrivacyPage.jsx"));
const TermsPage = lazy(() => import("./site/pages/TermsPage.jsx"));

/**
 * Leave this origin entirely.
 *
 * `<Navigate>` cannot do this — it routes inside the SPA, so it would resolve
 * an absolute URL as a path and 404. This is what makes an old vetratd.com/app
 * link land on the dashboard instead of a dead page.
 */
export function ExternalRedirect({ to }) {
  useEffect(() => {
    window.location.replace(to);
  }, [to]);
  return <RouteFallback />;
}

export function RouteFallback() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#64748b",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      Loading…
    </div>
  );
}

export function NotFound() {
  // On the app build there is no home page to offer, so this points off-origin
  // at the marketing site. On the marketing build `/` is the home page.
  const home = BUILD_TARGET === "app" ? MARKETING_URL : "/";
  return (
    <div
      style={{
        minHeight: "60vh",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        color: "#0e1c2c",
        fontFamily: "inherit",
        padding: "48px 24px",
      }}
    >
      <h1 style={{ fontSize: 48, margin: 0 }}>404</h1>
      <p style={{ margin: 0, color: "#56697e" }}>This page doesn&apos;t exist.</p>
      <a href={home} style={{ color: "#3a8ff2", fontWeight: 600 }}>
        {BUILD_TARGET === "app" ? "Back to vetratd.com" : "Back to home"}
      </a>
    </div>
  );
}

export default function AppRoutes() {
  const isApp = BUILD_TARGET === "app";

  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        {isApp ? (
          <>
            <Route path="/" element={<App />} />
            <Route path="/app" element={<Navigate to="/" replace />} />
            {/*
              The marketing site links to /login because a nav button should be
              able to point at a path, not a bare domain. Both land on the root,
              which is the dashboard (or its sign-in screen).
            */}
            <Route path="/login" element={<Navigate to="/" replace />} />
            <Route path="/signin" element={<Navigate to="/" replace />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            {/* Public pages that only the marketing origin serves. */}
            <Route path="/features" element={<ExternalRedirect to={`${MARKETING_URL}/features`} />} />
            <Route path="/about" element={<ExternalRedirect to={`${MARKETING_URL}/about`} />} />
            <Route element={<SiteLayout />}>
              <Route path="/contact" element={<ContactPage />} />
              <Route path="/privacy" element={<PrivacyPage />} />
              <Route path="/terms" element={<TermsPage />} />
            </Route>
            <Route path="/legal" element={<Navigate to="/privacy" replace />} />
            <Route path="*" element={<NotFound />} />
          </>
        ) : (
          <>
            {/*
              Rescues every link already out in the world. vetratd.com/app is
              in nav bars, bookmarks and anything already sent; it used to load
              a dashboard with no configuration and die. Now it lands on the
              real one.
            */}
            <Route path="/app" element={<ExternalRedirect to={APP_URL} />} />
            <Route path="/login" element={<ExternalRedirect to={`${APP_URL}/login`} />} />
            <Route path="/signin" element={<ExternalRedirect to={`${APP_URL}/login`} />} />
            <Route path="/legal" element={<Navigate to="/privacy" replace />} />
            <Route element={<SiteLayout />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/features" element={<FeaturesPage />} />
              <Route path="/about" element={<AboutPage />} />
              <Route path="/contact" element={<ContactPage />} />
              <Route path="/privacy" element={<PrivacyPage />} />
              <Route path="/terms" element={<TermsPage />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </>
        )}
      </Routes>
    </Suspense>
  );
}

import { Suspense, lazy } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { MARKETING_URL } from "./siteUrl";

// ---------------------------------------------------------------------------
// THE DASHBOARD IS THE ROOT.
//
// It used to sit at /app, under a `/` that served an in-repo marketing Landing
// page. That made sense while one Firebase site served both on
// <project>.web.app. It stopped making sense the moment the dashboard got its
// own origin: app.vetratd.com/app says "app" twice, and the origin IS the app.
//
// The Landing route is retired rather than moved. vetratd.com is the marketing
// site, it is a different codebase on Vercel, and it is live — so a second
// marketing page served from the app origin is a page that can only ever drift
// out of date. Landing.jsx is left in the tree, unreferenced, so nothing is
// lost if that decision is revisited; because it is no longer imported it does
// not ship in the bundle.
//
// /app REDIRECTS, and that is load-bearing rather than tidy. Owner notification
// emails already sent carry .../app links, DASHBOARD_URL still points there
// until the domain cutover, and the fallback route is a 404 page — so without
// this redirect the first thing a member of staff clicking "you have a new
// appointment" would see is "This page doesn't exist."
//
// Extracted from main.jsx so it can be rendered inside a MemoryRouter and
// tested. main.jsx calls createRoot at module scope and cannot be imported by a
// test without mounting the whole app.
// ---------------------------------------------------------------------------

const App = lazy(() => import("./App.jsx"));
const Legal = lazy(() => import("./Legal.jsx"));
const Contact = lazy(() => import("./Contact.jsx"));
const ResetPassword = lazy(() => import("./resetPassword.jsx"));

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
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        color: "#0f172a",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ fontSize: 48, margin: 0 }}>404</h1>
      <p style={{ margin: 0, color: "#64748b" }}>This page doesn&apos;t exist.</p>
      {/* External: this origin no longer has a home page to go back to. */}
      <a href={MARKETING_URL} style={{ color: "#3a8ff2", fontWeight: 600 }}>
        Back to vetratd.com
      </a>
    </div>
  );
}

export default function AppRoutes() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/app" element={<Navigate to="/" replace />} />
        <Route path="/legal" element={<Legal />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}

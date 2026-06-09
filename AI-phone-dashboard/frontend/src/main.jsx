import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import "./index.css";
import Landing from "./Landing.jsx";

// The dashboard is large; load it only when /app is visited so the
// marketing pages stay lightweight.
const App = lazy(() => import("./App.jsx"));
const Legal = lazy(() => import("./Legal.jsx"));
const Contact = lazy(() => import("./Contact.jsx"));
const ResetPassword = lazy(() => import("./resetPassword.jsx"));

function RouteFallback() {
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

function NotFound() {
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
      <p style={{ margin: 0, color: "#64748b" }}>This page doesn’t exist.</p>
      <Link to="/" style={{ color: "#3a8ff2", fontWeight: 600 }}>
        Back to home
      </Link>
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/app" element={<App />} />
          <Route path="/legal" element={<Legal />} />
          <Route path="/contact" element={<Contact />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </StrictMode>
);

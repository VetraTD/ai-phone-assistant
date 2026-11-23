import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "./fonts.css";
import "./index.css";
import AppRoutes from "./routes.jsx";

// The route table lives in routes.jsx so it can be rendered inside a
// MemoryRouter and tested. This file calls createRoot at module scope, which a
// test cannot import without mounting the whole application.
//
// A DATA router (createBrowserRouter), not <BrowserRouter>: the "unsaved
// changes" guard uses useBlocker, which only works under a data router. The
// whole <Routes> table still lives in AppRoutes, mounted on one catch-all.
const router = createBrowserRouter([{ path: "*", element: <AppRoutes /> }]);

// A dashboard left open across a deploy asks for page files the deploy removed.
// Reload once to pick up the new ones, rather than show an error page; the
// flag stops a loop if the reload does not help.
window.addEventListener("vite:preloadError", (event) => {
  try {
    if (sessionStorage.getItem("vt-reloaded-for-update")) return;
    sessionStorage.setItem("vt-reloaded-for-update", "1");
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});
window.addEventListener("load", () => {
  try {
    setTimeout(() => sessionStorage.removeItem("vt-reloaded-for-update"), 10000);
  } catch {
    /* storage disabled: nothing to clear */
  }
});

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);

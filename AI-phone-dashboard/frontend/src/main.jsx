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

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);

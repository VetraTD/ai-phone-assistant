import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./fonts.css";
import "./index.css";
import AppRoutes from "./routes.jsx";

// The route table lives in routes.jsx so it can be rendered inside a
// MemoryRouter and tested. This file calls createRoot at module scope, which a
// test cannot import without mounting the whole application.
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  </StrictMode>
);

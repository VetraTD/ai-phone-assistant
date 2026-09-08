import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AppRoutes from "../routes.jsx";
import { MARKETING_URL } from "../siteUrl";

// ---------------------------------------------------------------------------
// The dashboard is the root, and /app still works.
//
// app.vetratd.com/app said "app" twice, so the dashboard moved to `/` and the
// in-repo marketing Landing page retired — vetratd.com is the marketing site
// and is a different codebase on Vercel.
//
// THE REDIRECT IS THE PART THAT MATTERS. Owner notification emails already sent
// carry `.../app` links, and DASHBOARD_URL still points there until the domain
// cutover. The router's fallback is a 404 page, so without the redirect the
// first thing a member of staff clicking "you have a new appointment" would
// have seen is "This page doesn't exist." That is a silent, delayed failure of
// exactly the kind this change could easily have shipped.
//
// The dashboard itself is mocked. What it renders is App.jsx's business, and
// mounting it here would drag in Identity Platform, axios and a settings tree;
// these tests ask one question, which is what each URL resolves to.
// ---------------------------------------------------------------------------

vi.mock("../App.jsx", () => ({
  default: () => <div data-testid="dashboard">dashboard</div>,
}));
vi.mock("../Legal.jsx", () => ({ default: () => <div>legal</div> }));
vi.mock("../Contact.jsx", () => ({ default: () => <div data-testid="contact">contact</div> }));
vi.mock("../resetPassword.jsx", () => ({ default: () => <div>reset</div> }));

const at = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>
  );

describe("routing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("serves the dashboard at the root", async () => {
    at("/");
    expect(await screen.findByTestId("dashboard")).toBeTruthy();
  });

  it("redirects /app to the root rather than 404ing", async () => {
    // The failure this prevents is not hypothetical: notification emails
    // already in people's inboxes point at /app.
    at("/app");
    expect(await screen.findByTestId("dashboard")).toBeTruthy();
  });

  it("still serves /contact, which the login page links to", async () => {
    // Self-serve signup is closed and the login form's only onward route is
    // "Request access" -> /contact. If this route goes, that is a dead end for
    // every prospective customer.
    at("/contact");
    expect(await screen.findByTestId("contact")).toBeTruthy();
  });

  it("shows a 404 for an unknown path", async () => {
    at("/nope");
    expect(await screen.findByText("404")).toBeTruthy();
  });

  it("sends 'back to home' OFF this origin, not to the dashboard", async () => {
    // The whole point. `<Link to="/">` used to mean "the marketing landing
    // page". It now means "the dashboard", which bounces a signed-out visitor
    // straight back to the sign-in screen they were trying to leave.
    at("/nope");
    const link = await screen.findByRole("link", { name: /vetratd\.com/i });
    expect(link.getAttribute("href")).toBe(MARKETING_URL);
    expect(link.getAttribute("href")).not.toBe("/");
  });

  it("points at a real external marketing origin", () => {
    expect(MARKETING_URL).toMatch(/^https:\/\//);
    expect(MARKETING_URL).not.toMatch(/\/$/);
  });
});

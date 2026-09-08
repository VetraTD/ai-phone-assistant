import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// ---------------------------------------------------------------------------
// ONE CODEBASE, TWO SITES, and the routing differs between them.
//
//   marketing  vetratd.com on Vercel, auto-deployed from this repo
//   app        app.vetratd.com on Firebase Hosting
//
// Both deployments already existed and both built the SAME route table. That is
// why vetratd.com's "Log in" pointed at a relative /app: correct on the origin
// it was written for, and on vetratd.com a stale dashboard with no Firebase
// configuration that loaded nothing at all.
//
// Three failures are tested here because all were live or imminent:
//
//   1. A marketing link into the product must leave the origin. `<Navigate>`
//      cannot — it routes inside the SPA and would 404 on an absolute URL.
//   2. /app must not become a dead end on EITHER site. On the app build it is a
//      redirect to the root; on marketing it is a redirect to the app origin,
//      which rescues every stale link already in nav bars and inboxes.
//   3. /legal was printed and linked as the privacy page. It is now /privacy
//      and /terms, and the old path must still land somewhere real.
//
// And the default matters: with the dashboard moved to `/`, a merge to main
// would have had Vercel rebuild vetratd.com as a login screen. The public
// marketing site would have vanished on a push.
//
// The public pages are mocked; the site layout (header, footer) is NOT, so
// these tests also prove the shell mounts on both builds and that its links
// point where they should.
// ---------------------------------------------------------------------------

const MARKETING_URL = "https://www.vetratd.com";
const APP_URL = "https://app.vetratd.com";

vi.mock("../App.jsx", () => ({
  default: () => <div data-testid="dashboard">dashboard</div>,
}));
vi.mock("../resetPassword.jsx", () => ({ default: () => <div>reset</div> }));
vi.mock("../site/pages/HomePage.jsx", () => ({
  default: () => <div data-testid="landing">home</div>,
}));
vi.mock("../site/pages/FeaturesPage.jsx", () => ({
  default: () => <div data-testid="features">features</div>,
}));
vi.mock("../site/pages/AboutPage.jsx", () => ({
  default: () => <div data-testid="about">about</div>,
}));
vi.mock("../site/pages/ContactPage.jsx", () => ({
  default: () => <div data-testid="contact">contact</div>,
}));
vi.mock("../site/pages/PrivacyPage.jsx", () => ({
  default: () => <div data-testid="privacy">privacy</div>,
}));
vi.mock("../site/pages/TermsPage.jsx", () => ({
  default: () => <div data-testid="terms">terms</div>,
}));

/** Load the router fresh with a given build target. */
async function routerFor(target) {
  vi.resetModules();
  vi.doMock("../siteUrl", () => ({ MARKETING_URL, APP_URL, BUILD_TARGET: target }));
  const mod = await import("../routes.jsx");
  return mod.default;
}

async function at(target, path) {
  const AppRoutes = await routerFor(target);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>
  );
}

/** Stub window.location.replace so ExternalRedirect can be observed. */
function stubReplace() {
  const replace = vi.fn();
  let original;
  beforeEach(() => {
    vi.clearAllMocks();
    original = window.location;
    delete window.location;
    window.location = { ...original, replace };
  });
  afterEach(() => {
    window.location = original;
  });
  return replace;
}

describe("the app build (app.vetratd.com)", () => {
  const replace = stubReplace();

  it("serves the dashboard at the root", async () => {
    await at("app", "/");
    expect(await screen.findByTestId("dashboard")).toBeTruthy();
  });

  it.each(["/app", "/login", "/signin"])(
    "%s reaches the dashboard rather than 404ing",
    async (path) => {
      // /app is not hypothetical: notification emails already sent point there,
      // and DASHBOARD_URL still does until the domain cutover.
      await at("app", path);
      expect(await screen.findByTestId("dashboard")).toBeTruthy();
    }
  );

  it("does not serve the marketing home page", async () => {
    await at("app", "/");
    expect(screen.queryByTestId("landing")).toBeNull();
  });

  it.each([
    ["/contact", "contact"],
    ["/privacy", "privacy"],
    ["/terms", "terms"],
  ])("serves %s itself, inside the public layout", async (path, testid) => {
    await at("app", path);
    expect(await screen.findByTestId(testid)).toBeTruthy();
    expect(screen.queryByTestId("dashboard")).toBeNull();
    // The layout mounted: its footer names the legal pages.
    expect(screen.getByRole("link", { name: /privacy policy/i })).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it("redirects the old /legal to /privacy", async () => {
    await at("app", "/legal");
    expect(await screen.findByTestId("privacy")).toBeTruthy();
  });

  it.each([
    ["/features", `${MARKETING_URL}/features`],
    ["/about", `${MARKETING_URL}/about`],
  ])("sends %s to the marketing origin", async (path, expected) => {
    await at("app", path);
    expect(replace).toHaveBeenCalledWith(expected);
  });

  it("sends 'back home' OFF this origin", async () => {
    // `<Link to="/">` used to mean the marketing page. On this build it means
    // the dashboard, which bounces a signed-out visitor back to the sign-in
    // screen they were trying to leave.
    await at("app", "/nope");
    const link = await screen.findByRole("link", { name: /vetratd\.com/i });
    expect(link.getAttribute("href")).toBe(MARKETING_URL);
  });

  it("links the public header back to the marketing origin", async () => {
    await at("app", "/contact");
    await screen.findByTestId("contact");
    const navLinks = Array.from(document.querySelectorAll(".site-nav a"));
    const features = navLinks.find((a) => /^features$/i.test(a.textContent.trim()));
    expect(features).toBeTruthy();
    expect(features.getAttribute("href")).toBe(`${MARKETING_URL}/features`);
    // The footer's legal links are served locally on this build.
    const privacy = screen.getByRole("link", { name: /privacy policy/i });
    expect(privacy.getAttribute("href")).toBe("/privacy");
  });
});

describe("the marketing build (vetratd.com)", () => {
  const replace = stubReplace();

  it("serves the home page at the root", async () => {
    await at("marketing", "/");
    expect(await screen.findByTestId("landing")).toBeTruthy();
  });

  it("never serves the dashboard", async () => {
    // The dashboard needs Firebase config and an API URL that the Vercel build
    // does not have. Rendering it there is exactly what produced a Log in
    // button that loaded nothing.
    await at("marketing", "/");
    expect(screen.queryByTestId("dashboard")).toBeNull();
  });

  it.each([
    ["/app", APP_URL],
    ["/login", `${APP_URL}/login`],
    ["/signin", `${APP_URL}/login`],
  ])("sends %s to the app origin, leaving this site", async (path, expected) => {
    await at("marketing", path);
    expect(replace).toHaveBeenCalledWith(expected);
  });

  it.each([
    ["/features", "features"],
    ["/about", "about"],
    ["/contact", "contact"],
    ["/privacy", "privacy"],
    ["/terms", "terms"],
  ])("serves %s", async (path, testid) => {
    await at("marketing", path);
    expect(await screen.findByTestId(testid)).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it("redirects the old /legal to /privacy without leaving the site", async () => {
    await at("marketing", "/legal");
    expect(await screen.findByTestId("privacy")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("the public layout on both builds", () => {
  stubReplace();

  it.each([
    ["marketing", "/"],
    ["app", "/contact"],
  ])("on the %s build, Log in points at the app's /login", async (target, path) => {
    await at(target, path);
    const logins = await screen.findAllByRole("link", { name: /^log in$/i });
    expect(logins.length).toBeGreaterThan(0);
    for (const l of logins) expect(l.getAttribute("href")).toBe(`${APP_URL}/login`);
  });

  it.each([
    ["marketing", "/"],
    ["app", "/contact"],
  ])("on the %s build, renders no phone link while the demo number is off", async (target, path) => {
    await at(target, path);
    await screen.findByRole("link", { name: /privacy policy/i });
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
  });

  it("shows no price anywhere in the shell", async () => {
    await at("marketing", "/");
    await screen.findByRole("link", { name: /privacy policy/i });
    expect(document.body.textContent).not.toMatch(/[$£]\s?\d/);
  });
});

describe("the build target default", () => {
  // The describes above register a doMock for ../siteUrl to drive the router.
  // resetModules clears the module registry but NOT the mock registration, so
  // without this these tests would assert against the last mocked value rather
  // than the real module's default — and would have passed while proving
  // nothing about the thing that protects the public site.
  beforeEach(() => {
    vi.doUnmock("../siteUrl");
    vi.resetModules();
  });

  it("is marketing, so a missing flag cannot replace the public site with a login screen", async () => {
    // Vercel builds with whatever environment it has and this repository cannot
    // set it. Defaulting to "app" would mean a forgotten variable silently
    // replaces vetratd.com on the next push to main.
    vi.stubEnv("VITE_BUILD_TARGET", "");
    const { BUILD_TARGET } = await import("../siteUrl");
    expect(BUILD_TARGET).toBe("marketing");
    vi.unstubAllEnvs();
  });

  it("is app only when asked for explicitly", async () => {
    vi.stubEnv("VITE_BUILD_TARGET", "app");
    const { BUILD_TARGET } = await import("../siteUrl");
    expect(BUILD_TARGET).toBe("app");
    vi.unstubAllEnvs();
  });
});

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
// Two failures are tested here because both were live or imminent:
//
//   1. A marketing link into the product must leave the origin. `<Navigate>`
//      cannot — it routes inside the SPA and would 404 on an absolute URL.
//   2. /app must not become a dead end on EITHER site. On the app build it is a
//      redirect to the root; on marketing it is a redirect to the app origin,
//      which rescues every stale link already in nav bars and inboxes.
//
// And the default matters: with the dashboard moved to `/`, a merge to main
// would have had Vercel rebuild vetratd.com as a login screen. The public
// marketing site would have vanished on a push.
// ---------------------------------------------------------------------------

const MARKETING_URL = "https://www.vetratd.com";
const APP_URL = "https://app.vetratd.com";

vi.mock("../App.jsx", () => ({
  default: () => <div data-testid="dashboard">dashboard</div>,
}));
vi.mock("../Landing.jsx", () => ({
  default: () => <div data-testid="landing">landing</div>,
}));
vi.mock("../Legal.jsx", () => ({ default: () => <div>legal</div> }));
vi.mock("../Contact.jsx", () => ({ default: () => <div data-testid="contact">contact</div> }));
vi.mock("../resetPassword.jsx", () => ({ default: () => <div>reset</div> }));

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

describe("the app build (app.vetratd.com)", () => {
  beforeEach(() => vi.clearAllMocks());

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

  it("does not serve the marketing landing page", async () => {
    await at("app", "/");
    expect(screen.queryByTestId("landing")).toBeNull();
  });

  it("sends 'back home' OFF this origin", async () => {
    // `<Link to="/">` used to mean the marketing page. On this build it means
    // the dashboard, which bounces a signed-out visitor back to the sign-in
    // screen they were trying to leave.
    await at("app", "/nope");
    const link = await screen.findByRole("link", { name: /vetratd\.com/i });
    expect(link.getAttribute("href")).toBe(MARKETING_URL);
  });
});

describe("the marketing build (vetratd.com)", () => {
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

  it("serves the landing page at the root", async () => {
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

  it("keeps its own contact page, which Get started leads to", async () => {
    await at("marketing", "/contact");
    expect(await screen.findByTestId("contact")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
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

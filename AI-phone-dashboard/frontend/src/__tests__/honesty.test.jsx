import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

vi.mock("../auth", () => ({
  onAuthChange(cb) {
    cb(null);
    return () => {};
  },
  signOut: vi.fn(),
}));
vi.mock("../Login", () => ({ default: () => <div>login screen</div> }));
vi.mock("../api", () => ({
  api: { get: vi.fn().mockResolvedValue({ data: { capabilities: [] } }), put: vi.fn() },
}));
vi.mock("../siteUrl", () => ({
  MARKETING_URL: "https://www.vetratd.com",
  APP_URL: "https://app.vetratd.com",
  BUILD_TARGET: "app",
}));

import AppRoutes from "../routes";
import AccountSection from "../settings/AccountSection";
import { GROUPS } from "../settings/groups";

afterEach(() => {
  cleanup();
});

describe("the dashboard shows only what is real", () => {
  it("?demo=1 shows the sign-in screen, never demo data", async () => {
    render(
      <MemoryRouter initialEntries={["/?demo=1"]}>
        <AppRoutes />
      </MemoryRouter>
    );
    // The app chunks load lazily; under a full parallel run that takes a while.
    expect(await screen.findByText("login screen", {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.queryByText(/demo/i)).toBeNull();
  });

  it("the dashboard has no language picker", () => {
    expect(existsSync(join(cwd(), "src/LanguageSwitcher.jsx"))).toBe(false);
  });

  it("Account shows no plan or billing status", () => {
    render(<AccountSection business={{ name: "Brightwork Family Dental" }} usage={null} />);
    expect(screen.queryByText("Starter")).toBeNull();
    expect(screen.queryByText(/billing status/i)).toBeNull();
    expect(screen.queryByText(/billing & plan|current plan|card payments/i)).toBeNull();
  });

  it("the settings menu promises no texts, plan, billing or integrations", () => {
    // Texts are off in production and billing and integrations are not built,
    // so the menu that leads to these panels must not offer them either.
    const words = GROUPS.map((g) => [g.label, g.caption, g.title, g.description].join(" ")).join(" | ");
    expect(words).not.toMatch(/\btext(ed|s)?\b|\bplan\b|billing|integration|connected apps/i);
  });

  it("the marketing page no longer links to a demo", () => {
    const src = readFileSync(join(cwd(), "src/Landing.jsx"), "utf8");
    expect(src).not.toContain("demo=1");
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
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

import App from "../App";
import AccountSection from "../settings/AccountSection";
import { GROUPS } from "../settings/groups";

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("the dashboard shows only what is real", () => {
  it("?demo=1 shows the sign-in screen, never demo data", async () => {
    window.history.replaceState({}, "", "/?demo=1");
    render(<App />);
    expect(await screen.findByText("login screen")).toBeInTheDocument();
    expect(screen.queryByText(/demo/i)).toBeNull();
  });

  it("the dashboard has no language picker", async () => {
    const mod = await import("../LanguageSwitcher");
    expect(mod.LanguageSwitcher).toBeUndefined();
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
    expect(words).not.toMatch(/text(ed|s)?|plan|billing|integration|connected apps/i);
  });

  it("the marketing page no longer links to a demo", () => {
    const src = readFileSync(join(cwd(), "src/Landing.jsx"), "utf8");
    expect(src).not.toContain("demo=1");
  });
});

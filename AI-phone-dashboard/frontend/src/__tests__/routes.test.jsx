import { describe, it, expect, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

// Part 2 replaced the last pages hosted from the old dashboard. These check the
// new ones answer at their addresses and the old ones are gone for good.

const FAKE_BUSINESS = vi.hoisted(() => ({
  business: {
    id: "b1",
    name: "Brightwork Family Dental",
    phone_number: "+15550100199",
    timezone: "America/Chicago",
    notification_email: "frontdesk@brightwork.example",
    notifications_enabled: true,
  },
  businessId: "b1",
  setBusiness: () => {},
  definitions: {
    capabilities: [{ id: "bookings-pack", label: "Bookings", adapterKind: "scheduling", configSchema: { adapter: { default: "own" } } }],
    adapters: { scheduling: [{ id: "own", storesBookingsLocally: true }] },
  },
  capabilityRows: [{ capability_id: "bookings-pack", enabled: true, adapter: null }],
  capabilitiesStatus: "ready",
  reloadCapabilities: () => {},
  openCount: 0,
  setOpenCount: () => {},
}));
vi.mock("../shell/SessionGate.jsx", () => ({ default: ({ children }) => <div>{children}</div> }));
vi.mock("../shell/BusinessContext.jsx", () => ({ BusinessContext: null, useBusiness: () => FAKE_BUSINESS }));
vi.mock("../siteUrl", () => ({
  MARKETING_URL: "https://www.vetratd.com",
  APP_URL: "https://app.vetratd.com",
  BUILD_TARGET: "app",
}));
vi.mock("../auth", () => ({
  currentUser: () => ({ email: "owner@brightwork.example" }),
  sendPasswordReset: vi.fn(async () => ({})),
  signOut: vi.fn(),
  onAuthChange: () => () => {},
}));
vi.mock("../api", () => ({
  api: {
    get: vi.fn(async (url) => {
      if (url === "/api/appointments") return { data: [] };
      if (url === "/api/usage") return { data: { calls_this_month: 0, minutes_this_month: 0 } };
      if (url === "/api/analytics-breakdown") return { data: { total_calls_3m: 0 } };
      return { data: {} };
    }),
    post: vi.fn(),
    put: vi.fn(),
  },
}));

import AppRoutes from "../routes";

const SRC = join(cwd(), "src");

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "__tests__") out.push(...sourceFiles(p));
    } else if (/\.(js|jsx)$/.test(name) && !/\.test\.(js|jsx)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

describe("part 2 pages", () => {
  it("serves the new pages at /calendar, /settings/alerts and /trends", async () => {
    for (const [path, heading] of [
      ["/calendar", "Calendar"],
      ["/settings/alerts", "Settings"],
      ["/trends", "Call trends"],
    ]) {
      // Mounted as main.jsx mounts it: a data router with one catch-all route.
      const router = createMemoryRouter([{ path: "*", element: <AppRoutes /> }], { initialEntries: [path] });
      render(<RouterProvider router={router} />);
      expect(await screen.findByRole("heading", { level: 1, name: heading }, { timeout: 8000 })).toBeInTheDocument();
      cleanup();
    }
  }, 30000);

  it("no source file imports from legacy/", () => {
    const offenders = sourceFiles(SRC).filter((f) =>
      /(?:from\s+|import\s*\(\s*)["'][^"']*\blegacy\//.test(readFileSync(f, "utf8"))
    );
    expect(offenders).toEqual([]);
  });

  it("the old Calendar, Settings and trends pages are gone", () => {
    for (const rel of [
      "legacy",
      "settings/SettingsPage.jsx",
      "settings/SettingsNav.jsx",
      "settings/groups.js",
      "settings/AccountSection.jsx",
    ]) {
      expect(existsSync(join(SRC, rel)), rel).toBe(false);
    }
  });
});

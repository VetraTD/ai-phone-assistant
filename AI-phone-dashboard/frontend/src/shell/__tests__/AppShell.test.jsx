import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AppShell from "../AppShell";
import { BusinessContext } from "../BusinessContext";

const DEFS = {
  capabilities: [{ id: "appointments", core: false, adapterKind: "scheduling" }],
  adapters: { scheduling: [{ id: "internal", storesBookingsLocally: true }] },
};

function renderShell({ path = "/home", openCount = 0, rows = [] } = {}) {
  const value = {
    business: { id: "b1", name: "Brightwork Family Dental", phone_number: "+15550100" },
    businessId: "b1",
    setBusiness: () => {},
    definitions: DEFS,
    capabilityRows: rows,
    reloadCapabilities: () => {},
    openCount,
    setOpenCount: () => {},
  };
  return render(
    <BusinessContext.Provider value={value}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="*" element={<h1>page</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </BusinessContext.Provider>
  );
}

const sideNav = () => screen.getAllByRole("navigation", { name: "Main" })[0];
const tabBar = () => screen.getAllByRole("navigation", { name: "Main" })[1];

describe("AppShell", () => {
  it("shows the business name and marks the current tab", () => {
    renderShell({ path: "/inbox/abc" });
    expect(screen.getByText("Brightwork Family Dental")).toBeInTheDocument();
    expect(within(sideNav()).getByRole("link", { name: "Inbox" })).toHaveAttribute("aria-current", "page");
    expect(within(sideNav()).getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
  });

  it("has no Calendar tab without a calendar, and one with it", () => {
    renderShell();
    expect(within(sideNav()).queryByRole("link", { name: "Calendar" })).toBeNull();
    renderShell({ rows: [{ capability_id: "appointments", enabled: true, adapter: "internal" }] });
    expect(within(screen.getAllByRole("navigation", { name: "Main" })[2]).getByRole("link", { name: "Calendar" })).toBeInTheDocument();
  });

  it("counts the callers who need you on Home, and says it in words", () => {
    renderShell({ openCount: 3 });
    expect(within(sideNav()).getByRole("link", { name: "Home, 3 callers need you" })).toBeInTheDocument();
    expect(within(tabBar()).getByRole("link", { name: "Home, 3 callers need you" })).toBeInTheDocument();
  });

  it("uses the short label on the phone bar", () => {
    renderShell();
    expect(within(tabBar()).getByRole("link", { name: "Agent" })).toBeInTheDocument();
    expect(within(sideNav()).getByRole("link", { name: "Voice agent" })).toBeInTheDocument();
  });

  it("offers a skip link to the page content", () => {
    renderShell();
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main");
    expect(document.getElementById("main")).toHaveAttribute("tabindex", "-1");
  });
});

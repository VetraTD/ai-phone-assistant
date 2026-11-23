import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link } from "react-router-dom";
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

  it("moving to another tab puts focus on the page, so a screen reader starts there", async () => {
    const user = userEvent.setup();
    renderShell({ path: "/home" });
    await user.click(within(sideNav()).getByRole("link", { name: "Inbox" }));
    expect(document.activeElement).toBe(document.getElementById("main"));
  });

  it("choosing a call inside the Inbox leaves focus where it was", async () => {
    const user = userEvent.setup();
    render(
      <BusinessContext.Provider value={{ business: { name: "B" }, definitions: null, capabilityRows: [], openCount: 0 }}>
        <MemoryRouter initialEntries={["/inbox"]}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/inbox" element={<Link to="/inbox/c1">open call</Link>} />
              <Route path="/inbox/:id" element={<Link to="/inbox/c2">next call</Link>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </BusinessContext.Provider>
    );
    await user.click(screen.getByRole("link", { name: "open call" }));
    expect(document.activeElement).not.toBe(document.getElementById("main"));
  });
});

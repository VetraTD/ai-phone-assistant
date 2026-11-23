import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, Link } from "react-router-dom";
import { Suspense, lazy, useState } from "react";
import { useUnsavedChangesGuard } from "../useUnsavedChangesGuard";
import CalendarRoute from "../CalendarRoute";
import AppShell from "../AppShell";
import { BusinessContext } from "../BusinessContext";

function Editor() {
  const [dirty, setDirty] = useState(false);
  const dialog = useUnsavedChangesGuard(dirty);
  return (
    <div>
      <h1>Editor</h1>
      <button type="button" onClick={() => setDirty(true)}>
        make a change
      </button>
      <Link to="/elsewhere">go elsewhere</Link>
      {dialog}
    </div>
  );
}

describe("leaving with unsaved changes", () => {
  const routes = [
    { path: "/editor", element: <Editor /> },
    { path: "/elsewhere", element: <h1>Elsewhere</h1> },
  ];
  const renderEditor = () =>
    render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ["/editor"] })} />);

  it("leaves at once when nothing changed", async () => {
    renderEditor();
    await userEvent.setup().click(screen.getByRole("link", { name: "go elsewhere" }));
    expect(await screen.findByRole("heading", { name: "Elsewhere" })).toBeInTheDocument();
  });

  it("asks first; Keep editing stays, Leave goes", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByRole("button", { name: "make a change" }));
    await user.click(screen.getByRole("link", { name: "go elsewhere" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("You have unsaved changes. Leave without saving?");
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("heading", { name: "Editor" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("link", { name: "go elsewhere" }));
    await user.click(screen.getByRole("button", { name: "Leave" }));
    expect(await screen.findByRole("heading", { name: "Elsewhere" })).toBeInTheDocument();
  });
});

const DEFS = {
  capabilities: [{ id: "appointments", adapterKind: "scheduling", configSchema: { adapter: { default: "internal" } } }],
  adapters: {
    scheduling: [
      { id: "internal", storesBookingsLocally: true },
      { id: "athenahealth", storesBookingsLocally: false },
    ],
  },
};
const business = (over) => ({
  business: { id: "b1", name: "Brightwork Family Dental", phone_number: "+15550100" },
  businessId: "b1",
  setBusiness: () => {},
  definitions: DEFS,
  capabilityRows: [],
  capabilitiesStatus: "ready",
  reloadCapabilities: () => {},
  openCount: 0,
  setOpenCount: () => {},
  ...over,
});

describe("the Calendar address", () => {
  const routes = [
    {
      path: "/calendar",
      element: (
        <CalendarRoute>
          <h1>Calendar page</h1>
        </CalendarRoute>
      ),
    },
    { path: "/home", element: <h1>Home page</h1> },
  ];
  const withBusiness = (value) => (
    <BusinessContext.Provider value={value}>
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: ["/calendar"] })} />
    </BusinessContext.Provider>
  );

  it("opens for a business whose bookings are in VetraTD's calendar", async () => {
    render(withBusiness(business({ capabilityRows: [{ capability_id: "appointments", enabled: true, adapter: "internal" }] })));
    expect(await screen.findByRole("heading", { name: "Calendar page" })).toBeInTheDocument();
  });

  it("sends a business without one to Home", async () => {
    render(withBusiness(business({ capabilityRows: [{ capability_id: "appointments", enabled: true, adapter: "athenahealth" }] })));
    expect(await screen.findByRole("heading", { name: "Home page" })).toBeInTheDocument();
  });

  it("waits while the business's actions are still loading", async () => {
    render(withBusiness(business({ definitions: null, capabilitiesStatus: "loading" })));
    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Home page" })).toBeNull();
  });
});

describe("a page that is still loading", () => {
  it("keeps the navigation on screen and says it is loading", async () => {
    const Never = lazy(() => new Promise(() => {}));
    const router = createMemoryRouter([{ element: <AppShell />, children: [{ path: "/slow", element: <Never /> }] }], {
      initialEntries: ["/slow"],
    });
    render(
      <BusinessContext.Provider value={business()}>
        <Suspense fallback={<p>whole app replaced</p>}>
          <RouterProvider router={router} />
        </Suspense>
      </BusinessContext.Provider>
    );
    expect(await screen.findByText("Loading this page…")).toBeInTheDocument();
    expect(screen.getAllByRole("navigation", { name: "Main" }).length).toBeGreaterThan(0);
    expect(screen.queryByText("whole app replaced")).toBeNull();
  });
});

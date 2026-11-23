import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";

vi.mock("../../api", () => ({ api: { get: vi.fn(), put: vi.fn() } }));
vi.mock("../../auth", () => ({
  currentUser: vi.fn(() => ({ email: "owner@brightwork.example" })),
  sendPasswordReset: vi.fn(async () => ({})),
  signOut: vi.fn(async () => {}),
}));

import { api } from "../../api";
import { sendPasswordReset, signOut } from "../../auth";
import Settings from "../Settings";
import { BusinessContext } from "../../shell/BusinessContext";

const BUSINESS = {
  id: "b1",
  name: "Brightwork Family Dental",
  phone_number: "+15550100199",
  timezone: "America/Chicago",
  notification_email: "frontdesk@brightwork.example",
  notifications_enabled: true,
};

function renderSettings(path = "/settings") {
  const value = {
    business: BUSINESS,
    businessId: "b1",
    setBusiness: vi.fn(),
    definitions: null,
    capabilityRows: [],
    capabilitiesStatus: "ready",
    reloadCapabilities: vi.fn(),
    openCount: 0,
    setOpenCount: vi.fn(),
  };
  const router = createMemoryRouter(
    [
      { path: "/settings", element: <Settings /> },
      { path: "/settings/:item", element: <Settings /> },
      { path: "/home", element: <h1>Home page</h1> },
      { path: "/trends", element: <h1>Trends page</h1> },
      { path: "/contact", element: <h1>Contact page</h1> },
    ],
    { initialEntries: [path] }
  );
  render(
    <BusinessContext.Provider value={value}>
      <RouterProvider router={router} />
    </BusinessContext.Provider>
  );
  return router;
}

describe("Settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue({ data: { calls_this_month: 42, minutes_this_month: 130 } });
  });

  it("lists the five items and opens Email alerts by default", () => {
    renderSettings("/settings");
    const list = screen.getByRole("list", { name: "Settings" });
    expect(within(list).getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Email alerts",
      "Your number",
      "Your login",
      "Usage",
      "Help",
    ]);
    expect(screen.getByLabelText(/Notification email/)).toHaveValue("frontdesk@brightwork.example");
  });

  it("saves only the alert address", async () => {
    const user = userEvent.setup();
    api.put.mockResolvedValue({ data: { ...BUSINESS, notification_email: "new@brightwork.example" } });
    renderSettings("/settings/alerts");
    const field = screen.getByLabelText(/Notification email/);
    await user.clear(field);
    await user.type(field, "new@brightwork.example");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(api.put).toHaveBeenCalledWith("/api/business/b1/settings", { notification_email: "new@brightwork.example" });
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });

  it("asks before leaving with an unsaved address", async () => {
    const user = userEvent.setup();
    const router = renderSettings("/settings/alerts");
    await user.type(screen.getByLabelText(/Notification email/), "x");
    await router.navigate("/home");
    expect(await screen.findByRole("dialog")).toHaveTextContent("You have unsaved changes. Leave without saving?");
  });

  it("shows the number callers reach, with no claims about forwarding", async () => {
    renderSettings("/settings/number");
    expect(screen.getByText("+1 (555) 010-0199")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy number" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "message us" })).toHaveAttribute("href", "/contact");
  });

  it("sends the password link to the signed-in email", async () => {
    const user = userEvent.setup();
    renderSettings("/settings/login");
    expect(screen.getByText("owner@brightwork.example")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Email me a link to change my password" }));
    expect(sendPasswordReset).toHaveBeenCalledWith(
      "owner@brightwork.example",
      expect.objectContaining({ continueUrl: expect.stringMatching(/\/reset-password$/) })
    );
    expect(
      await screen.findByText("We've sent a link to owner@brightwork.example. Open it to choose a new password.")
    ).toBeInTheDocument();
  });

  it("says so when the password link can't be sent", async () => {
    const user = userEvent.setup();
    sendPasswordReset.mockResolvedValueOnce({ error: "Too many attempts" });
    renderSettings("/settings/login");
    await user.click(screen.getByRole("button", { name: "Email me a link to change my password" }));
    expect(await screen.findByText("Couldn't send the link. Try again in a minute.")).toBeInTheDocument();
  });

  it("shows this month's usage and links to call trends", async () => {
    renderSettings("/settings/usage");
    expect(await screen.findByText("130")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("Counts from the 1st, in your business's time zone.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See call trends" })).toHaveAttribute("href", "/trends");
    expect(api.get).toHaveBeenCalledWith("/api/usage");
  });

  it("has no billing, plan or team panel", async () => {
    for (const item of ["alerts", "number", "login", "usage", "help"]) {
      renderSettings(`/settings/${item}`);
      await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument());
      expect(screen.queryByText(/billing|plan|team/i)).toBeNull();
      cleanup();
    }
  });

  it("explains how VetraTD works and links to us", () => {
    renderSettings("/settings/help");
    expect(screen.getByRole("link", { name: "Message us" })).toHaveAttribute("href", "/contact");
  });

  it("signs out", async () => {
    const user = userEvent.setup();
    renderSettings("/settings");
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signOut).toHaveBeenCalled();
  });
});

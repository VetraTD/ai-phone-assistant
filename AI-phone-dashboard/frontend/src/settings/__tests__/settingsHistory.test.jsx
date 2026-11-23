import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../../api", () => ({ api: { get: vi.fn().mockResolvedValue({ data: { capabilities: [] } }), put: vi.fn() } }));

import SettingsPage from "../SettingsPage";

// The page writes ?section= into the address. It must keep the router's own
// history state while doing so: replacing it with {} broke the index the
// unsaved-changes guard needs to block the Back button.
describe("Settings keeps the router's history state", () => {
  it("keeps idx and key when it writes the section into the address", async () => {
    window.history.replaceState({ idx: 3, key: "k1", usr: null }, "", "/settings");
    render(<SettingsPage business={{ id: "b1", name: "Brightwork Family Dental" }} businessId="b1" groups={["notifications", "billing"]} />);
    await screen.findAllByText(/Notifications/);
    expect(window.location.search).toMatch(/section=notifications/);
    expect(window.history.state).toMatchObject({ idx: 3, key: "k1" });
  });
});

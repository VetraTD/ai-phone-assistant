import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";

vi.mock("../../api", () => ({ api: { get: vi.fn(), put: vi.fn() } }));

import { api } from "../../api";
import VoiceAgent from "../VoiceAgent";
import { BusinessContext } from "../../shell/BusinessContext";

const pack = (id, label, over = {}) => ({ id, label, description: "", core: false, adapterKind: null, configSchema: null, dashboardListing: "listed", ...over });
const DEFINITIONS = {
  capabilities: [
    pack("appointments", "Bookings", {
      adapterKind: "scheduling",
      configSchema: {
        adapter: { type: "choice", label: "Where do appointments live?", options: ["internal"], default: "internal" },
        require: {
          identity: { type: "identity", label: "Information callers must give", builtinOptions: ["name", "dob"], allowCustom: true },
          confirmBeforeWrite: { type: "boolean", label: "Read the details back and wait for a clear yes" },
        },
        notes: { type: "text", label: "Your booking rules" },
      },
    }),
    pack("messages", "Messages", { core: true }),
    pack("quotes", "Quotes", { dashboardListing: "optIn" }),
    pack("transfer", "Transfers", { core: true }),
    pack("sms_consent", "Text confirmations", { core: true, dashboardListing: "hidden" }),
    pack("qualification", "Qualification questions", { dashboardListing: "hidden" }),
    pack("outcome", "Call outcome", { dashboardListing: "hidden" }),
    pack("callback", "Callback scheduling", { dashboardListing: "hidden" }),
    pack("opt_out", "Opt out / do not call", { dashboardListing: "hidden" }),
  ],
  adapters: { scheduling: [{ id: "internal", label: "Our built-in calendar", selfServe: true, verifiableFields: [], storesBookingsLocally: true }] },
};
const row = (id, enabled, over = {}) => ({ capability_id: id, enabled, adapter: null, adapter_config: {}, config: {}, configured: true, ...over });
const ROWS = [row("appointments", true), row("messages", true), row("quotes", false), row("transfer", true)];

const BUSINESS = {
  id: "b1",
  name: "Brightwork Family Dental",
  phone_number: "+15550100",
  timezone: "America/Chicago",
  greeting: "Hello, Brightwork",
  transfer_policy: "business_hours_only",
};

function renderAgent(path = "/voice-agent", { rows = ROWS } = {}) {
  const value = {
    business: BUSINESS,
    businessId: "b1",
    setBusiness: vi.fn(),
    definitions: DEFINITIONS,
    capabilityRows: rows,
    capabilitiesStatus: "ready",
    reloadCapabilities: vi.fn(),
    openCount: 0,
    setOpenCount: vi.fn(),
  };
  const router = createMemoryRouter(
    [
      { path: "/voice-agent", element: <VoiceAgent /> },
      { path: "/voice-agent/:section", element: <VoiceAgent /> },
      { path: "/voice-agent/:section/:item", element: <VoiceAgent /> },
      { path: "/home", element: <h1>Home page</h1> },
    ],
    { initialEntries: [path] }
  );
  render(
    <BusinessContext.Provider value={value}>
      <RouterProvider router={router} />
    </BusinessContext.Provider>
  );
  return { router, value };
}

const actions = () => screen.getByRole("list", { name: "Actions" });

describe("Voice agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue({ data: [] });
  });

  it("tells the owner how to try a change", () => {
    renderAgent();
    expect(screen.getByText(/To try a change, call \+15550100\. Saved changes apply from the next call\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy number" })).toBeInTheDocument();
  });

  it("lists only the actions an inbound business uses", () => {
    renderAgent();
    const names = within(actions()).getAllByRole("link").map((a) => a.textContent);
    expect(names.join(" | ")).toMatch(/Bookings/);
    expect(names.join(" | ")).toMatch(/Messages/);
    expect(names.join(" | ")).toMatch(/Transfers/);
    for (const hidden of ["Quotes", "Text confirmations", "Qualification", "Call outcome", "Callback scheduling", "Opt out"]) {
      expect(names.join(" | ")).not.toMatch(new RegExp(hidden));
    }
  });

  it("lists Quotes for a business that has it switched on", () => {
    renderAgent("/voice-agent", { rows: [...ROWS.filter((r) => r.capability_id !== "quotes"), row("quotes", true)] });
    expect(within(actions()).getByRole("link", { name: /Quotes/ })).toBeInTheDocument();
  });

  it("an always-on action says so and has no switch", () => {
    renderAgent();
    const messages = within(actions()).getByRole("link", { name: /Messages/ }).closest("li");
    expect(within(messages).getByText("Always on")).toBeInTheDocument();
    expect(within(messages).queryByRole("switch")).toBeNull();
    const bookings = within(actions()).getByRole("link", { name: /Bookings/ }).closest("li");
    expect(within(bookings).getByRole("switch", { name: "Bookings" })).toBeChecked();
  });

  it("opens the Bookings panel at its own address, with formats as choices", async () => {
    const user = userEvent.setup();
    renderAgent("/voice-agent/actions/appointments");
    const panel = screen.getByRole("region", { name: "Bookings" });
    expect(within(panel).getByText("Information callers must give")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: /Add something else/ }));
    expect(within(panel).getByRole("combobox", { name: "Format" })).toBeInTheDocument();
    expect(within(panel).queryByPlaceholderText(/\^\[0-9\]/)).toBeNull();
    expect(within(panel).queryByText(/\^\[0-9\]\{6\}\$/)).toBeNull();
  });

  it("opens on the greeting", () => {
    renderAgent();
    expect(screen.getByRole("region", { name: "Greeting" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Hello, Brightwork")).toBeInTheDocument();
  });

  it("asks before leaving with an unsaved greeting; Keep editing stays", async () => {
    const user = userEvent.setup();
    const { router } = renderAgent("/voice-agent/voice/greeting");
    const box = screen.getByDisplayValue("Hello, Brightwork");
    await user.clear(box);
    await user.type(box, "Thanks for calling");
    await router.navigate("/home");
    expect(await screen.findByRole("dialog")).toHaveTextContent("You have unsaved changes. Leave without saving?");
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByDisplayValue("Thanks for calling")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/voice-agent/voice/greeting");
  });

  it("moving between its own items keeps the draft without asking", async () => {
    const user = userEvent.setup();
    const { router } = renderAgent("/voice-agent/voice/greeting");
    const box = screen.getByDisplayValue("Hello, Brightwork");
    await user.type(box, "!");
    await router.navigate("/voice-agent/voice/tone");
    // It really moved: the Tone of voice item is open, the draft is kept, and
    // nothing asked.
    expect(await screen.findByRole("region", { name: "Tone of voice" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/voice-agent/voice/tone");
    expect(screen.getByText(/1 unsaved change/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a save that fails keeps the text and says what happened", async () => {
    const user = userEvent.setup();
    api.put.mockRejectedValue(new Error("Network Error"));
    renderAgent("/voice-agent/voice/greeting");
    const box = screen.getByDisplayValue("Hello, Brightwork");
    await user.type(box, " and welcome");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Couldn't save. Check your connection, then try again.")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Hello, Brightwork and welcome")).toBeInTheDocument();
  });

  it("turning an action on or off applies at once and keeps its other settings", async () => {
    const user = userEvent.setup();
    api.put.mockResolvedValue({ data: { ok: true } });
    const { value } = renderAgent("/voice-agent", {
      rows: [row("appointments", true, { adapter: "internal", adapter_config: { kept: true }, config: { notes: "Mornings only" } }), ...ROWS.slice(1)],
    });
    await user.click(within(actions()).getByRole("switch", { name: "Bookings" }));
    expect(api.put).toHaveBeenCalledWith("/api/business/b1/capabilities/appointments", {
      enabled: false,
      adapter: "internal",
      adapter_config: { kept: true },
      config: { notes: "Mornings only" },
    });
    await waitFor(() => expect(value.reloadCapabilities).toHaveBeenCalled());
  });

  it("never says receptionist, capabilities or webhook", () => {
    renderAgent("/voice-agent/actions/appointments");
    expect(document.body.textContent).not.toMatch(/receptionist|capabilit|webhook|intake/i);
  });
});

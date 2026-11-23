import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router-dom";

vi.mock("../../api", () => ({ api: { get: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
vi.mock("../../callsCsv", () => ({ buildCallsCsv: vi.fn(() => "Date,Caller\r\nx,y") }));

import { api } from "../../api";
import { buildCallsCsv } from "../../callsCsv";
import Inbox from "../Inbox";
import { BusinessContext } from "../../shell/BusinessContext";

const TZ = "America/Chicago";
const HOUR = 60 * 60 * 1000;
// A time that is "today" in Chicago whatever this machine's clock says: the
// start of the current Chicago day plus one minute.
function chicagoToday() {
  const now = new Date();
  const local = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return now.getTime() - (now.getTime() - new Date(`${local}T00:00:00-06:00`).getTime()) + 60 * 1000;
}
const todayIso = () => new Date(chicagoToday()).toISOString();
const yesterdayIso = () => new Date(chicagoToday() - 12 * HOUR).toISOString();

const row = (over) => ({
  id: "c1",
  started_at: todayIso(),
  caller_number: "+15550100199",
  caller_name_guess: "Sample Caller",
  summary: "Asked about a check-up.",
  status: "completed",
  has_request: true,
  request_type: "callback",
  handled_at: null,
  handled_by: null,
  ...over,
});

const detail = (over = {}) => ({
  call: { id: "c1", started_at: todayIso(), caller_number: "+15550100199", duration_seconds: 125, status: "completed", summary: "Asked about a check-up.", handled_at: null, handled_by: null, ...over.call },
  transcript: over.transcript || [
    { speaker: "ai", message: "Thanks for calling Brightwork Family Dental.", sequence: 1 },
    { speaker: "caller", message: "Hi, I'd like a check-up.", sequence: 2 },
  ],
  appointments: over.appointments || [],
  customer_requests: over.customer_requests || [{ request_type: "callback", caller_name: "Sample Caller", callback_number: null, preferred_time: "after 3 pm", message: "About a check-up" }],
  caller_history: over.caller_history || { calls: [], bookings: [] },
});

function LocationProbe() {
  const loc = useLocation();
  return <p data-testid="location">{loc.pathname + loc.search}</p>;
}

let setOpenCount;
function renderInbox(path = "/inbox", { calls = [row()], callDetail = detail() } = {}) {
  setOpenCount = vi.fn();
  api.get.mockImplementation((url, opts) => {
    if (url === "/api/calls") {
      if (opts?.params?.limit === 1) return Promise.resolve({ data: { calls: [], total: calls.length } });
      return Promise.resolve({ data: { calls, total: calls.length } });
    }
    if (url.startsWith("/api/calls/")) return Promise.resolve({ data: callDetail });
    return Promise.reject(new Error("unexpected " + url));
  });
  const value = {
    business: { id: "b1", name: "Brightwork Family Dental", phone_number: "+15550100", timezone: TZ },
    businessId: "b1",
    definitions: null,
    capabilityRows: [],
    openCount: 0,
    setOpenCount,
  };
  const router = createMemoryRouter(
    [
      {
        path: "/inbox",
        element: (
          <>
            <Inbox />
            <LocationProbe />
          </>
        ),
      },
      {
        path: "/inbox/:callId",
        element: (
          <>
            <Inbox />
            <LocationProbe />
          </>
        ),
      },
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

const list = () => screen.getByRole("navigation", { name: "Calls" });

describe("Inbox list", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens on Needs you and groups calls by day", async () => {
    renderInbox("/inbox", {
      calls: [row({ id: "t1", caller_name_guess: "Today Caller" }), row({ id: "y1", started_at: yesterdayIso(), caller_name_guess: "Yesterday Caller" })],
    });
    expect(await screen.findByText("Today Caller")).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith("/api/calls", { params: expect.objectContaining({ view: "open" }) });
    expect(within(list()).getByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(within(list()).getByRole("heading", { name: "Yesterday" })).toBeInTheDocument();
  });

  it("clicking a row opens that call at its own address", async () => {
    const user = userEvent.setup();
    renderInbox("/inbox", { calls: [row({ id: "c1" })] });
    await user.click(await screen.findByRole("link", { name: /Sample Caller/ }));
    expect(screen.getByTestId("location")).toHaveTextContent("/inbox/c1");
  });

  it("the switch shows all calls through the address", async () => {
    const user = userEvent.setup();
    renderInbox();
    await screen.findByText("Sample Caller");
    await user.click(screen.getByRole("button", { name: "All calls" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/inbox?view=all");
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/calls", { params: expect.objectContaining({ view: "all" }) }));
  });

  it("search asks once, after the typing pauses", async () => {
    const user = userEvent.setup();
    renderInbox();
    await screen.findByText("Sample Caller");
    api.get.mockClear();
    await user.type(screen.getByRole("searchbox", { name: "Search calls" }), "sample");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("q=sample"), { timeout: 2000 });
    await waitFor(() => {
      const searches = api.get.mock.calls.filter(([u, o]) => u === "/api/calls" && o?.params?.q);
      expect(searches).toHaveLength(1);
      expect(searches[0][1].params.q).toBe("sample");
    });
  });

  it("downloads the calls on screen as a spreadsheet", async () => {
    const user = userEvent.setup();
    const calls = [row({ id: "a" }), row({ id: "b", caller_name_guess: "Other Caller" })];
    globalThis.URL.createObjectURL = vi.fn(() => "blob:x");
    globalThis.URL.revokeObjectURL = vi.fn();
    renderInbox("/inbox", { calls });
    await screen.findByText("Other Caller");
    await user.click(screen.getByRole("button", { name: "Download calls (CSV)" }));
    expect(buildCallsCsv).toHaveBeenCalledWith(calls);
  });
});

describe("Inbox call view", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows what is needed, the summary, what VetraTD did and the conversation", async () => {
    renderInbox("/inbox/c1", {
      callDetail: detail({ appointments: [{ id: "a1", scheduled_at: "2026-11-24T15:00:00Z", status: "scheduled" }] }),
    });
    const view = await screen.findByRole("region", { name: /Sample Caller/ });
    expect(within(view).getByText("Call back after 3 pm")).toBeInTheDocument();
    expect(within(view).getByText("Asked about a check-up.")).toBeInTheDocument();
    expect(within(view).getByText("Booked an appointment for Tuesday 24 November, 9:00 am")).toBeInTheDocument();
    expect(within(view).getByText("Thanks for calling Brightwork Family Dental.")).toBeInTheDocument();
    expect(within(view).getAllByText("VetraTD").length).toBeGreaterThan(0);
    expect(within(view).getByRole("link", { name: "Call back" })).toHaveAttribute("href", "tel:+15550100199");
  });

  it("shows caller speech that looks like HTML literally", async () => {
    renderInbox("/inbox/c1", {
      callDetail: detail({ transcript: [{ speaker: "caller", message: "<img src=x onerror=alert(1)>", sequence: 1 }] }),
    });
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(document.querySelector("img[src='x']")).toBeNull();
  });

  it("renders a very long summary in full", async () => {
    const long = "Long summary. ".repeat(150).trim();
    renderInbox("/inbox/c1", { callDetail: detail({ call: { summary: long } }) });
    expect(await screen.findByText(long)).toBeInTheDocument();
  });

  it("shows four lines of the conversation, then the whole of it on request", async () => {
    const user = userEvent.setup();
    const transcript = [1, 2, 3, 4, 5, 6].map((n) => ({ speaker: n % 2 ? "ai" : "caller", message: `Line ${n}`, sequence: n }));
    renderInbox("/inbox/c1", { callDetail: detail({ transcript }) });
    await screen.findByText("Line 4");
    expect(screen.queryByText("Line 5")).toBeNull();
    const more = screen.getByRole("button", { name: "Show the whole conversation" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await user.click(more);
    expect(screen.getByText("Line 5")).toBeInTheDocument();
  });

  it("Done marks the call's item done and says so", async () => {
    const user = userEvent.setup();
    api.put.mockResolvedValue({ data: { id: "c1", handled_at: "2026-11-23T17:00:00Z", handled_by: "uid-1" } });
    renderInbox("/inbox/c1");
    const view = await screen.findByRole("region", { name: /Sample Caller/ });
    await user.click(within(view).getAllByRole("button", { name: "Done" })[0]);
    expect(api.put).toHaveBeenCalledWith("/api/calls/c1/handled");
    expect(await within(view).findByText("Marked done")).toBeInTheDocument();
    expect(within(view).getAllByRole("button", { name: "Reopen" }).length).toBeGreaterThan(0);
  });

  it("a withheld caller has no Call back", async () => {
    renderInbox("/inbox/c1", {
      callDetail: detail({ call: { caller_number: "anonymous" }, customer_requests: [{ request_type: "message", message: "Hello" }] }),
    });
    const view = await screen.findByRole("region", { name: /Withheld number/ });
    expect(within(view).queryByRole("link", { name: "Call back" })).toBeNull();
  });
});

describe("Inbox after review", () => {
  beforeEach(() => vi.clearAllMocks());

  it("search looks through all calls, not only those that need you", async () => {
    const user = userEvent.setup();
    renderInbox();
    await screen.findByText("Sample Caller");
    api.get.mockClear();
    await user.type(screen.getByRole("searchbox", { name: "Search calls" }), "rivera");
    await waitFor(() => {
      const searches = api.get.mock.calls.filter(([u, o]) => u === "/api/calls" && o?.params?.q);
      expect(searches.length).toBeGreaterThan(0);
      expect(searches.at(-1)[1].params.view).toBe("all");
    });
  });

  it("shows every request a call left, and the reason behind a follow-up", async () => {
    renderInbox("/inbox/c1", {
      callDetail: detail({
        customer_requests: [
          { request_type: "unconfirmed_claim", notes: "Follow-up needed: please call them back to confirm.", created_at: "2026-11-23T10:05:00Z" },
          { request_type: "message", caller_name: "Sample Caller", message: "First message", created_at: "2026-11-23T10:00:00Z" },
          { request_type: "message", caller_name: "Second Person", message: "Second message", created_at: "2026-11-23T09:59:00Z" },
        ],
      }),
    });
    const view = await screen.findByRole("region", { name: /Sample Caller/ });
    expect(within(view).getByText("Follow-up needed: please call them back to confirm.")).toBeInTheDocument();
    expect(within(view).getByText("First message")).toBeInTheDocument();
    expect(within(view).getByText("Second message")).toBeInTheDocument();
  });

  it("shows the number Call back will ring", async () => {
    renderInbox("/inbox/c1", {
      callDetail: detail({
        call: { caller_number: "+266696687" },
        customer_requests: [{ request_type: "callback", caller_name: "Sample Caller", callback_number: "+15550100177", created_at: "2026-11-23T10:00:00Z" }],
      }),
    });
    const view = await screen.findByRole("region", { name: /Sample Caller/ });
    expect(within(view).getByRole("link", { name: "Call back" })).toHaveAttribute("href", "tel:+15550100177");
    expect(within(view).getByText("+15550100177")).toBeInTheDocument();
    expect(within(view).queryByText("+266696687")).toBeNull();
  });

  it("a row reopened by a late request reads as needing you", async () => {
    renderInbox("/inbox", { calls: [row({ handled_at: "2026-11-23T10:00:00Z", handled_by: "u", is_open: true, request_type: "unconfirmed_claim" })] });
    expect(await screen.findByText("Call back to confirm")).toBeInTheDocument();
  });

  it("the search box follows the address when the search is cleared elsewhere", async () => {
    const router = renderInbox("/inbox?q=sample");
    expect(await screen.findByRole("searchbox", { name: "Search calls" })).toHaveValue("sample");
    await router.navigate("/inbox");
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search calls" })).toHaveValue(""));
  });

  it("refreshes the list when the tab comes back into view", async () => {
    renderInbox();
    await screen.findByText("Sample Caller");
    const before = api.get.mock.calls.length;
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(before));
  });
});

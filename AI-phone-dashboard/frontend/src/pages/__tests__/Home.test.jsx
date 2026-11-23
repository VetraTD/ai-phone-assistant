import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("../../api", () => ({ api: { get: vi.fn(), put: vi.fn(), delete: vi.fn() } }));

import { api } from "../../api";
import Home from "../Home";
import { BusinessContext } from "../../shell/BusinessContext";

const TZ = "America/Chicago";
const item = (over) => ({
  callId: "c1",
  startedAt: "2026-11-23T15:05:00Z",
  callerNumber: "+15550100199",
  callerName: "Sample Caller",
  summary: "Asked for a call back about a filling. Prefers afternoons.",
  request: { type: "callback", callerName: "Sample Caller", callbackNumber: null, preferredTime: "after 3 pm", message: null },
  ...over,
});
const home = (over) => ({
  timezone: TZ,
  openItems: [],
  doneToday: [],
  today: { answered: 4, bookingsMade: 2 },
  todaysBookings: [],
  week: { calls: 12, bookingsMade: 5 },
  ...over,
});

let setOpenCount;
function renderHome() {
  setOpenCount = vi.fn();
  const value = {
    business: { id: "b1", name: "Brightwork Family Dental", phone_number: "+15550100", timezone: TZ },
    businessId: "b1",
    setOpenCount,
    openCount: 0,
  };
  return render(
    <BusinessContext.Provider value={value}>
      <MemoryRouter initialEntries={["/home"]}>
        <Routes>
          <Route path="/home" element={<Home />} />
          <Route path="/inbox/:callId" element={<h1>call page</h1>} />
          <Route path="/trends" element={<h1>trends page</h1>} />
        </Routes>
      </MemoryRouter>
    </BusinessContext.Provider>
  );
}

const needsList = () => screen.getByRole("list", { name: "Needs you" });
const doneList = () => screen.getByRole("list", { name: "Done today" });

describe("Home", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("greets by the business's clock and says, in one sentence, who needs you", async () => {
    api.get.mockResolvedValue({ data: home({ openItems: [item()], today: { answered: 1, bookingsMade: 1 } }) });
    renderHome();
    expect(await screen.findByRole("heading", { level: 1, name: /^Good (morning|afternoon|evening)$/ })).toBeInTheDocument();
    expect(screen.getByText("1 caller needs you. VetraTD answered 1 call today and made 1 booking.")).toBeInTheDocument();
    await waitFor(() => expect(setOpenCount).toHaveBeenLastCalledWith(1));
  });

  it("lists open items oldest first, each with what is needed, who, and one line", async () => {
    api.get.mockResolvedValue({
      data: home({
        openItems: [
          item({ callId: "old", startedAt: "2026-11-23T14:00:00Z", callerName: "First Caller" }),
          item({ callId: "new", startedAt: "2026-11-23T16:00:00Z", callerName: "Second Caller", request: { type: "message", message: "Running late tomorrow." } }),
        ],
      }),
    });
    renderHome();
    const rows = within(await screen.findByRole("list", { name: "Needs you" })).getAllByRole("listitem");
    expect(rows.map((r) => within(r).getByRole("link", { name: /Caller/ }).textContent)).toEqual([
      expect.stringContaining("First Caller"),
      expect.stringContaining("Second Caller"),
    ]);
    expect(within(rows[0]).getByText("Call back after 3 pm")).toBeInTheDocument();
    expect(within(rows[0]).getByText("8:00 am")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Read their message")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Running late tomorrow.")).toBeInTheDocument();
    expect(within(rows[0]).getByRole("link", { name: /First Caller/ })).toHaveAttribute("href", "/inbox/old");
  });

  it("an item left on an earlier day says which day, not just the time", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const dayName = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "long" }).format(new Date(twoDaysAgo));
    api.get.mockResolvedValue({ data: home({ openItems: [item({ startedAt: twoDaysAgo })] }) });
    renderHome();
    const row = within(await screen.findByRole("list", { name: "Needs you" })).getByRole("listitem");
    expect(within(row).getByText(new RegExp("^" + dayName))).toBeInTheDocument();
  });

  it("Call back rings the number the caller left, else the one they called from", async () => {
    api.get.mockResolvedValue({
      data: home({
        openItems: [
          item({ callId: "a", request: { type: "callback", callbackNumber: "+1 (555) 010-0177" } }),
          item({ callId: "b", callerName: "Other Caller" }),
        ],
      }),
    });
    renderHome();
    const rows = within(await screen.findByRole("list", { name: "Needs you" })).getAllByRole("listitem");
    expect(within(rows[0]).getByRole("link", { name: "Call back" })).toHaveAttribute("href", "tel:+15550100177");
    expect(within(rows[1]).getByRole("link", { name: "Call back" })).toHaveAttribute("href", "tel:+15550100199");
  });

  it("a withheld caller gets no Call back, and reads Withheld number", async () => {
    api.get.mockResolvedValue({
      data: home({ openItems: [item({ callerName: null, callerNumber: "anonymous", request: { type: "message", message: "Hello" } })] }),
    });
    renderHome();
    const row = within(await screen.findByRole("list", { name: "Needs you" })).getByRole("listitem");
    expect(within(row).getByText("Withheld number")).toBeInTheDocument();
    expect(within(row).queryByRole("link", { name: "Call back" })).toBeNull();
  });

  it("Done moves the row to Done today and tells the server; Reopen moves it back", async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValue({ data: home({ openItems: [item()] }) });
    api.put.mockResolvedValue({ data: { id: "c1", handled_at: "2026-11-23T17:00:00Z", handled_by: "uid-1" } });
    api.delete.mockResolvedValue({ data: { id: "c1", handled_at: null, handled_by: null } });
    renderHome();
    await user.click(within(await screen.findByRole("list", { name: "Needs you" })).getByRole("button", { name: "Done" }));
    expect(api.put).toHaveBeenCalledWith("/api/calls/c1/handled");
    expect(await screen.findByText("Nothing needs you right now. New calls that need you will show up here, and you'll get an email.")).toBeInTheDocument();
    expect(within(doneList()).getByText("Sample Caller")).toBeInTheDocument();
    await waitFor(() => expect(setOpenCount).toHaveBeenLastCalledWith(0));

    await user.click(within(doneList()).getByRole("button", { name: "Reopen" }));
    expect(api.delete).toHaveBeenCalledWith("/api/calls/c1/handled");
    expect(within(await screen.findByRole("list", { name: "Needs you" })).getByText("Sample Caller")).toBeInTheDocument();
    await waitFor(() => expect(setOpenCount).toHaveBeenLastCalledWith(1));
  });

  it("a Done that fails puts the row back and says what to do", async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValue({ data: home({ openItems: [item()] }) });
    api.put.mockRejectedValue(new Error("Network Error"));
    renderHome();
    await user.click(within(await screen.findByRole("list", { name: "Needs you" })).getByRole("button", { name: "Done" }));
    expect(await screen.findByText("Couldn't mark that as done. Check your connection, then try again.")).toBeInTheDocument();
    expect(within(needsList()).getByText("Sample Caller")).toBeInTheDocument();
    await waitFor(() => expect(setOpenCount).toHaveBeenLastCalledWith(1));
  });

  it("says exactly what an empty Needs you means", async () => {
    api.get.mockResolvedValue({ data: home() });
    renderHome();
    expect(
      await screen.findByText("Nothing needs you right now. New calls that need you will show up here, and you'll get an email.")
    ).toBeInTheDocument();
  });

  it("shows today's bookings and the week, with a way to call trends", async () => {
    api.get.mockResolvedValue({
      data: home({
        todaysBookings: [{ id: "bk1", scheduledAt: "2026-11-23T16:00:00Z", clientName: "Sample Patient", status: "scheduled", callId: "c9" }],
        week: { calls: 1, bookingsMade: 1 },
      }),
    });
    renderHome();
    const today = await screen.findByRole("complementary", { name: "Today" });
    expect(within(today).getByText("Sample Patient")).toBeInTheDocument();
    expect(within(today).getByText("10:00 am")).toBeInTheDocument();
    expect(within(today).getByText("This week so far: 1 call, 1 booking made.")).toBeInTheDocument();
    expect(within(today).getByRole("link", { name: "See call trends" })).toHaveAttribute("href", "/trends");
  });

  it("a load that fails says what happened and can try again", async () => {
    const user = userEvent.setup();
    api.get.mockRejectedValueOnce(new Error("Network Error")).mockResolvedValueOnce({ data: home() });
    renderHome();
    expect(await screen.findByText("Couldn't load your calls. Check your connection, then try again.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Needs you" })).toBeInTheDocument();
  });

  it("caller text that looks like HTML is shown as text", async () => {
    api.get.mockResolvedValue({
      data: home({ openItems: [item({ callerName: "<img src=x onerror=alert(1)>", request: { type: "message", message: "<b>hi</b>" } })] }),
    });
    const { container } = renderHome();
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(container.querySelector("img[src='x']")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });
});

describe("Home after review", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a follow-up with no message shows why it needs you", async () => {
    api.get.mockResolvedValue({
      data: home({
        openItems: [item({ summary: "Booked nothing.", request: { type: "unconfirmed_claim", message: null, notes: "Follow-up needed: please call them back to confirm." } })],
      }),
    });
    renderHome();
    const row = within(await screen.findByRole("list", { name: "Needs you" })).getByRole("listitem");
    expect(within(row).getByText("Call back to confirm")).toBeInTheDocument();
    expect(within(row).getByText("Follow-up needed: please call them back to confirm.")).toBeInTheDocument();
  });

  it("a done row from an earlier day says which day", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const dayName = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "long" }).format(new Date(twoDaysAgo));
    api.get.mockResolvedValue({
      data: home({ doneToday: [{ callId: "d1", startedAt: twoDaysAgo, callerName: "Earlier Caller", summary: "x", status: "completed", handledAt: new Date().toISOString(), handledBy: "uid-1", hadRequest: true }] }),
    });
    renderHome();
    const row = within(await screen.findByRole("list", { name: "Done today" })).getByRole("listitem");
    expect(within(row).getByText(new RegExp("^" + dayName))).toBeInTheDocument();
  });

  it("refreshes when the tab comes back into view", async () => {
    api.get.mockResolvedValue({ data: home() });
    renderHome();
    await screen.findByRole("heading", { level: 2, name: "Needs you" });
    const before = api.get.mock.calls.length;
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(before));
  });

  it("after Done, keyboard focus stays in the list rather than falling off the page", async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValue({ data: home({ openItems: [item({ callId: "a" }), item({ callId: "b", callerName: "Second Caller" })] }) });
    api.put.mockResolvedValue({ data: { id: "a", handled_at: "x", handled_by: "uid" } });
    renderHome();
    const first = within(await screen.findByRole("list", { name: "Needs you" })).getAllByRole("button", { name: "Done" })[0];
    first.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement.textContent).toMatch(/Done|Second Caller|Needs you/);
  });

  it("too many changes at once says to wait, not to check the connection", async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValue({ data: home({ openItems: [item()] }) });
    api.put.mockRejectedValue({ response: { status: 429 } });
    renderHome();
    await user.click(within(await screen.findByRole("list", { name: "Needs you" })).getByRole("button", { name: "Done" }));
    expect(await screen.findByText("Too many changes at once. Wait a minute, then try again.")).toBeInTheDocument();
  });

  it("shows the now line even when every booking today is over", async () => {
    api.get.mockResolvedValue({
      data: home({ todaysBookings: [{ id: "bk", scheduledAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), clientName: "Earlier Patient", status: "scheduled", callId: null }] }),
    });
    renderHome();
    const today = await screen.findByRole("complementary", { name: "Today" });
    expect(within(today).getByText("Now")).toBeInTheDocument();
  });
});

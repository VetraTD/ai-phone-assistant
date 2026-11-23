import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router-dom";

vi.mock("../../api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));

import { api } from "../../api";
import Calendar from "../Calendar";
import { BusinessContext } from "../../shell/BusinessContext";

const TZ = "America/Chicago";
const ALERTS = "frontdesk@brightwork.example";

// Week of Monday 23 November 2026. Chicago is UTC-6 in November.
const booking = (over) => ({
  id: "a1",
  call_id: "c1",
  client_name: "Sample Caller",
  client_phone: "+15550100199",
  scheduled_at: "2026-11-24T15:00:00Z", // Tuesday 9:00 am
  status: "scheduled",
  notes: "Check-up",
  ...over,
});

function LocationProbe() {
  const loc = useLocation();
  return <p data-testid="location">{loc.pathname + loc.search}</p>;
}

function renderCalendar(path = "/calendar?date=2026-11-25", { bookings = [booking()], notificationEmail = ALERTS } = {}) {
  if (!api.get.getMockImplementation()) api.get.mockResolvedValue({ data: bookings });
  const value = {
    business: {
      id: "b1",
      name: "Brightwork Family Dental",
      phone_number: "+15550100",
      timezone: TZ,
      notification_email: notificationEmail,
    },
    businessId: "b1",
    definitions: null,
    capabilityRows: [],
    openCount: 0,
    setOpenCount: vi.fn(),
  };
  const router = createMemoryRouter(
    [
      {
        path: "/calendar",
        element: (
          <>
            <Calendar />
            <LocationProbe />
          </>
        ),
      },
      { path: "/inbox/:callId", element: <h1>call page</h1> },
      { path: "/settings/:item", element: <h1>settings page</h1> },
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

describe("Calendar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockReset();
    api.post.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the week of ?date and asks for Monday to Sunday", async () => {
    renderCalendar("/calendar?date=2026-11-25");
    await screen.findByRole("button", { name: "9:00 am, Sample Caller" });
    expect(api.get).toHaveBeenCalledWith("/api/appointments", { params: { from: "2026-11-23", to: "2026-11-29" } });
    expect(screen.getByText("23–28 November 2026")).toBeInTheDocument();
  });

  it("falls back to this week for a missing or broken date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-09T18:00:00Z")); // Wednesday 9 December, noon in Chicago
    api.get.mockResolvedValue({ data: [] });
    renderCalendar("/calendar?date=2026-02-30");
    await screen.findByText("No bookings this week.");
    expect(api.get).toHaveBeenCalledWith("/api/appointments", { params: { from: "2026-12-07", to: "2026-12-13" } });
  });

  it("lists a 7 pm booking under Outside 8 am–6 pm instead of dropping it", async () => {
    // Wednesday 25 November, 7:00 pm in Chicago.
    renderCalendar(undefined, {
      bookings: [booking(), booking({ id: "late", client_name: "Evening Caller", scheduled_at: "2026-11-26T01:00:00Z" })],
    });
    const outside = await screen.findByRole("list", { name: "Outside 8 am–6 pm" });
    expect(within(outside).getByRole("button", { name: /7:00 pm, Evening Caller/ })).toBeInTheDocument();
    expect(within(outside).queryByRole("button", { name: /Sample Caller/ })).toBeNull();
  });

  it("keeps a cancelled booking, struck through and labelled", async () => {
    renderCalendar(undefined, { bookings: [booking({ status: "cancelled" })] });
    const button = await screen.findByRole("button", { name: "9:00 am, Sample Caller, cancelled" });
    expect(button).toHaveClass("vt-cal-cancelled");
    expect(within(button).getByText("Cancelled")).toBeInTheDocument();
  });

  it("shows who, when and a link to the call that booked it", async () => {
    const user = userEvent.setup();
    renderCalendar();
    const button = await screen.findByRole("button", { name: "9:00 am, Sample Caller" });
    await user.click(button);
    const detail = screen.getByRole("dialog");
    expect(within(detail).getByText("Tuesday 24 November, 9:00 am")).toBeInTheDocument();
    expect(within(detail).getByText("Sample Caller")).toBeInTheDocument();
    expect(within(detail).getByRole("link", { name: "+15550100199" })).toHaveAttribute("href", "tel:+15550100199");
    expect(within(detail).getByText("Check-up")).toBeInTheDocument();
    expect(within(detail).getByText("Booked by VetraTD on a call")).toBeInTheDocument();
    expect(within(detail).getByRole("link", { name: "Open the call" })).toHaveAttribute("href", "/inbox/c1");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(button).toHaveFocus();
  });

  it("Next week moves the date by seven days", async () => {
    const user = userEvent.setup();
    renderCalendar("/calendar?date=2026-11-25");
    await screen.findByRole("button", { name: "9:00 am, Sample Caller" });
    await user.click(screen.getByRole("button", { name: "Next week" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/calendar?date=2026-12-02");
    await waitFor(() =>
      expect(api.get).toHaveBeenLastCalledWith("/api/appointments", { params: { from: "2026-11-30", to: "2026-12-06" } })
    );
  });

  it("asks for an alert address before emailing bookings", async () => {
    const user = userEvent.setup();
    renderCalendar(undefined, { notificationEmail: "" });
    await screen.findByRole("button", { name: "9:00 am, Sample Caller" });
    await user.click(screen.getByRole("button", { name: "Email me bookings" }));
    expect(screen.getByText("Add an alert email first.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Email alerts" })).toHaveAttribute("href", "/settings/alerts");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("emails the chosen range", async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({ data: { success: true, count: 2 } });
    renderCalendar();
    await screen.findByRole("button", { name: "9:00 am, Sample Caller" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Bookings to email" }), "7days");
    await user.click(screen.getByRole("button", { name: "Email me bookings" }));
    expect(api.post).toHaveBeenCalledWith("/api/appointments/email", { range: "7days" });
    expect(
      await screen.findByText(`Sent to ${ALERTS}. It says how many bookings there are; the details stay here.`)
    ).toBeInTheDocument();
  });

  it("shows the server's reason when email isn't set up", async () => {
    const user = userEvent.setup();
    api.post.mockRejectedValue({ response: { status: 500, data: { error: "Email sending is not configured on the server." } } });
    renderCalendar();
    await screen.findByRole("button", { name: "9:00 am, Sample Caller" });
    await user.click(screen.getByRole("button", { name: "Email me bookings" }));
    expect(await screen.findByText("Email sending is not configured on the server.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Email alerts" })).toHaveAttribute("href", "/settings/alerts");
  });

  it("says what happened when bookings fail to load", async () => {
    const user = userEvent.setup();
    api.get.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ data: [booking()] });
    renderCalendar();
    expect(
      await screen.findByText("Couldn't load your bookings. Check your connection, then try again.")
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "9:00 am, Sample Caller" })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it("shows a name that looks like HTML as text", async () => {
    renderCalendar(undefined, { bookings: [booking({ client_name: "<b>Sam</b>" })] });
    const button = await screen.findByRole("button", { name: "9:00 am, <b>Sam</b>" });
    expect(within(button).getByText("<b>Sam</b>")).toBeInTheDocument();
    expect(button.querySelector("b")).toBeNull();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";

vi.mock("../../api", () => ({ api: { get: vi.fn() } }));

import { api } from "../../api";
import Trends from "../Trends";
import { BusinessContext } from "../../shell/BusinessContext";

const breakdown = (over) => ({
  total_calls_3m: 37,
  actions: { appointments: 9, callbacks: 6, messages: 11 },
  followups_needed: 4,
  positive_calls_percent: 62,
  appointment_conversion_percent: 24,
  caller_mix: { first_time: 21, returning: 16 },
  peak_hour: { hour: 10 },
  business_hours: { in_hours: 30, out_hours: 7, timezone: "America/Chicago", opening_hours_set: true },
  calls_by_month: [
    { month_label: "Sep", total_calls: 10 },
    { month_label: "Oct", total_calls: 0 },
    { month_label: "Nov", total_calls: 27 },
  ],
  calls_by_weekday: [
    { day_name: "Mon", total_calls: 8 },
    { day_name: "Tue", total_calls: 5 },
  ],
  sentiment_counts: { positive: 23, neutral: 10, negative: 2, unknown: 2 },
  status_counts: { completed: 33, transferred: 2, failed: 1, no_answer: 1, busy: 0, in_progress: 0 },
  ...over,
});

function renderTrends() {
  const value = {
    business: { id: "b1", name: "Brightwork Family Dental", timezone: "America/Chicago" },
    businessId: "b1",
    openCount: 0,
    setOpenCount: vi.fn(),
  };
  const router = createMemoryRouter(
    [
      { path: "/trends", element: <Trends /> },
      { path: "/home", element: <h1>Home page</h1> },
    ],
    { initialEntries: ["/trends"] }
  );
  render(
    <BusinessContext.Provider value={value}>
      <RouterProvider router={router} />
    </BusinessContext.Provider>
  );
}

describe("Call trends", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockReset();
  });

  it("shows the period's totals from the server", async () => {
    api.get.mockResolvedValue({ data: breakdown() });
    renderTrends();
    expect(await screen.findByText("37")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Call trends" })).toBeInTheDocument();
    expect(screen.getByText("62%")).toBeInTheDocument();
    expect(screen.getByText("Busiest hour this period: 10 am to 11 am")).toBeInTheDocument();
    expect(screen.getByText("19% of calls came outside your opening hours")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("America/Chicago");
    expect(screen.getByRole("img", { name: /Nov: 27 calls/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Home/ })).toHaveAttribute("href", "/home");
    expect(api.get).toHaveBeenCalledWith("/api/analytics-breakdown", { params: { period: "90d" } });
  });

  it("asks again when the period changes", async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValue({ data: breakdown() });
    renderTrends();
    await screen.findByText("37");
    await user.selectOptions(screen.getByRole("combobox", { name: "Period" }), "30d");
    await waitFor(() =>
      expect(api.get).toHaveBeenLastCalledWith("/api/analytics-breakdown", { params: { period: "30d" } })
    );
  });

  it("says nothing about opening hours when the business has none set", async () => {
    api.get.mockResolvedValue({
      data: breakdown({ business_hours: { in_hours: 37, out_hours: 0, timezone: "America/Chicago", opening_hours_set: false } }),
    });
    renderTrends();
    await screen.findByText("37");
    expect(document.body.textContent).not.toMatch(/opening hours|9 am to 5 pm/);
  });

  it("names the hour before midnight and noon in words", async () => {
    api.get.mockResolvedValue({ data: breakdown({ peak_hour: { hour: 23 } }) });
    renderTrends();
    expect(await screen.findByText("Busiest hour this period: 11 pm to midnight")).toBeInTheDocument();
  });

  it("does not say 0% positive when no call was rated", async () => {
    api.get.mockResolvedValue({
      data: breakdown({ positive_calls_percent: 0, sentiment_counts: { positive: 0, neutral: 0, negative: 0, unknown: 37 } }),
    });
    renderTrends();
    expect(await screen.findByText("Not known yet")).toBeInTheDocument();
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("says so when there are no calls", async () => {
    api.get.mockResolvedValue({ data: breakdown({ total_calls_3m: 0, calls_by_month: [], calls_by_weekday: [] }) });
    renderTrends();
    expect(await screen.findByText("No calls in this period yet.")).toBeInTheDocument();
  });

  it("says what happened when trends fail to load", async () => {
    const user = userEvent.setup();
    api.get.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ data: breakdown() });
    renderTrends();
    expect(
      await screen.findByText("Couldn't load your call trends. Check your connection, then try again.")
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("37")).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it("never says receptionist", async () => {
    api.get.mockResolvedValue({ data: breakdown() });
    renderTrends();
    await screen.findByText("37");
    expect(document.body.textContent).not.toMatch(/receptionist/i);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";

vi.mock("../../api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock("../../shell/BusinessContext", () => ({
  useBusiness: () => ({
    business: {
      id: "b1",
      name: "Brightwork Family Dental",
      phone_number: "+15550100",
      timezone: "America/Chicago",
      notification_email: "owner@example.com",
    },
    businessId: "b1",
  }),
}));

import { api } from "../../api";
import LegacyAppointments from "../LegacyAppointments";

const BOOKINGS = [
  { id: "a1", call_id: null, client_name: "Sample Patient", client_phone: "+15550111", scheduled_at: "2030-01-15T15:00:00Z", status: "scheduled", notes: null },
  { id: "a2", call_id: null, client_name: "Example Caller", client_phone: "+15550122", scheduled_at: "2030-01-16T16:30:00Z", status: "scheduled", notes: null },
];

describe("LegacyAppointments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue({ data: BOOKINGS });
    api.post.mockResolvedValue({ data: { success: true, count: 2 } });
  });

  it("lists the bookings from GET /api/appointments", async () => {
    render(<MemoryRouter><LegacyAppointments /></MemoryRouter>);
    expect(await screen.findByText("Sample Patient")).toBeInTheDocument();
    expect(screen.getByText("Example Caller")).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith("/api/appointments", { params: { range: "upcoming" } });
  });

  it("emails a reminder for the range the owner picked", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><LegacyAppointments /></MemoryRouter>);
    await screen.findByText("Sample Patient");
    await user.selectOptions(screen.getByLabelText(/email range/i), "7days");
    await user.click(screen.getByRole("button", { name: /email me bookings/i }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/appointments/email", { range: "7days" })
    );
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });
});

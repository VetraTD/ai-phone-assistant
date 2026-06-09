import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getUpcomingAppointments,
  getAvailableSlots,
  bookAppointment,
  cancelAppointment,
  rescheduleAppointment,
} from "../services/appointments.js";

// Mock the athena integration
vi.mock("../integrations/index.js", () => ({
  executeAthenahealth: vi.fn(),
}));

import { executeAthenahealth } from "../integrations/index.js";

const integration = {
  provider: "athenahealth",
  enabled: true,
  config: { practice_id: "195900" },
};

describe("appointments layer", () => {
  beforeEach(() => {
    vi.mocked(executeAthenahealth).mockReset();
  });

  describe("getUpcomingAppointments", () => {
    it("delegates to EHR with correct tool and args", async () => {
      vi.mocked(executeAthenahealth).mockResolvedValue({
        success: true,
        message: "Your next appointment is 04/10/2026 at 11:00.",
        data: { appointments: [] },
      });

      const result = await getUpcomingAppointments(
        { name: "Jane Smith", dob: "1990-05-15", phone: "555-1234" },
        integration
      );

      expect(executeAthenahealth).toHaveBeenCalledWith(integration, {
        tool: "get_caller_appointments",
        arguments: {
          caller_name: "Jane Smith",
          caller_dob: "1990-05-15",
          caller_phone: "555-1234",
        },
      });
      expect(result.success).toBe(true);
    });

    it("returns friendly error when no integration", async () => {
      const result = await getUpcomingAppointments({ name: "Jane", dob: "1990-01-01" }, null);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/office/i);
    });

    it("returns friendly error when integration disabled", async () => {
      const result = await getUpcomingAppointments(
        { name: "Jane", dob: "1990-01-01" },
        { ...integration, enabled: false }
      );
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/offline/i);
    });
  });

  describe("getAvailableSlots", () => {
    it("delegates to EHR with correct tool and args", async () => {
      vi.mocked(executeAthenahealth).mockResolvedValue({
        success: true,
        message: "Available times: 9:00, 10:30.",
        data: { slots: [] },
      });

      const result = await getAvailableSlots(
        { date: "2026-04-15", serviceType: "general" },
        integration
      );

      expect(executeAthenahealth).toHaveBeenCalledWith(integration, {
        tool: "get_available_slots",
        arguments: { date: "2026-04-15", service_type: "general" },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("bookAppointment", () => {
    it("delegates to EHR with correct tool and args", async () => {
      vi.mocked(executeAthenahealth).mockResolvedValue({
        success: true,
        message: "Appointment confirmed.",
        data: { bookedAppointment: {} },
      });

      const result = await bookAppointment(
        {
          name: "Jane Smith",
          dob: "1990-05-15",
          phone: "555-1234",
          scheduledAt: "2026-04-15T10:30:00",
          serviceType: "general",
          notes: "First visit",
        },
        integration
      );

      expect(executeAthenahealth).toHaveBeenCalledWith(integration, {
        tool: "book_appointment_in_ehr",
        arguments: {
          caller_name: "Jane Smith",
          caller_dob: "1990-05-15",
          caller_phone: "555-1234",
          scheduled_at: "2026-04-15T10:30:00",
          service_type: "general",
          notes: "First visit",
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("cancelAppointment", () => {
    it("delegates to EHR with correct tool and args", async () => {
      vi.mocked(executeAthenahealth).mockResolvedValue({
        success: true,
        message: "Appointment cancelled.",
        data: { cancelledAppointmentId: "123" },
      });

      const result = await cancelAppointment(
        {
          name: "Jane Smith",
          dob: "1990-05-15",
          appointmentDate: "2026-04-10",
          reason: "Conflict",
        },
        integration
      );

      expect(executeAthenahealth).toHaveBeenCalledWith(integration, {
        tool: "cancel_appointment",
        arguments: {
          caller_name: "Jane Smith",
          caller_dob: "1990-05-15",
          caller_phone: undefined,
          appointment_date: "2026-04-10",
          appointment_time: undefined,
          reason: "Conflict",
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("rescheduleAppointment", () => {
    it("delegates to EHR with correct tool and args", async () => {
      vi.mocked(executeAthenahealth).mockResolvedValue({
        success: true,
        message: "Rescheduled.",
        data: { bookedAppointment: {}, cancelledAppointmentId: "123" },
      });

      const result = await rescheduleAppointment(
        {
          name: "Jane Smith",
          dob: "1990-05-15",
          currentDate: "2026-04-10",
          newDate: "2026-04-17",
          newTime: "14:00",
        },
        integration
      );

      expect(executeAthenahealth).toHaveBeenCalledWith(integration, {
        tool: "reschedule_appointment",
        arguments: {
          caller_name: "Jane Smith",
          caller_dob: "1990-05-15",
          caller_phone: undefined,
          current_appointment_date: "2026-04-10",
          current_appointment_time: undefined,
          new_date: "2026-04-17",
          new_time: "14:00",
          service_type: undefined,
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("unsupported provider", () => {
    it("returns friendly error", async () => {
      const result = await getUpcomingAppointments(
        { name: "Jane", dob: "1990-01-01" },
        { provider: "epic", enabled: true, config: {} }
      );
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/office/i);
    });
  });
});

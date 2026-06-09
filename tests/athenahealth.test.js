import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getAthenaAccessToken,
  executeAthenahealth,
  getCallerAppointments,
  getAvailableSlots,
  bookAppointment,
  cancelAppointment,
  rescheduleAppointment,
  clearAthenaTokenCache,
} from "../integrations/athenahealth.js";

describe("athenahealth service", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    clearAthenaTokenCache();
    vi.stubGlobal("fetch", vi.fn());
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  describe("getAthenaAccessToken", () => {
    it("returns null when env is missing", async () => {
      delete process.env.ATHENA_CLIENT_ID;
      delete process.env.ATHENA_CLIENT_SECRET;
      delete process.env.ATHENA_TOKEN_URL;
      const token = await getAthenaAccessToken();
      expect(token).toBeNull();
    });

    it("returns access_token when token endpoint returns 200", async () => {
      process.env.ATHENA_CLIENT_ID = "test-client";
      process.env.ATHENA_CLIENT_SECRET = "test-secret";
      process.env.ATHENA_TOKEN_URL = "https://api.preview.platform.athenahealth.com/oauth2/v1/token";
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ access_token: "mock-token", expires_in: 3600 }),
      });
      const token = await getAthenaAccessToken();
      expect(token).toMatchObject({ access_token: "mock-token" });
      expect(token).toHaveProperty("api_base");
      expect(fetch).toHaveBeenCalledWith(
        process.env.ATHENA_TOKEN_URL,
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: expect.stringContaining("Basic "),
          }),
          body: "grant_type=client_credentials&scope=athena/service/Athenanet.MDP.*",
        })
      );
    });

    it("returns null when token endpoint returns non-2xx", async () => {
      process.env.ATHENA_CLIENT_ID = "test-client";
      process.env.ATHENA_CLIENT_SECRET = "test-secret";
      process.env.ATHENA_TOKEN_URL = "https://api.example.com/token";
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: "unauthorized" }),
      });
      const token = await getAthenaAccessToken();
      expect(token).toBeNull();
    });

    it("uses ECC_ATHENA_* env when config.use_ecc_app is true", async () => {
      process.env.ECC_ATHENA_CLIENT_ID = "ecc-client";
      process.env.ECC_ATHENA_CLIENT_SECRET = "ecc-secret";
      process.env.ECC_ATHENA_TOKEN_URL = "https://ecc-api.example.com/oauth2/v1/token";
      process.env.ECC_ATHENA_API_BASE = "https://ecc-api.example.com";
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ access_token: "ecc-token", expires_in: 3600 }),
      });
      const token = await getAthenaAccessToken({ use_ecc_app: true });
      expect(token).toMatchObject({ access_token: "ecc-token", api_base: "https://ecc-api.example.com" });
      expect(fetch).toHaveBeenCalledWith(
        "https://ecc-api.example.com/oauth2/v1/token",
        expect.any(Object)
      );
    });
  });

  describe("executeAthenahealth", () => {
    it("returns error when practice_id is missing", async () => {
      const integration = { config: {} };
      const result = await executeAthenahealth(integration, { tool: "get_caller_appointments", arguments: {} });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/practice_id|Missing/);
    });

    it("returns error when token cannot be obtained", async () => {
      process.env.ATHENA_CLIENT_ID = "";
      process.env.ATHENA_CLIENT_SECRET = "";
      process.env.ATHENA_TOKEN_URL = "";
      const integration = { config: { practice_id: "195900" } };
      const result = await executeAthenahealth(integration, { tool: "get_caller_appointments", arguments: {} });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.message).toBeDefined();
    });

    it("returns error for unknown tool", async () => {
      process.env.ATHENA_CLIENT_ID = "c";
      process.env.ATHENA_CLIENT_SECRET = "s";
      process.env.ATHENA_TOKEN_URL = "https://api.example.com/token";
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
      });
      const integration = { config: { practice_id: "195900" } };
      const result = await executeAthenahealth(integration, { tool: "unknown_tool", arguments: {} });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown athena tool");
    });
  });

  describe("getCallerAppointments", () => {
    it("returns message when name or dob is missing", async () => {
      const result = await getCallerAppointments("https://api.example.com", "195900", "token", {});
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/name|date of birth/);
    });

    it("returns message when only name is provided (no dob)", async () => {
      const result = await getCallerAppointments("https://api.example.com", "195900", "token", { caller_name: "John Doe" });
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/date of birth/);
    });

    it("returns appointments when patient found", async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              patients: [
                {
                  patientid: "1",
                  firstname: "John",
                  lastname: "Doe",
                  dob: "01/01/1990",
                },
              ],
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            appointments: [{
              appointmentid: "100",
              date: "04/10/2026",
              starttime: "11:00",
              appointmenttype: "General",
              appointmentstatus: "f",
            }],
          }),
        });
      const result = await getCallerAppointments("https://api.example.com", "195900", "token", {
        caller_name: "John Doe",
        caller_dob: "01/01/1990",
      });
      expect(result.success).toBe(true);
      expect(result.message).toMatch(/appointment/i);
      expect(result.data?.appointments).toHaveLength(1);
      expect(result.data.appointments[0].appointmentId).toBe("100");
    });
  });

  describe("getAvailableSlots", () => {
    it("returns message when date is missing", async () => {
      const result = await getAvailableSlots("https://api.example.com", "195900", "token", {});
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/date/);
    });

    it("normalizes slots into first-class slot objects", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            appointments: [
              {
                appointmentid: "300",
                date: "04/20/2026",
                starttime: "09:00",
                providerid: "10",
                departmentid: "4",
                appointmenttypeid: "722",
              },
            ],
          }),
      });
      const result = await getAvailableSlots("https://api.example.com", "195900", "token", {
        date: "2026-04-20",
        department_id: "4",
      });
      expect(result.success).toBe(true);
      expect(result.data?.slots).toHaveLength(1);
      const slot = result.data.slots[0];
      expect(slot.newAppointmentId).toBe("300");
      expect(slot.start).toMatch(/^2026-04-20T09:00/);
    });
  });

  describe("bookAppointment", () => {
    it("returns message when scheduled_at, name, or dob is missing", async () => {
      const result = await bookAppointment("https://api.example.com", "195900", "token", {});
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/name|date|birth/);
    });
  });

  describe("cancelAppointment", () => {
    it("returns message when name or dob is missing", async () => {
      const result = await cancelAppointment("https://api.example.com", "195900", "token", {});
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/name|date of birth/);
    });

    it("cancels appointment when patient and appointment found", async () => {
      vi.mocked(fetch)
        // resolvePatient
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              patients: [
                {
                  patientid: "1",
                  firstname: "John",
                  lastname: "Doe",
                  dob: "01/01/1990",
                },
              ],
            }),
        })
        // findPatientAppointment
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            appointments: [{
              appointmentid: "200",
              date: "04/10/2026",
              starttime: "11:00",
              appointmenttype: "General",
              appointmentstatus: "f",
            }],
          }),
        })
        // cancel PUT
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: "x" }) });

      const result = await cancelAppointment("https://api.example.com", "195900", "token", {
        caller_name: "John Doe",
        caller_dob: "01/01/1990",
        appointment_date: "04/10/2026",
      });
      expect(result.success).toBe(true);
      expect(result.message).toMatch(/cancelled/i);
      expect(result.data?.cancelledAppointmentId).toBe("200");
    });
  });

  describe("rescheduleAppointment", () => {
    it("returns message when name or dob is missing", async () => {
      const result = await rescheduleAppointment("https://api.example.com", "195900", "token", {});
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/name|date of birth/);
    });

    it("returns message when new_date is missing", async () => {
      const result = await rescheduleAppointment("https://api.example.com", "195900", "token", {
        caller_name: "John Doe",
        caller_dob: "01/01/1990",
      });
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/date/);
    });

    it("reschedules using slots that match existing appointment dept/provider/type and builds body with full context", async () => {
      vi.mocked(fetch)
        // resolvePatient
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              patients: [
                {
                  patientid: "1",
                  firstname: "Admin",
                  lastname: "Test",
                  dob: "01/01/2000",
                },
              ],
            }),
        })
        // findPatientAppointment (existing Echo appointment)
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              appointments: [
                {
                  appointmentid: "699420",
                  appointmentdate: "04/24/2026",
                  starttime: "10:00",
                  appointmenttypeid: "ECHO_TYPE",
                  providerid: "7",
                  departmentid: "4",
                  appointmentstatus: "f",
                },
              ],
            }),
        })
        // /appointments/open with a mix of slots
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              appointments: [
                // Mismatched type
                {
                  appointmentid: "SLOT1",
                  date: "04/24/2026",
                  starttime: "08:30",
                  appointmenttypeid: "OTHER_TYPE",
                  providerid: "7",
                  departmentid: "4",
                },
                // Mismatched provider
                {
                  appointmentid: "SLOT2",
                  date: "04/24/2026",
                  starttime: "08:45",
                  appointmenttypeid: "ECHO_TYPE",
                  providerid: "20",
                  departmentid: "4",
                },
                // Matching Echo slot for same provider/department
                {
                  appointmentid: "SLOT_ECHO_MATCH",
                  date: "04/24/2026",
                  starttime: "09:00",
                  appointmenttypeid: "ECHO_TYPE",
                  providerid: "7",
                  departmentid: "4",
                },
              ],
            }),
        })
        // reschedule PUT
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ status: "success" }),
        });

      const result = await rescheduleAppointment("https://api.example.com", "195900", "token", {
        caller_name: "Admin Test",
        caller_dob: "01/01/2000",
        current_appointment_date: "04/24/2026",
        current_appointment_time: "10:00",
        new_date: "04/24/2026",
        new_time: "09:00",
      });

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/rescheduled/i);

      // Third fetch call should be /appointments/open with matching filters
      const openCall = vi.mocked(fetch).mock.calls[2];
      expect(openCall[0]).toMatch(/\/appointments\/open/);
      const openUrl = new URL(openCall[0]);
      expect(openUrl.searchParams.get("departmentid")).toBe("4");
      expect(openUrl.searchParams.get("appointmenttypeid")).toBe("ECHO_TYPE");
      expect(openUrl.searchParams.get("providerid")).toBe("7");

      // Fourth fetch call should be the reschedule PUT with full context
      const rescheduleCall = vi.mocked(fetch).mock.calls[3];
      expect(rescheduleCall[0]).toMatch(/\/appointments\/699420\/reschedule$/);
      const bodyParams = new URLSearchParams(rescheduleCall[1].body);
      expect(bodyParams.get("newappointmentid")).toBe("SLOT_ECHO_MATCH");
      expect(bodyParams.get("patientid")).toBe("1");
      expect(bodyParams.get("departmentid")).toBe("4");
      expect(bodyParams.get("appointmenttypeid")).toBe("ECHO_TYPE");
      expect(bodyParams.get("providerid")).toBe("7");
      expect(bodyParams.get("ignoreschedulablepermission")).toBe("true");
      expect(bodyParams.get("bypassscheduletimechecks")).toBe("true");
    });
  });
});

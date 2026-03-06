import { describe, it, expect, vi, beforeEach } from "vitest";

const mockEq = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: () => ({
      update: (data) => ({
        eq: (col, id) => mockEq(col, id, data),
      }),
    }),
  })),
}));

describe("updateBusinessPhoneNumber", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_KEY = "test-key";
  });

  it("returns true when update succeeds", async () => {
    mockEq.mockResolvedValue({ error: null });
    const { updateBusinessPhoneNumber } = await import("../services/supabase.js");

    const result = await updateBusinessPhoneNumber("business-uuid-123", "+15551234567");

    expect(result).toBe(true);
    expect(mockEq).toHaveBeenCalledWith("id", "business-uuid-123", {
      phone_number: "+15551234567",
    });
  });

  it("returns false when update returns error", async () => {
    mockEq.mockResolvedValue({ error: { message: "DB error" } });
    const { updateBusinessPhoneNumber } = await import("../services/supabase.js");

    const result = await updateBusinessPhoneNumber("business-uuid-123", "+15551234567");

    expect(result).toBe(false);
  });

  it("returns false when businessId is missing", async () => {
    mockEq.mockResolvedValue({ error: null });
    const { updateBusinessPhoneNumber } = await import("../services/supabase.js");

    const result = await updateBusinessPhoneNumber("", "+15551234567");

    expect(result).toBe(false);
    expect(mockEq).not.toHaveBeenCalled();
  });
});

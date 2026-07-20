import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockMaybeSingle = vi.fn();
const mockUpdate = vi.fn();
const mockUpdateEq = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: () => ({
      select: (...args) => mockSelect(...args),
      update: (data) => mockUpdate(data),
    }),
  })),
}));

describe("markCallTransferred", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_KEY = "test-key";
    mockSelect.mockReturnValue({ eq: mockEq });
    mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle });
    mockUpdate.mockImplementation((data) => ({
      eq: (col, id) => mockUpdateEq(col, id, data),
    }));
  });

  it("updates status to transferred for the given callSid", async () => {
    mockUpdateEq.mockResolvedValue({ error: null });
    const { markCallTransferred } = await import("../services/supabase.js");

    await markCallTransferred("CA123");

    expect(mockUpdateEq).toHaveBeenCalledWith("twilio_call_sid", "CA123", { status: "transferred" });
  });

  it("logs but does not throw on DB error", async () => {
    mockUpdateEq.mockResolvedValue({ error: { message: "boom" } });
    const { markCallTransferred } = await import("../services/supabase.js");

    await expect(markCallTransferred("CA123")).resolves.toBeUndefined();
  });
});

describe("completeCall — preserves transferred status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_KEY = "test-key";
    mockSelect.mockReturnValue({ eq: mockEq });
    mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle });
    mockUpdate.mockImplementation((data) => ({
      eq: (col, id) => mockUpdateEq(col, id, data),
    }));
    mockUpdateEq.mockResolvedValue({ error: null });
  });

  it("does not overwrite status when the call was already marked transferred", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { status: "transferred" }, error: null });
    const { completeCall } = await import("../services/supabase.js");

    await completeCall("CA123", "completed", 42);

    const [, , updates] = mockUpdateEq.mock.calls[0];
    expect(updates.status).toBeUndefined();
    expect(updates.duration_seconds).toBe(42);
    expect(updates.ended_at).toBeDefined();
  });

  it("sets status normally when the call was not transferred", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { status: "in-progress" }, error: null });
    const { completeCall } = await import("../services/supabase.js");

    await completeCall("CA123", "completed", 10);

    const [, , updates] = mockUpdateEq.mock.calls[0];
    expect(updates.status).toBe("completed");
    expect(updates.duration_seconds).toBe(10);
  });

  it("sets status normally when no existing row is found", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const { completeCall } = await import("../services/supabase.js");

    await completeCall("CA123", "failed", null);

    const [, , updates] = mockUpdateEq.mock.calls[0];
    expect(updates.status).toBe("failed");
    expect(updates.duration_seconds).toBeUndefined();
  });
});

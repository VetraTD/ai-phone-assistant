import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("../../api", () => ({ api: { put: vi.fn() } }));

import { api } from "../../api";
import { useBusinessDraft, snapshotFromBusiness } from "../useBusinessDraft";

const BUSINESS = { id: "b1", name: "Brightwork Family Dental", greeting: "Hello", timezone: "America/Chicago" };

function setup(onBusinessUpdate = vi.fn()) {
  return renderHook(() => useBusinessDraft({ business: BUSINESS, businessId: "b1", onBusinessUpdate }));
}

describe("useBusinessDraft", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts clean, from the business with defaults filled in", () => {
    const { result } = setup();
    expect(result.current.dirty).toBe(false);
    expect(result.current.draft).toEqual(snapshotFromBusiness(BUSINESS));
  });

  it("patching the greeting makes it dirty with only that change", () => {
    const { result } = setup();
    act(() => result.current.patch({ greeting: "Thanks for calling Brightwork" }));
    expect(result.current.dirty).toBe(true);
    expect(result.current.changed).toEqual({ greeting: "Thanks for calling Brightwork" });
  });

  it("Discard puts it back", () => {
    const { result } = setup();
    act(() => result.current.patch({ greeting: "Changed" }));
    act(() => result.current.discard());
    expect(result.current.dirty).toBe(false);
    expect(result.current.draft.greeting).toBe("Hello");
  });

  it("Save sends only what changed, then is clean", async () => {
    const onBusinessUpdate = vi.fn();
    api.put.mockResolvedValue({ data: { ...BUSINESS, greeting: "New greeting" } });
    const { result } = setup(onBusinessUpdate);
    act(() => result.current.patch({ greeting: "New greeting" }));
    let ok;
    await act(async () => {
      ok = await result.current.save();
    });
    expect(ok).toBe(true);
    expect(api.put).toHaveBeenCalledWith("/api/business/b1/settings", { greeting: "New greeting" });
    expect(onBusinessUpdate).toHaveBeenCalledWith({ ...BUSINESS, greeting: "New greeting" });
    expect(result.current.dirty).toBe(false);
  });

  it("a save that fails keeps the draft and says what happened", async () => {
    api.put.mockRejectedValue(new Error("Network Error"));
    const { result } = setup();
    act(() => result.current.patch({ greeting: "Typed but not saved" }));
    let ok;
    await act(async () => {
      ok = await result.current.save();
    });
    expect(ok).toBe(false);
    expect(result.current.dirty).toBe(true);
    expect(result.current.draft.greeting).toBe("Typed but not saved");
    expect(result.current.error).toBe("Couldn't save. Check your connection, then try again.");
  });

  it("an expired sign-in or bad value uses the server's own message", async () => {
    api.put.mockRejectedValue({ response: { data: { error: "Greeting is too long" } } });
    const { result } = setup();
    act(() => result.current.patch({ greeting: "x" }));
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.error).toBe("Greeting is too long");
  });
});

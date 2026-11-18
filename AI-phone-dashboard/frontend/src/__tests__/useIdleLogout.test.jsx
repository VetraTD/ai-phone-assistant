import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useIdleLogout } from "../useIdleLogout";

// §164.312(a)(2)(iii) automatic logoff.
//
// Fake timers throughout: the control is a duration, and a test that waits out
// a real fifteen minutes is a test nobody runs.

describe("useIdleLogout", () => {
  let onLogout;

  beforeEach(() => {
    vi.useFakeTimers();
    onLogout = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(overrides = {}) {
    return renderHook(() =>
      useIdleLogout({ enabled: true, onLogout, timeoutMinutes: 15, warningMinutes: 2, ...overrides })
    );
  }

  it("signs the user out after the idle window", () => {
    setup();
    act(() => vi.advanceTimersByTime(15 * 60_000));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("does not sign out before the window elapses", () => {
    setup();
    act(() => vi.advanceTimersByTime(15 * 60_000 - 1000));
    expect(onLogout).not.toHaveBeenCalled();
  });

  it("warns before it acts, rather than dropping the session silently", () => {
    // Without the warning, someone pausing mid-sentence in a knowledge-base
    // entry loses the work with no way to tell a logout from a crash.
    const { result } = setup();
    expect(result.current.warning).toBe(false);
    act(() => vi.advanceTimersByTime(13 * 60_000));
    expect(result.current.warning).toBe(true);
    expect(onLogout).not.toHaveBeenCalled();
  });

  it("counts down during the warning", () => {
    const { result } = setup();
    act(() => vi.advanceTimersByTime(13 * 60_000));
    expect(result.current.secondsRemaining).toBe(120);
    act(() => vi.advanceTimersByTime(5_000));
    expect(result.current.secondsRemaining).toBe(115);
  });

  it("restarts the clock on a keystroke", () => {
    setup();
    act(() => vi.advanceTimersByTime(14 * 60_000));
    act(() => {
      window.dispatchEvent(new Event("keydown"));
    });
    act(() => vi.advanceTimersByTime(14 * 60_000));
    expect(onLogout).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(60_000));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("clears an active warning when the person comes back", () => {
    const { result } = setup();
    act(() => vi.advanceTimersByTime(13 * 60_000));
    expect(result.current.warning).toBe(true);
    act(() => {
      window.dispatchEvent(new Event("mousedown"));
    });
    expect(result.current.warning).toBe(false);
  });

  it("lets the warning banner keep the session explicitly", () => {
    const { result } = setup();
    act(() => vi.advanceTimersByTime(13 * 60_000));
    act(() => result.current.stayActive());
    expect(result.current.warning).toBe(false);
    act(() => vi.advanceTimersByTime(14 * 60_000));
    expect(onLogout).not.toHaveBeenCalled();
  });

  it("ignores mousemove, so a nudged desk cannot hold a session open", () => {
    // The single most likely way for this control to be defeated in a real
    // clinic: a mouse resting against a trackpad edge.
    setup();
    for (let i = 0; i < 20; i++) {
      act(() => vi.advanceTimersByTime(60_000));
      act(() => {
        window.dispatchEvent(new Event("mousemove"));
      });
    }
    expect(onLogout).toHaveBeenCalled();
  });

  it("does not treat a tab going to the background as activity", () => {
    setup();
    act(() => vi.advanceTimersByTime(14 * 60_000));
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    act(() => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => vi.advanceTimersByTime(60_000));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all when there is no session", () => {
    setup({ enabled: false });
    act(() => vi.advanceTimersByTime(60 * 60_000));
    expect(onLogout).not.toHaveBeenCalled();
  });

  it("stops its timers when unmounted, so a signed-out app cannot fire it", () => {
    const { unmount } = setup();
    unmount();
    act(() => vi.advanceTimersByTime(60 * 60_000));
    expect(onLogout).not.toHaveBeenCalled();
  });

  it("fires exactly once, not repeatedly, after the window passes", () => {
    setup();
    act(() => vi.advanceTimersByTime(60 * 60_000));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});

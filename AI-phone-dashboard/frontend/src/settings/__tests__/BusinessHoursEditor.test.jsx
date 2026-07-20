import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BusinessHoursEditor from "../BusinessHoursEditor";

const HOURS = {
  mon: { open: "09:00", close: "17:00", closed: false },
  tue: { open: "09:00", close: "17:00", closed: false },
  wed: { open: "09:00", close: "17:00", closed: false },
  thu: { open: "09:00", close: "17:00", closed: false },
  fri: { open: "09:00", close: "17:00", closed: false },
  sat: { open: null, close: null, closed: true },
  sun: { open: null, close: null, closed: true },
};

function setup(overrides = {}) {
  const onChange = vi.fn();
  const value = { business_hours: { ...HOURS, ...overrides } };
  render(<BusinessHoursEditor value={value} onChange={onChange} />);
  return { onChange };
}

describe("BusinessHoursEditor", () => {
  it("closing an open day nulls out its open/close times", async () => {
    const user = userEvent.setup();
    const { onChange } = setup();

    // Monday's "Closed" checkbox is the first checkbox in the list.
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]);

    expect(onChange).toHaveBeenCalledWith({
      business_hours: expect.objectContaining({
        mon: { open: null, close: null, closed: true },
      }),
    });
  });

  it("un-closing a closed day fills in default open/close times, never blank", async () => {
    const user = userEvent.setup();
    const { onChange } = setup();

    // Saturday is closed=true; its checkbox is the 6th in day order.
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[5]);

    expect(onChange).toHaveBeenCalledWith({
      business_hours: expect.objectContaining({
        sat: { open: "09:00", close: "17:00", closed: false },
      }),
    });
    const call = onChange.mock.calls[0][0];
    expect(call.business_hours.sat.open).not.toBe("");
    expect(call.business_hours.sat.close).not.toBe("");
  });

  it("changing an open time updates only that day", () => {
    const { onChange } = setup();

    // Native <input type="time"> doesn't behave like a text field under
    // userEvent.type() in jsdom (typing a literal colon lands in the wrong
    // segment) — fireEvent.change is the standard way to drive it in tests.
    const openInput = screen.getByLabelText("Monday opening time");
    fireEvent.change(openInput, { target: { value: "10:30" } });

    const lastCall = onChange.mock.calls.at(-1)[0];
    expect(lastCall.business_hours.mon.open).toBe("10:30");
    expect(lastCall.business_hours.mon.closed).toBe(false);
    // Untouched days are passed through unchanged.
    expect(lastCall.business_hours.tue).toEqual(HOURS.tue);
  });
});

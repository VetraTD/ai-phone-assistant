import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TasksSection from "../TasksSection";
import { CORE_TASKS, MODULE_TASKS } from "../constants";

function setup(allowed = ["book_appointment"]) {
  const onChange = vi.fn();
  render(<TasksSection value={{ allowed_tasks: allowed }} onChange={onChange} />);
  return { onChange };
}

describe("TasksSection", () => {
  it("renders CORE tasks as non-toggleable badges, not checkboxes", () => {
    setup();
    for (const task of CORE_TASKS) {
      expect(screen.getByText(new RegExp(task.label))).toBeInTheDocument();
    }
    // Only MODULE_TASKS should produce checkboxes — CORE tasks are plain text.
    expect(screen.getAllByRole("checkbox")).toHaveLength(MODULE_TASKS.length);
  });

  it("checking a module task adds its key to allowed_tasks", async () => {
    const user = userEvent.setup();
    const { onChange } = setup(["book_appointment"]);

    const checkbox = screen.getByRole("checkbox", { name: "Quotes" });
    await user.click(checkbox);

    expect(onChange).toHaveBeenCalledWith({
      allowed_tasks: ["book_appointment", "quote_request"],
    });
  });

  it("unchecking an enabled module task removes its key", async () => {
    const user = userEvent.setup();
    const { onChange } = setup(["book_appointment", "quote_request"]);

    const checkbox = screen.getByRole("checkbox", { name: "Book appointments" });
    await user.click(checkbox);

    expect(onChange).toHaveBeenCalledWith({ allowed_tasks: ["quote_request"] });
  });
});

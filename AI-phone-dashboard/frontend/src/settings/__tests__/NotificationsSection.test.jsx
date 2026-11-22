import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NotificationsSection from "../NotificationsSection";

const BASE = {
  notification_email: "owner@brightwork.example",
  notification_phone: "+15550100199",
  notifications_enabled: true,
  sms_followup_enabled: false,
  sms_templates: {},
};

function setup(overrides = {}) {
  const onChange = vi.fn();
  render(<NotificationsSection value={{ ...BASE, ...overrides }} onChange={onChange} />);
  return { onChange };
}

// Texts are off in production (no SMS sender is configured), so nothing on this
// panel may offer them: the alert phone and the caller follow-up text would be
// controls that reach nothing. tests/dashboardSettingsEffects.test.js lists
// them under NOT_SHOWN.
describe("NotificationsSection: only what works while texts are off", () => {
  it("shows no alert phone and no caller texts", () => {
    setup({ sms_followup_enabled: false });
    expect(screen.queryByLabelText(/notification phone/i)).toBeNull();
    expect(screen.queryByRole("heading", { name: /what callers get afterwards/i })).toBeNull();
    expect(screen.queryByText(/what callers get afterwards/i)).toBeNull();
  });

  it("stays hidden for a business whose follow-up flag was switched on before", () => {
    setup({ sms_followup_enabled: true });
    expect(screen.queryByLabelText(/notification phone/i)).toBeNull();
    expect(screen.queryByText(/what callers get afterwards/i)).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /text callers/i })).toBeNull();
  });

  it("the alert switch promises email, not texts", () => {
    setup();
    const box = screen.getByRole("checkbox", { name: /email me when a caller/i });
    expect(box).toBeChecked();
    expect(screen.queryByText(/text me/i)).toBeNull();
  });

  it("editing the alert email emits a notification_email patch", async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ notification_email: "" });
    await user.type(screen.getByLabelText(/notification email/i), "a");
    expect(onChange).toHaveBeenCalledWith({ notification_email: "a" });
  });
});

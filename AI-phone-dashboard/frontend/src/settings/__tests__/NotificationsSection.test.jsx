import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NotificationsSection from "../NotificationsSection";
import { SMS_TEMPLATE_KINDS, SMS_TEMPLATE_META } from "../constants";

const BASE = {
  notification_email: "owner@biz.com",
  notification_phone: "+447700900123",
  notifications_enabled: true,
  sms_followup_enabled: false,
  sms_templates: {},
};

function setup(overrides = {}) {
  const onChange = vi.fn();
  render(<NotificationsSection value={{ ...BASE, ...overrides }} onChange={onChange} />);
  return { onChange };
}

describe("NotificationsSection — caller SMS follow-ups", () => {
  it("renders the follow-up toggle reflecting sms_followup_enabled", () => {
    setup({ sms_followup_enabled: true });
    expect(screen.getByRole("checkbox", { name: /text callers/i })).toBeChecked();
  });

  it("toggling it emits a sms_followup_enabled patch (the key the backend whitelist accepts)", async () => {
    const user = userEvent.setup();
    const { onChange } = setup();

    await user.click(screen.getByRole("checkbox", { name: /text callers/i }));

    expect(onChange).toHaveBeenCalledWith({ sms_followup_enabled: true });
  });

  it("hides the template overrides until follow-ups are switched on", () => {
    setup({ sms_followup_enabled: false });
    expect(screen.queryByRole("button", { name: /customise message wording/i })).not.toBeInTheDocument();
  });

  it("reveals one override field per known template kind once expanded", async () => {
    const user = userEvent.setup();
    setup({ sms_followup_enabled: true });

    await user.click(screen.getByRole("button", { name: /customise message wording/i }));

    // Exact label match: the enable-toggle's own copy also mentions
    // "appointment confirmations"/"missed calls", so a loose regex would be
    // ambiguous.
    for (const kind of SMS_TEMPLATE_KINDS) {
      expect(screen.getByLabelText(SMS_TEMPLATE_META[kind].label)).toBeInTheDocument();
    }
  });

  it("editing an override emits a whole sms_templates object, merged with existing overrides", async () => {
    const user = userEvent.setup();
    const { onChange } = setup({
      sms_followup_enabled: true,
      sms_templates: { message_received: "Got it!" },
    });

    await user.click(screen.getByRole("button", { name: /customise message wording/i }));
    await user.type(screen.getByLabelText(SMS_TEMPLATE_META.missed_call.label), "H");

    expect(onChange).toHaveBeenCalledWith({
      sms_templates: { message_received: "Got it!", missed_call: "H" },
    });
  });

  it("clearing an override drops the key rather than sending an empty string", async () => {
    const user = userEvent.setup();
    const { onChange } = setup({
      sms_followup_enabled: true,
      sms_templates: { missed_call: "X" },
    });

    await user.click(screen.getByRole("button", { name: /customise message wording/i }));
    await user.clear(screen.getByLabelText(SMS_TEMPLATE_META.missed_call.label));

    expect(onChange).toHaveBeenCalledWith({ sms_templates: {} });
  });
});

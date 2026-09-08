import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import SiteHeader from "../site/components/SiteHeader.jsx";

// The old site hid its nav under 768px and offered nothing in its place, so
// Features / How it works / FAQ were unreachable on a phone. This is the
// replacement: a real menu that behaves like a dialog.

function setup(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SiteHeader />
    </MemoryRouter>
  );
}

describe("the mobile menu", () => {
  it("is closed by default with the toggle announcing so", () => {
    setup();
    const toggle = screen.getByRole("button", { name: /open menu/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", "site-menu");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens as a modal dialog, locks the page and moves focus inside", async () => {
    const user = userEvent.setup();
    setup();
    const toggle = screen.getByRole("button", { name: /open menu/i });
    await user.click(toggle);

    const dialog = screen.getByRole("dialog", { name: /menu/i });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.body.style.overflow).toBe("hidden");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("wraps Tab at both ends", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /open menu/i }));
    const dialog = screen.getByRole("dialog", { name: /menu/i });
    const focusables = dialog.querySelectorAll("a[href], button");
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    last.focus();
    await user.tab();
    expect(document.activeElement).toBe(first);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
  });

  it("closes on Escape, unlocks the page and returns focus to the toggle", async () => {
    const user = userEvent.setup();
    setup();
    const toggle = screen.getByRole("button", { name: /open menu/i });
    await user.click(toggle);
    expect(screen.getByRole("dialog")).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(toggle);
  });

  it("closes on the close button", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /open menu/i }));
    await user.click(screen.getByRole("button", { name: /close menu/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("closes when a navigation link is chosen", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /open menu/i }));
    const dialog = screen.getByRole("dialog", { name: /menu/i });
    const features = Array.from(dialog.querySelectorAll("a")).find((a) => /features/i.test(a.textContent));
    await user.click(features);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lists the same destinations as the desktop nav, and no phone number", async () => {
    const user = userEvent.setup();
    setup();
    const desktop = Array.from(document.querySelectorAll(".site-nav a")).map((a) => a.textContent.trim());
    await user.click(screen.getByRole("button", { name: /open menu/i }));
    const dialog = screen.getByRole("dialog", { name: /menu/i });
    const sheet = Array.from(dialog.querySelectorAll(".site-menu__nav a")).map((a) => a.textContent.trim());
    expect(sheet).toEqual(desktop);
    expect(desktop).toContain("Features");
    expect(desktop).toContain("Contact");
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
  });
});

describe("the desktop nav", () => {
  it("marks the current page", () => {
    setup("/contact");
    const contact = Array.from(document.querySelectorAll(".site-nav a")).find((a) => /contact/i.test(a.textContent));
    expect(contact).toHaveAttribute("aria-current", "page");
    const features = Array.from(document.querySelectorAll(".site-nav a")).find((a) => /features/i.test(a.textContent));
    expect(features).not.toHaveAttribute("aria-current");
  });

  it("hides About until the owner fills its content", () => {
    setup();
    const labels = Array.from(document.querySelectorAll(".site-nav a")).map((a) => a.textContent.trim());
    // content/about.js still carries OWNER_TODO slots.
    expect(labels).not.toContain("About");
  });
});

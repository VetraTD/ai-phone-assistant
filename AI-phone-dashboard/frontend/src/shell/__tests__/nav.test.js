import { describe, it, expect } from "vitest";
import { calendarAvailable, navItems } from "../nav";

const DEFS = {
  capabilities: [
    { id: "appointments", core: false, adapterKind: "scheduling" },
    { id: "messages", core: true, adapterKind: null },
  ],
  adapters: {
    scheduling: [
      { id: "internal", storesBookingsLocally: true },
      { id: "athenahealth", storesBookingsLocally: false },
      { id: "webhook", storesBookingsLocally: false },
    ],
  },
};
const row = (over) => ({ capability_id: "appointments", enabled: true, adapter: "internal", ...over });

describe("calendarAvailable", () => {
  it("is true when bookings are on and live in VetraTD's own calendar", () => {
    expect(calendarAvailable(DEFS, [row()])).toBe(true);
  });
  it("is true when bookings are on and no backend was chosen (the built-in calendar is the default)", () => {
    expect(calendarAvailable(DEFS, [row({ adapter: null })])).toBe(true);
  });
  it("is false when bookings live in athenahealth", () => {
    expect(calendarAvailable(DEFS, [row({ adapter: "athenahealth" })])).toBe(false);
  });
  it("is false when bookings are off", () => {
    expect(calendarAvailable(DEFS, [row({ enabled: false })])).toBe(false);
  });
  it("is false before the definitions have loaded", () => {
    expect(calendarAvailable(null, [row()])).toBe(false);
  });
});

describe("navItems", () => {
  it("lists the five tabs in order, with Agent as the short label", () => {
    const items = navItems({ calendarAvailable: true });
    expect(items.map((i) => i.to)).toEqual(["/home", "/inbox", "/calendar", "/voice-agent", "/settings"]);
    expect(items.find((i) => i.to === "/voice-agent")).toMatchObject({ label: "Voice agent", short: "Agent" });
  });
  it("leaves Calendar out where there is no calendar", () => {
    const items = navItems({ calendarAvailable: false });
    expect(items).toHaveLength(4);
    expect(items.map((i) => i.to)).not.toContain("/calendar");
  });
});

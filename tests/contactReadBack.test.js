import { describe, it, expect } from "vitest";
import { collectBusinessContacts, readsCallerContactBack } from "../lib/voice/contactReadBack.js";

// ---------------------------------------------------------------------------
// Ilija inbound Task N fix round 4. The post-call message net no longer waits
// for a declared intent (a tenant with no allowed tasks can only declare
// general_question). It waits for the assistant to have READ A CALLER'S
// CONTACT DETAILS back: a 7+ digit run or an email address that is not one of
// the business's own. A spelled-out name alone never counts, because
// businesses spell their own names. Every sentence here is invented.
// ---------------------------------------------------------------------------
const BUSINESS_ROW = {
  phone_number: "+441372656055",
  main_phone: "+442071234567",
  transfer_phone_number: "+441111222333",
  notification_phone: "+447700900111",
  notification_email: "Owner@Example-Studio.com",
  general_info: "Call the studio on 020 7946 0958 or email hello@example-studio.com for quotes.",
  custom_instructions: "Our fax is 0 2 0 7 9 4 6 0 9 9 9. Spoken form: bookings at example-studio dot co dot uk.",
};
const CONFIG = {
  businessPhone: "+441372656055",
  capabilities: { messages: { enabled: true, notes: "Urgent matters: 07700 900222." } },
};
const contacts = () => collectBusinessContacts({ business: BUSINESS_ROW, config: CONFIG, numbers: ["+19995550100"] });

describe("collectBusinessContacts", () => {
  it("collects the fixed fields, the prose runs and the extra numbers, by last seven digits", () => {
    const c = contacts();
    for (const last7 of [
      "2656055", // business line, main phone is below
      "1234567", // main_phone
      "1222333", // transfer number
      "0900111", // notification_phone
      "9460958", // a run in general_info
      "9460999", // spoken-digit style run in custom_instructions
      "0900222", // a run in a capability note
      "5550100", // an extra number handed in
    ]) {
      expect(c.numbers.has(last7)).toBe(true);
    }
  });

  it("collects emails, lower-cased and with spoken forms normalised", () => {
    const c = contacts();
    expect(c.emails.has("owner@example-studio.com")).toBe(true);
    expect(c.emails.has("hello@example-studio.com")).toBe(true);
    expect(c.emails.has("bookings@example-studio.co.uk")).toBe(true);
  });

  it("copes with nothing at all", () => {
    const c = collectBusinessContacts({});
    expect(c.numbers.size).toBe(0);
    expect(c.emails.size).toBe(0);
  });
});

describe("readsCallerContactBack", () => {
  const c = contacts();
  const POS = [
    "So that's Ellie, Hughes, H-U-G-H-E-S, on 4 6 9, 9 3 3, 8 8 8 7 about marketing for your salon.",
    "So that's Priya on oh seven seven zero zero nine one two three four five, is that right?",
    "Is your email tom@example.com?",
    "Your email is tom at example dot com.",
    // A caller number run that merely follows words about the business.
    "The number you gave me is 469, 933, 8878.",
  ];
  const NEG = [
    // The business's own line, in the several ways it is said.
    "You can reach the office on 01372 656055, or I can take a message?",
    "You can reach the office on +44 1372 656055.",
    "You can reach us on oh one three seven two six five six oh five five.",
    "The transfer line is 01111 222333.",
    "Call the studio on 020 7946 0958.",
    "For urgent matters ring 07700 900222.",
    // The business's own email, written and spoken.
    "You can email owner@example-studio.com.",
    "You can email hello at example-studio dot com.",
    // A spelled-out name alone: a business spells its own name.
    "That's E-X-A-M-P-L-E, Example Studio.",
    "So that's Ellie, H-U-G-H-E-S, is that okay?",
    // Hours, prices and emergency numbers are not contact details.
    "We open at 9 tomorrow. Would you like to leave a message?",
    "We're open 8:30 to 5:30 weekdays and 9 to 12 on Saturdays.",
    "Projects usually run from 1,500 to 2,500.",
    "If this is an emergency, please call 999.",
    "",
    undefined,
  ];
  it.each(POS)("counts: %s", (s) => expect(readsCallerContactBack(s, c)).toBe(true));
  it.each(NEG)("does not count: %s", (s) => expect(readsCallerContactBack(s, c)).toBe(false));

  it("with no contacts handed in, every number is a caller's", () => {
    expect(readsCallerContactBack("Ring 01372 656055.", undefined)).toBe(true);
  });
});

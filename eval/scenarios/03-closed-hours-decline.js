/**
 * DECLINE: the office is closed right now (hours computed closed relative to the
 * real clock) and booking is restricted to business hours. The receptionist
 * must recognise it can't book at all before collecting any details, and fall
 * back to taking a message — never quietly booking an out-of-hours slot.
 */
import * as A from "../asserts.js";
import { hoursClosedNow } from "../scenarioUtils.js";

const TZ = "America/Chicago";

export default {
  name: "closed-hours-decline",
  tags: ["decline"],
  fixture: "appointments-availability",
  configPatch: {
    businessHours: hoursClosedNow({ timezone: TZ }),
    capabilities: {
      appointments: {
        enabled: true,
        adapter: "internal",
        availability: { length: 30, capacity: 1 },
        require: { businessHoursOnly: true },
        notes: null,
      },
    },
  },
  caller: {
    mode: "scripted",
    turns: [
      "Hi, I'd like to book a cleaning for tomorrow afternoon please.",
      "Oh okay. What can we do then?",
    ],
  },
  hard: [(ctx) => A.toolNotCalled(ctx, "book_appointment")],
  judge: [
    "Did the receptionist make clear it cannot book an appointment right now because the office is closed, rather than proceeding to collect booking details?",
    "Did the receptionist offer to take a message or a callback as the alternative?",
  ],
};

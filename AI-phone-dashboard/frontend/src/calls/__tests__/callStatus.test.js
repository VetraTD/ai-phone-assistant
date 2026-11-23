import { describe, it, expect } from "vitest";
import { needText, statusLine, didList } from "../callStatus";

const TZ = "America/Chicago";
const call = (over) => ({ id: "c1", status: "completed", handled_at: null, handled_by: null, ...over });
const req = (over) => ({ request_type: "message", preferred_time: null, ...over });
const appt = (over) => ({ id: "a1", scheduled_at: "2026-11-24T15:00:00Z", status: "scheduled", ...over });

describe("needText (the /api/home request shape)", () => {
  it("names what the caller needs, in their terms", () => {
    expect(needText({ type: "callback", preferredTime: "after 3 pm" })).toBe("Call back after 3 pm");
    expect(needText({ type: "callback" })).toBe("Call back");
    expect(needText({ type: "message" })).toBe("Read their message");
  });
});

describe("statusLine (the /api/calls/:id shapes)", () => {
  it("an open request is what is needed", () => {
    expect(statusLine({ call: call(), appointments: [], requests: [req({ request_type: "callback", preferred_time: "tomorrow morning" })] }))
      .toEqual({ tone: "needs", text: "Call back tomorrow morning" });
  });

  it("a request someone marked done says so", () => {
    expect(statusLine({ call: call({ handled_at: "2026-11-23T10:00:00Z", handled_by: "uid-1" }), appointments: [], requests: [req()] }))
      .toEqual({ tone: "done", text: "Marked done" });
  });

  it("a request closed at launch says so, plainly", () => {
    expect(statusLine({ call: call({ handled_at: "2026-11-23T10:00:00Z", handled_by: "launch" }), appointments: [], requests: [req()] }))
      .toEqual({ tone: "done", text: "Marked done when the new dashboard launched" });
  });

  it("a booking or a transfer with no request leaves nothing to do", () => {
    expect(statusLine({ call: call(), appointments: [appt()], requests: [] })).toEqual({ tone: "done", text: "Nothing for you to do" });
    expect(statusLine({ call: call({ status: "transferred" }), appointments: [], requests: [] }))
      .toEqual({ tone: "done", text: "Nothing for you to do" });
  });

  it("anything else only says no message was left", () => {
    expect(statusLine({ call: call(), appointments: [], requests: [] })).toEqual({ tone: "quiet", text: "No message was left." });
  });
});

describe("didList", () => {
  it("lists what VetraTD did on the call, in plain words", () => {
    expect(
      didList({
        call: call({ status: "transferred" }),
        appointments: [appt()],
        requests: [req({ request_type: "callback" }), req({ request_type: "message" })],
        tz: TZ,
      })
    ).toEqual([
      "Booked an appointment for Tuesday 24 November, 9:00 am",
      "Took a call-back request",
      "Took a message",
      "Put the call through to your team",
    ]);
  });

  it("lists nothing for a call that did nothing", () => {
    expect(didList({ call: call(), appointments: [], requests: [], tz: TZ })).toEqual([]);
  });
});

describe("statusLine: live calls and late requests", () => {
  it("a call still going says so, and claims nothing", () => {
    expect(statusLine({ call: call({ status: "in-progress" }), appointments: [], requests: [] }))
      .toEqual({ tone: "quiet", text: "This call is still going." });
  });

  it("a request that arrived after Done is needed again", () => {
    const handled = call({ handled_at: "2026-11-23T10:00:00Z", handled_by: "uid-1" });
    const late = req({ request_type: "unconfirmed_claim", created_at: "2026-11-23T10:05:00Z" });
    expect(statusLine({ call: handled, appointments: [], requests: [late] })).toEqual({ tone: "needs", text: "Call back to confirm" });
  });

  it("a request older than Done stays done", () => {
    const handled = call({ handled_at: "2026-11-23T10:00:00Z", handled_by: "uid-1" });
    const early = req({ created_at: "2026-11-23T09:55:00Z" });
    expect(statusLine({ call: handled, appointments: [], requests: [early] })).toEqual({ tone: "done", text: "Marked done" });
  });
});

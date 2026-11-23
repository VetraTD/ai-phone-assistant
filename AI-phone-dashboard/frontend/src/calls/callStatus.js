import { formatDateTime } from "./format";

// What a call needs from the owner, and what VetraTD did on it, in the
// caller's terms (spec §8 Inbox). Built only from what is recorded per call
// today: a booking made on the call (appointments.call_id), a message or
// call-back request (customer_requests), a transfer (calls.status).

/**
 * What is needed, from a request in the /api/home shape ({ type, preferredTime }).
 * @returns {string}
 */
export function needText({ type, preferredTime } = {}) {
  if (type === "callback") {
    const when = typeof preferredTime === "string" ? preferredTime.trim() : "";
    return when ? `Call back ${when}` : "Call back";
  }
  // A call the system could not confirm it completed (lib/postCallVerify.js):
  // the caller expects something, so ring them.
  if (type === "unconfirmed_claim") return "Call back to confirm";
  if (type === "quote") return "Reply to their quote request";
  return "Read their message";
}

// A customer_requests row from GET /api/calls/:id, in needText's shape.
const toNeed = (row) => ({ type: row?.request_type, preferredTime: row?.preferred_time });

/**
 * The coloured line under a call's name. `requests` is newest first, as the
 * API returns them.
 * @returns {{ tone: "needs" | "done" | "quiet", text: string }}
 */
export function statusLine({ call, appointments = [], requests = [] }) {
  if (requests.length) {
    if (!call?.handled_at) return { tone: "needs", text: needText(toNeed(requests[0])) };
    return {
      tone: "done",
      text: call.handled_by === "launch" ? "Marked done when the new dashboard launched" : "Marked done",
    };
  }
  // Only a booking or a transfer earns "nothing to do": a hang-up, a refused
  // message or a technical failure would make "handled" untrue.
  if (appointments.length || call?.status === "transferred") return { tone: "done", text: "Nothing for you to do" };
  return { tone: "quiet", text: "No message was left." };
}

const DID_REQUEST = {
  callback: "Took a call-back request",
  message: "Took a message",
  quote: "Took a quote request",
};

/**
 * "What VetraTD did", as a ticked list.
 * @returns {string[]}
 */
export function didList({ call, appointments = [], requests = [], tz }) {
  const out = [];
  for (const a of appointments) out.push(`Booked an appointment for ${formatDateTime(a.scheduled_at, tz)}`);
  for (const r of requests) {
    const line = DID_REQUEST[r.request_type];
    if (line) out.push(line);
  }
  if (call?.status === "transferred") out.push("Put the call through to your team");
  return out;
}

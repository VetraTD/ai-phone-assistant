import { formatDateTime } from "./format";

// What a call needs from the owner, and what VetraTD did on it, in the
// caller's terms (spec §8 Inbox). Built only from what is recorded per call:
// a booking made on the call (appointments.call_id), a booking it moved or
// cancelled (appointment_changes, migration 062), a message or call-back
// request (customer_requests), a transfer (calls.status).

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
export function statusLine({ call, appointments = [], requests = [], changes = [] }) {
  if (requests.length) {
    const latest = requests.reduce((a, b) => (new Date(b?.created_at || 0) > new Date(a?.created_at || 0) ? b : a), requests[0]);
    // Open when nobody has marked it done, or a request arrived after they did
    // (the post-call follow-up is written at call end).
    const lateRequest = call?.handled_at && latest?.created_at && new Date(latest.created_at) > new Date(call.handled_at);
    if (!call?.handled_at || lateRequest) return { tone: "needs", text: needText(toNeed(latest)) };
    return {
      tone: "done",
      text: call.handled_by === "launch" ? "Marked done when the new dashboard launched" : "Marked done",
    };
  }
  // A call still going has done nothing yet, and must not read as finished.
  if (call?.status === "in-progress") return { tone: "quiet", text: "This call is still going." };
  // Only a booking, a booking change or a transfer earns "nothing to do": a
  // hang-up, a refused message or a technical failure would make "handled" untrue.
  if (appointments.length || changes.length || call?.status === "transferred") {
    return { tone: "done", text: "Nothing for you to do" };
  }
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
export function didList({ call, appointments = [], requests = [], changes = [], tz }) {
  const out = [];
  // The time it was booked FOR: a later move is its own line below, or on the
  // call that made it.
  for (const a of appointments) {
    out.push(`Booked an appointment for ${formatDateTime(a.booked_scheduled_at || a.scheduled_at, tz)}`);
  }
  // Oldest first, as the API returns them: a move then a cancel reads in order.
  for (const c of changes) {
    const name = typeof c?.client_name === "string" ? c.client_name.trim() : "";
    const whose = name ? `${name}'s booking` : "a booking";
    if (c?.kind === "moved") {
      out.push(`Moved ${whose} from ${formatDateTime(c.old_scheduled_at, tz)} to ${formatDateTime(c.new_scheduled_at, tz)}`);
    } else if (c?.kind === "cancelled") {
      out.push(`Cancelled ${whose}, ${formatDateTime(c.old_scheduled_at, tz)}`);
    }
  }
  for (const r of requests) {
    const line = DID_REQUEST[r.request_type];
    if (line) out.push(line);
  }
  if (call?.status === "transferred") out.push("Put the call through to your team");
  return out;
}

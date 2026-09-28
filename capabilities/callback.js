// capabilities/callback.js
/**
 * S3-3 (spec §12.2): the "callback" PLATFORM pack -- `schedule_callback`.
 *
 * PLATFORM, not tenant. See capabilities/outcome.js's file header for the
 * shared mechanics this pack follows exactly: `tools()` returns its
 * declaration unconditionally; services/gemini.js's filterForOutboundCampaign
 * (and services/tools.js's execution-time mirror of it) is what unions it
 * onto every outbound call regardless of the campaign's own `capabilities`
 * list, and strips it from every inbound call.
 *
 * NOT an action tool (named risk 2): booking a callback is not gated by
 * O-12's unverified-party refusal, because a gatekeeper who will never pass
 * confirm_identity must still be able to book one on the contact's behalf
 * (lib/outbound/prompt.js's own gatekeeper situation line).
 *
 * VALIDITY, THE SEAM (controller ruling). `validateCallbackTime` is the ONE
 * function that decides whether a requested time is bookable: the campaign's
 * calling window, and a 14-day cap, both evaluated on the CONTACT's own
 * clock (contactTimezone-resolved timezone already sits on
 * outboundCall.contact.timezone by the time a Live call reaches this tool --
 * see lib/outbound/callContext.js). S3-7 adds the per-country legal floor
 * later, and it is added HERE and only here, so execute() never needs a
 * second edit the day that ships.
 */
import { HAS_OFFSET_RE, parseNaiveDateTime, zonedComponentsToUtcMs } from "../lib/capabilities/datetime.js";
import { isInsideWindow, nextWindowOpening } from "../lib/outbound/schedule.js";

const SCHEDULE_CALLBACK_DECLARATION = {
  name: "schedule_callback",
  description:
    "Book a specific day and time to call this contact back. `when_iso` is the day and time IN THE " +
    "CONTACT'S OWN LOCAL TIME, as YYYY-MM-DDTHH:MM with no timezone offset -- write it exactly as they " +
    "would read a clock on their own wall, never converted to any other timezone. If the time is not " +
    "available you will be told the nearest time that is -- offer that instead of guessing another one " +
    "yourself.",
  parameters: {
    type: "object",
    properties: {
      when_iso: {
        type: "string",
        description: "The callback's day and time, in the contact's own local time, as YYYY-MM-DDTHH:MM.",
      },
      when_text: {
        type: "string",
        description: "What the contact actually said, e.g. \"tomorrow afternoon\" or \"Thursday around 2\".",
      },
    },
    required: ["when_iso"],
  },
};

const MAX_DAYS_AHEAD = 14;
const DAY_MS = 86_400_000;

/**
 * THE validity seam (controller ruling): campaign window + the 14-day cap,
 * on the CONTACT's clock. Exported so tests/outboundPacks.test.js can pin it
 * directly, and so S3-7 has one function to extend rather than a second call
 * site to find.
 *
 * @param {Date} candidate - the requested instant, already resolved to UTC
 * @param {{callingWindow: object|null, tz: string, now: Date, maxDaysAhead?: number}} o
 * @returns {{ok: true} | {ok: false, nearest: string}}
 */
export function validateCallbackTime(candidate, { callingWindow, tz, now, maxDaysAhead = MAX_DAYS_AHEAD }) {
  const capMs = now.getTime() + maxDaysAhead * DAY_MS;
  const withinCap = candidate.getTime() <= capMs;
  const insideWindow = isInsideWindow(candidate, callingWindow, tz);
  if (withinCap && insideWindow) return { ok: true };

  // Nearest bookable time: the next window opening from now, capped at the
  // 14-day boundary so a caller is never offered a date outside the cap
  // this same check just refused.
  const opening = nextWindowOpening(now, callingWindow, tz);
  const cap = new Date(capMs);
  const nearest = opening && opening.getTime() <= capMs ? opening : cap;
  return { ok: false, nearest: nearest.toISOString() };
}

/** Parse `when_iso` as a wall-clock time in the contact's timezone, or a fully-qualified instant verbatim. */
function parseWhenIso(raw, tz) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return null;
  if (HAS_OFFSET_RE.test(trimmed)) {
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const parsed = parseNaiveDateTime(trimmed);
  if (!parsed) return null;
  const ms = zonedComponentsToUtcMs(parsed, tz);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** "Thursday, 2:00 pm" in the contact's own timezone -- what gets spoken back, per the tool's contract. */
function formatContactLocal(date, tz) {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "long",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function refusal(fc, message, extra = {}) {
  return {
    functionResponse: { id: fc.id, name: fc.name, response: { success: false, message, ...extra } },
    stateEffects: {
      toolResult: { name: fc.name, success: false, message },
      toolCallEvent: { name: fc.name, args: fc.args ?? {}, silent: true },
    },
  };
}

/** @type {import("./_contract.js").CapabilityPack} */
export default {
  id: "callback",
  label: "Callback scheduling",
  description:
    "Book a specific day and time to call an outbound contact back, inside the campaign's calling " +
    "window. Always available on an outbound call; never used on inbound.",
  core: false,
  adapterKind: null,

  toolNames: [SCHEDULE_CALLBACK_DECLARATION.name],
  // Named risk 2: never an action tool. See the file header.
  actionTools: [],

  tools() {
    return [SCHEDULE_CALLBACK_DECLARATION];
  },

  async execute(fc, ctx = {}) {
    const outbound = ctx.outboundCall;
    if (!outbound) {
      // Fail closed (memory plan-verbatim-code-fails-open): this tool has no
      // campaign window or contact timezone to validate against without
      // outbound call context, so it must refuse rather than guess one.
      return refusal(fc, "This tool is only available on an outbound call.");
    }

    const contactTz = outbound.contact?.timezone;
    if (!contactTz) {
      return refusal(fc, "No contact timezone is available, so a callback time cannot be validated.");
    }

    const candidate = parseWhenIso(fc.args?.when_iso, contactTz);
    if (!candidate) {
      return refusal(
        fc,
        "That date/time could not be understood. Ask the contact for a specific day and time, in the " +
          "form YYYY-MM-DDTHH:MM, and try again."
      );
    }

    const now = new Date();
    const verdict = validateCallbackTime(candidate, {
      callingWindow: outbound.config?.calling_window || null,
      tz: contactTz,
      now,
    });
    if (!verdict.ok) {
      const nearestSpoken = formatContactLocal(new Date(verdict.nearest), contactTz);
      const message =
        `That time is not available. The nearest available time is ${verdict.nearest} ` +
        `(${nearestSpoken}, their local time) -- offer that time instead.`;
      return refusal(fc, message, { nearest: verdict.nearest });
    }

    const callSid = ctx.callSid || null;
    if (callSid) {
      await ctx.deps?.setCallOutcomeCode?.(callSid, "callback_requested");
      await ctx.deps?.mergeCallAnswers?.(callSid, { callback_requested_at: candidate.toISOString() });
    }

    const spoken = formatContactLocal(candidate, contactTz);
    const message =
      `Callback booked for ${spoken}, their local time. Tell them you will call back then, then wrap up the call.`;

    return {
      functionResponse: {
        id: fc.id,
        name: fc.name,
        response: { success: true, message, at: candidate.toISOString(), spoken },
      },
      stateEffects: {
        toolResult: { name: fc.name, success: true, message },
        toolCallEvent: { name: fc.name, args: fc.args ?? {} },
        capabilityState: { callback: { at: candidate.toISOString() } },
      },
    };
  },
};

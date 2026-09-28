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
 *
 * S3-7: the floor is optional on `validateCallbackTime`'s `phone` option
 * (omitted, not falsy -- `phone === undefined`), so the pre-S3-7 "unit
 * level" tests of the window+cap logic alone (tests/outboundPacks.test.js)
 * keep testing exactly what they always tested. `execute()` (below) always
 * supplies it, guarded by the same fail-closed no-phone check it already has
 * for no-timezone, so PRODUCTION never takes the skip path.
 * outboundCall.contact.timezone is already resolved (contactTimezone()'s
 * fallback), never the raw DB column, so floorFor's US "no timezone on
 * file" dual-zone rule cannot fire from this call site -- only gate.js's
 * dispatch-time check (which has the raw column) can.
 */
import { HAS_OFFSET_RE, parseNaiveDateTime, zonedComponentsToUtcMs } from "../lib/capabilities/datetime.js";
import { isInsideWindow, nextWindowOpening } from "../lib/outbound/schedule.js";
import { floorFor, isInsideFloor, nextLegalOpening } from "../lib/outbound/legalFloor.js";

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
// I4 (review, controller ruling): a callback booked with no lead time at all
// re-dials the contact minutes after they asked for a LATER time (the
// review's own repro: "call me tomorrow at ten", written by the model as
// TODAY's date, re-dialled within minutes). 10 minutes floors both a
// genuinely past instant and one so close it could not be dispatched in
// time to matter.
const MIN_LEAD_MS = 10 * 60_000;

/**
 * THE validity seam (controller ruling): campaign window + the 14-day cap,
 * on the CONTACT's clock. Exported so tests/outboundPacks.test.js can pin it
 * directly, and so S3-7 has one function to extend rather than a second call
 * site to find.
 *
 * @param {Date} candidate - the requested instant, already resolved to UTC
 * @param {{callingWindow: object|null, tz: string, now: Date, maxDaysAhead?: number, phone?: string, rawTimezone?: string|null}} o
 *   `phone` is OPTIONAL (see the file header): when given, the S3-7
 *   per-country floor is also enforced; when omitted, only the window and
 *   the 14-day cap are (the pre-S3-7 contract). `rawTimezone` (fix round 1,
 *   review Important #2) is the RAW contact timezone -- null when genuinely
 *   unset on the row -- used ONLY to pick the floor's zone(s); `tz` (the
 *   resolved/fallback value) still drives the window check and stays what
 *   `floorFor` gets when `rawTimezone` is omitted, so an old caller that
 *   does not know about this parameter keeps its pre-fix behaviour exactly.
 * @returns {{ok: true} | {ok: false, nearest: string, reason: string} | {ok: false, nearest: null, refused: "no_legal_floor"|"no_legal_opening"}}
 */
export function validateCallbackTime(candidate, { callingWindow, tz, now, maxDaysAhead = MAX_DAYS_AHEAD, phone, rawTimezone }) {
  const capMs = now.getTime() + maxDaysAhead * DAY_MS;
  // I4 (review, controller ruling): refuse a candidate less than MIN_LEAD_MS
  // from now -- covers BOTH a genuinely past instant (candidate < now) and
  // one so close there is no realistic time to act on it before it fires.
  const minLeadMs = now.getTime() + MIN_LEAD_MS;
  const tooSoon = candidate.getTime() < minLeadMs;
  const withinCap = candidate.getTime() <= capMs;
  const insideWindow = isInsideWindow(candidate, callingWindow, tz);

  let floor = null;
  if (phone !== undefined) {
    // Fix round 1 (review Important #2): the floor's zone classification
    // reads the RAW contact timezone, not `tz` -- the controller's "raw, not
    // fallback" ruling applies to every floor call site, not only gate.js.
    // `rawTimezone === undefined` (the caller never passed it at all) falls
    // back to `tz`, not to `null`: defaulting to `null` here would silently
    // force the dual-zone rule onto every pre-fix caller that only ever knew
    // about the resolved timezone, which is a behaviour change this fix does
    // not need to make (execute(), below, always passes the true value now).
    const floorTz = rawTimezone !== undefined ? rawTimezone : tz;
    floor = floorFor(phone, floorTz);
    if (floor.refused) {
      // No owner-approved floor exists for this contact at all: never
      // bookable, and there is no "nearest" time to search for -- refuse
      // outright (fail closed) rather than offer a time the floor will
      // never grant.
      return { ok: false, nearest: null, refused: floor.refused };
    }
  }
  const insideFloor = floor ? isInsideFloor(candidate, floor) : true;
  if (!tooSoon && withinCap && insideWindow && insideFloor) return { ok: true };

  // I5 (review, controller ruling): search from the LATER of the requested
  // instant and the earliest bookable lead time -- never from `now` alone.
  // Searching from `now` made every refusal during a live call read as
  // "now+1 minute" (`now` is always inside window+floor by construction, so
  // the very next minute almost always is too), regardless of what the
  // contact actually asked for; a caller who asked for next Tuesday got
  // offered "today, one minute from now". This finds the next opening AT OR
  // AFTER the requested instant instead, capped at the same 14-day boundary
  // a caller is never offered a date outside of.
  const searchFrom = new Date(Math.max(candidate.getTime(), minLeadMs));
  const opening = floor ? nextLegalOpening(searchFrom, floor, callingWindow, tz) : nextWindowOpening(searchFrom, callingWindow, tz);
  if (floor && !opening) {
    // Fix round 1 (review Important #1): the bounded search found NO instant
    // where the floor and the campaign's own window are open at once -- the
    // SAME exhaustion gate.js's own check 7b turns into never("no_legal_floor")
    // rather than a park or an allow. Falling through to the raw 14-day cap
    // below would hand back an instant nobody ever verified as legal, and
    // re-validating that same offered instant refuses it again -- an
    // unbookable loop (the review's own empirical repro), not a fabricated
    // booking (insideFloor above still gates `ok:true`), but never a real
    // "nearest" either. Fail closed the same way the early floor-refusal
    // branch above does.
    //
    // B5 (review, paired with I5): a DIFFERENT refused code from the
    // outright "no floor exists for this jurisdiction" case above --
    // execute() (below) gives each its own wording. Structurally these are
    // different problems: this one has an owner-approved floor, it simply
    // never overlaps the campaign's own configured window within the bound
    // (a campaign misconfiguration), where the outright case has no
    // approved floor for the jurisdiction at all.
    return { ok: false, nearest: null, refused: "no_legal_opening" };
  }
  const cap = new Date(capMs);
  const nearest = opening && opening.getTime() <= capMs ? opening : cap;
  // I5 (review): name the refusal reason so execute()'s wording can say WHY,
  // rather than "not available" for every case alike. Priority mirrors the
  // guard order above -- the first condition that actually failed.
  const reason = tooSoon ? "too_soon" : !withinCap ? "too_far_ahead" : !insideWindow ? "outside_hours" : "outside_floor";
  return { ok: false, nearest: nearest.toISOString(), reason };
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
    // S3-7: the floor needs the contact's own number too -- fail closed the
    // same way a missing timezone already does, rather than silently
    // skipping the floor (validateCallbackTime's `phone` is optional
    // precisely so a caller CAN skip it, and this tool must never be that
    // caller).
    const contactPhone = outbound.contact?.phone;
    if (!contactPhone) {
      return refusal(fc, "No contact phone number is available, so a callback time cannot be validated.");
    }
    // Fix round 1 (review Important #2): the RAW contact timezone (null when
    // genuinely unset -- lib/outbound/callContext.js:130 now carries it
    // alongside the resolved `contact.timezone` above), NOT the fallback
    // used for parsing/display. `!== undefined` (not `??`) so an outbound
    // call context that predates this fix (no `rawTimezone` key at all)
    // falls back to the resolved value -- validateCallbackTime's own
    // pre-fix contract -- rather than silently forcing the dual-zone rule
    // onto every caller that never carried this field.
    const contactRawTimezone = outbound.contact?.rawTimezone !== undefined ? outbound.contact.rawTimezone : contactTz;

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
      phone: contactPhone,
      rawTimezone: contactRawTimezone,
    });
    if (!verdict.ok) {
      if (verdict.refused === "no_legal_floor") {
        // No owner-approved calling-hours floor exists for this contact at
        // all (S3-7): there is no "nearest" time to offer, so this is a
        // hard refusal, not a reschedule suggestion.
        return refusal(
          fc,
          "This contact cannot be booked for an automatic callback -- there is no approved calling-hours " +
            "policy for their phone number. Let them know a team member will follow up instead."
        );
      }
      if (verdict.refused === "no_legal_opening") {
        // B5 (review, paired with I5): a DIFFERENT problem from the one
        // above -- a floor DOES exist, it just never overlaps the
        // campaign's own configured window within the 14-day bound. Saying
        // "no approved policy" here would be wrong (a policy exists); this
        // is a campaign misconfiguration, not a missing jurisdiction.
        return refusal(
          fc,
          "This contact's approved calling hours and the campaign's own calling window do not overlap " +
            "within the next two weeks, so no automatic callback time can be found. Let them know a team " +
            "member will follow up instead."
        );
      }
      // I5 (review): name the reason, not just "not available" -- a caller
      // who repeats the same refused request must be able to tell it was
      // heard, not looping on an unexplained no.
      const REASON_TEXT = {
        too_soon: "That time has already passed, or is too soon to book.",
        too_far_ahead: "That time is more than two weeks away, past the automatic booking window.",
        outside_hours: "That time is outside the campaign's own calling hours.",
        outside_floor: "That time is outside the approved calling hours for this contact.",
      };
      const nearestSpoken = formatContactLocal(new Date(verdict.nearest), contactTz);
      const message =
        `${REASON_TEXT[verdict.reason] || "That time is not available."} The nearest available time is ` +
        `${verdict.nearest} (${nearestSpoken}, their local time) -- offer that time instead.`;
      return refusal(fc, message, { nearest: verdict.nearest, reason: verdict.reason });
    }

    const callSid = ctx.callSid || null;
    if (callSid) {
      await ctx.deps?.setCallOutcomeCode?.(callSid, "callback_requested");
      // Minor (review): renamed from the plain `callback_requested_at` --
      // QUESTION_KEY_RE (campaignSchema.js) allows a campaign question
      // literally named that (it matches `/^[a-z][a-z0-9_]{0,39}$/` just
      // like any other question key), which would collide in calls.answers
      // with THIS tool's own write. Every reader (postCall.js) is renamed
      // to match; the leading underscore is what qualification.js's own
      // "never collides with a question key" claim actually depends on.
      await ctx.deps?.mergeCallAnswers?.(callSid, { _callback_requested_at: candidate.toISOString() });
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

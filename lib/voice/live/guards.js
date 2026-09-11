import { isWriteTool } from "../session.js";

import { toLocalNaiveDateTime } from "../../capabilities/datetime.js";
import { bumpCounter, bumpCounterBy } from "../metrics.js";
import { log } from "../../logger.js";

/**
 * Engine-owned tools, which are NOT writes and must never be deduplicated.
 *
 * `isWriteTool` resolves a tool to its capability pack and returns TRUE when
 * there is no pack -- fail-safe, and right for a tool nobody recognises.
 * `set_call_intent` and `end_call` belong to no pack by construction
 * (services/tools.js handles both itself), so both were being treated as
 * writes and cached in `completedWrites`.
 *
 * FOUND ON A REAL CALL, 2026-09-09 (CA7e12d0). end_call succeeded at 07:38:02,
 * armExit was refused inside the barge grace window, and LVX96's new latch
 * clear correctly dropped the hang-up intent because the caller kept talking.
 * The model then asked to hang up three more times -- 07:38:17, 07:38:29,
 * 07:38:58 -- and every one came back as a suppressed duplicate carrying the
 * cached success. A suppressed call short-circuits before `stateEffects` is
 * read, so `endCallArgs` never reached the engine and nothing could re-arm.
 *
 * The call ran 53 seconds past the point the model wanted to end it and closed
 * only because a sign-off finally matched the regex. Had it not, the silence
 * ladder was the only exit left.
 *
 * A REPEATED HANG-UP IS NOT A DUPLICATE WRITE. Idempotency exists so a second
 * booking attempt does not create a second row; there is no row here, and the
 * second request is legitimate precisely when the first one was cancelled.
 *
 * This was always true. LVX96's un-cleared latch is what hid it: the
 * end-of-turn retry kept re-arming from a flag that never went down, so nothing
 * ever needed end_call to succeed twice.
 */
const ENGINE_OWNED_TOOLS = new Set(["end_call", "set_call_intent"]);

/**
 * A write whose repetition would duplicate a ROW, which is what the cache is for.
 *
 * Used at BOTH sites deliberately. Exempting only the suppression check would
 * still freeze end_call into `completedWrites`, leaving a cache entry that
 * nothing reads -- true today and one refactor away from being wrong again.
 */
const isDeduplicatableWrite = (name) => isWriteTool(name) && !ENGINE_OWNED_TOOLS.has(name);

// ---------------------------------------------------------------------------
// Tool guards for the Live front-end. In the reducer, counted.
//
// docs/speech-to-speech-handoff.md section 6: "Guards belong in the reducer,
// counted. Not in the prompt — this codebase has already established that 'at
// most once' in a prompt does not hold."
//
// It has. The doubled goodbye, the doubled end_call, the spelling ask that
// spent itself twice: each was written as a prompt instruction first and became
// a counter in shared code afterwards, because that is the only version that
// holds. These are that version, written that way the first time.
//
// Two invariants, each with a measured defect behind it:
//
//   availability   gpt-realtime-2.1 books without checking in 9 of 20 trials.
//                  Gemini 2.5 re-fires tools in half its booking trials.
//   idempotency    Gemini 3.1 doubled end_call in 2 of 26 trials, and 2.5
//                  produced a doubled book_appointment.
// ---------------------------------------------------------------------------

/**
 * What the availability invariant knows how to read.
 *
 * Keyed by the availability tool's name, because that name is not fixed: the
 * built-in calendar registers `check_appointment_availability`, an EHR clinic
 * registers `get_available_slots` instead (services/gemini.js
 * availabilityCheckToolName). They are different tools with different response
 * shapes, and only one of them has a shape defined in this repository — the
 * other's comes back from athena.
 *
 * A business whose availability tool is not in here does not arm the invariant.
 * See `armed` below for why that is the right direction to fail.
 */
const AVAILABILITY_SHAPES = {
  check_appointment_availability: {
    /**
     * Tools that WRITE A TIME, and the argument the time arrives in.
     *
     * Named "booking" for its history; it is really "every tool this check is
     * allowed to authorise". reschedule_appointment_db was added 2026-09-04
     * (LVX49): it writes a time and was not in this map, so slotArg came back
     * undefined, before() returned {allow: true} at once, and -- because
     * looksLikeBooking only matched /^(book|schedule)_/ -- it was not even
     * counted as unarmed. A reschedule to an invented time was unguarded AND
     * invisible. Observed on a real call: verified_slots: 1 while
     * reschedule_appointment_db succeeded, the slot real only because the model
     * happened to have checked.
     *
     * KEYED BY NAME, deliberately, and that is a cost rather than an oversight:
     * every new tool that can write a time has to be added here by hand. It is
     * also the argument against a general update_appointment tool -- a field-bag
     * carrying scheduled_at would sit outside this map exactly the same way, and
     * would walk around the invariant with nothing to notice.
     */
    booking: {
      book_appointment: "scheduled_at",
      reschedule_appointment_db: "new_scheduled_at",
    },
    /**
     * Where open times appear in a response.
     *
     * `all_open_times` is load-bearing and is the easy one to miss.
     * `openTimesForDay` returns three SPREAD times in `open_times` for the
     * model to read out, and the complete list in `all_open_times`. A caller
     * who asks for something other than the three offered gets a time from the
     * full list — so harvesting only `open_times` would refuse a slot the tool
     * itself had just called open, which is the documented happy path.
     */
    lists: ["open_times", "all_open_times", "alternatives"],
    /**
     * The point check does not echo the slot it verified, so it has to be read
     * back off the request — and ONLY when the verdict was yes. `available:
     * false` means the opposite of verified, and harvesting `requested_at`
     * unconditionally would authorise exactly the slot the tool refused.
     */
    requestArg: "requested_at",
  },
};

/**
 * Per-call tool guards.
 *
 * @param {object} opts
 * @param {Array<{name: string}>} opts.declarations - the tools this call declared
 * @param {object} opts.config - normalised business config (timezone)
 */
export function createToolGuards({ declarations = [], config = {} } = {}) {
  const declared = new Set(declarations.map((d) => d?.name).filter(Boolean));
  const timezone = config?.timezone || "Europe/London";

  /**
   * The availability tool for this business, if it is one we can read.
   *
   * ---------------------------------------------------------------------------
   * Why an unreadable one fails OPEN
   * ---------------------------------------------------------------------------
   *
   * The two failure modes are not symmetric.
   *
   * A false BLOCK refuses a booking the caller agreed to, on a business that
   * may have no other way to book at all. Booking stops working.
   *
   * A false ALLOW lands on `book_appointment`, which re-checks the slot with
   * the adapter immediately before writing, on top of an atomic
   * createAppointmentIfAvailable. The caller does not get a double booking;
   * they get a booking at a time this guard could not confirm was offered.
   *
   * So an unknown shape does not arm, and says so in the counters rather than
   * silently doing nothing.
   */
  const shape = (() => {
    for (const [name, s] of Object.entries(AVAILABILITY_SHAPES)) {
      if (declared.has(name)) return { name, ...s };
    }
    return null;
  })();

  /** Slot keys (naive local, minute precision) an availability check returned open. */
  const verifiedSlots = new Set();
  /**
   * The subset of `verifiedSlots` a POINT check confirmed, kept apart from it.
   *
   * NOTHING IN THIS REPOSITORY HAS EVER RECORDED THE `available` VERDICT. Not a
   * log line, not a counter -- `respond()` in capabilities/appointments.js
   * returns `success: true` from every branch, including the one that means "that
   * time is taken", so a successful availability call says nothing about whether
   * the time was open. Trying to establish which times CA422f58 had actually
   * verified is what surfaced this: the record cannot answer it, and neither can
   * any historical call.
   *
   * `verifiedSlots` cannot answer it either, because it is ONE unordered set fed
   * from two very different places -- the response's list fields, and the
   * requested argument when a point check came back open. A day query can put
   * sixteen slots in it. So "which time did this call actually confirm for this
   * caller" has no answer without separating the two, and a booking that lands on
   * a list slot is not the same evidence as one that lands on a point check.
   *
   * Provenance only, and deliberately NOT used for gating here: the booking
   * invariant still reads `verifiedSlots`, so no write's outcome moves. What this
   * buys is a falsifiable claim later -- any design that wants to act on "the
   * time this call verified" can be checked against a real call first.
   */
  const pointVerifiedSlots = new Set();
  /** Cached responses for successful writes, keyed by name + canonical args. */
  const completedWrites = new Map();
  const counts = {
    availability_blocked: 0,
    // The POSITIVE half. A write that passed BECAUSE its slot was verified.
    // Without it, a call where every write was properly checked and a call that
    // never attempted a write both report availability_blocked: 0 -- and a
    // fault-only counter that reads zero for a clean run and for a run that
    // never got there cannot confirm anything.
    availability_allowed: 0,
    availability_unarmed: 0,
    duplicate_suppressed: 0,
    // The availability verdict, which has never been recorded. Three outcomes,
    // counted separately because they are different facts: a point check that
    // found the time open, a point check that found it TAKEN (which also emits
    // up to three alternatives the model is told to offer), and a day query that
    // returned a list. Per call rather than only process-global, because
    // "sixteen slots verified" and "one slot verified" are the difference
    // between a caller browsing and a caller agreeing.
    availability_point_open: 0,
    availability_point_taken: 0,
    availability_day_listed: 0,
  };

  /**
   * Canonical key for a datetime the model wrote.
   *
   * The round-trip contract is naive LOCAL wall clock — `open_times`,
   * `all_open_times` and `alternatives` are all emitted that way specifically
   * so the model can hand one straight back as `scheduled_at`
   * (capabilities/appointments.js). But `book_appointment` has been seen
   * receiving a verbatim offset-bearing ISO, and its own idempotency guard
   * compares instants rather than strings for exactly that reason.
   *
   * So: anything carrying a zone is resolved to the business's local wall clock
   * first; anything naive is taken as already local. Both truncate to the
   * minute. A guard that blocked on a formatting difference would be a guard
   * that broke booking.
   *
   * @param {string} value
   * @returns {string|null}
   */
  function slotKey(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return null;

    const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
    if (zoned) {
      const local = toLocalNaiveDateTime(raw, timezone);
      return local ? local.slice(0, 16) : null;
    }

    const m = raw.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/);
    return m ? `${m[1]}T${m[2]}:${m[3]}` : null;
  }

  /** Stable key for "the same call with the same arguments". */
  function callKey(fc) {
    return `${fc?.name}:${canonicalJson(fc?.args ?? {})}`;
  }

  /**
   * Should this tool call run?
   *
   * @param {{id: string, name: string, args: object}} fc
   * @returns {{allow: boolean, reason?: string, functionResponse?: object}}
   */
  function before(fc) {
    if (!fc?.name) return { allow: true };

    // Idempotency first: a duplicate of a completed write must be suppressed
    // even when it would also fail the availability check, so the model gets
    // back the success it already earned rather than a "go and check" for
    // something it has already done.
    if (isDeduplicatableWrite(fc.name) && completedWrites.has(callKey(fc))) {
      counts.duplicate_suppressed += 1;
      bumpCounter("live_guard_duplicate_suppressed");
      log.info("live_guard_duplicate_suppressed", { tool: fc.name });
      return {
        allow: false,
        reason: "duplicate_write",
        functionResponse: { ...completedWrites.get(callKey(fc)), id: fc.id },
      };
    }

    const slotArg = shape?.booking?.[fc.name];
    if (!slotArg) {
      // Not a booking tool this invariant covers. If it is a booking tool for
      // a business whose availability shape is unknown, that is the fail-open
      // case and it is counted so it is visible rather than assumed.
      if (!shape && looksLikeBooking(fc.name)) {
        counts.availability_unarmed += 1;
        bumpCounter("live_guard_availability_unarmed");
      }
      return { allow: true };
    }

    const key = slotKey(fc.args?.[slotArg]);
    if (key && verifiedSlots.has(key)) {
      counts.availability_allowed += 1;
      bumpCounter("live_guard_availability_allowed");
      return { allow: true };
    }

    counts.availability_blocked += 1;
    bumpCounter("live_guard_availability_blocked");
    // The slot itself is caller data; only whether it resolved is logged.
    log.error("live_guard_availability_blocked", {
      tool: fc.name,
      slot_parsed: Boolean(key),
      verified_count: verifiedSlots.size,
      severity: "warn",
    });

    return {
      allow: false,
      reason: "availability_unverified",
      functionResponse: {
        id: fc.id,
        name: fc.name,
        response: {
          success: false,
          message:
            `That time has not been checked yet. Call ${shape.name} for it first, ` +
            `then book only a time it reports as open.`,
        },
      },
    };
  }

  /**
   * Record what a completed tool call means for the invariants.
   *
   * @param {{id: string, name: string, args: object}} fc
   * @param {{functionResponse: {response: object}}} result
   */
  function after(fc, result) {
    if (!fc?.name) return;
    const response = result?.functionResponse?.response;

    if (shape && fc.name === shape.name && response) {
      let listed = 0;
      for (const listKey of shape.lists) {
        for (const value of asArray(response[listKey])) {
          const key = slotKey(value);
          if (key) {
            verifiedSlots.add(key);
            listed += 1;
          }
        }
      }
      if (listed > 0) {
        counts.availability_day_listed += listed;
        // bumpCounterBy, not bumpCounter. The per-call `counts` object
        // accumulates per SLOT and the process-global counter would otherwise
        // have counted CALLS -- the same name meaning two different numbers in
        // the two places it is read, which is how a number gets trusted for
        // something it never said. Caught by a test asserting the global and
        // getting 1 where the summary had many.
        bumpCounterBy("availability_day_listed", listed);
      }
      if (response.available === true) {
        const key = slotKey(fc.args?.[shape.requestArg]);
        if (key) {
          verifiedSlots.add(key);
          // The requested ARGUMENT, not a parsed sentence. This is the one slot
          // on a call that a real check confirmed for the time actually asked
          // about.
          pointVerifiedSlots.add(key);
          counts.availability_point_open += 1;
          bumpCounter("availability_point_open");
        }
      } else if (response.available === false) {
        // A point check that came back TAKEN. Worth its own counter because the
        // same response carries `alternatives`, which go into verifiedSlots
        // above and which the model is explicitly instructed to offer -- so this
        // is the moment a call stops having one candidate time and starts having
        // several.
        counts.availability_point_taken += 1;
        bumpCounter("availability_point_taken");
      }
    }

    // Only a SUCCESSFUL write is frozen. A transient backend failure must stay
    // retryable: caching it would turn the model's second attempt into a
    // no-op, and the caller would be told about a booking that never happened.
    if (isDeduplicatableWrite(fc.name) && response && response.success !== false) {
      completedWrites.set(callKey(fc), result.functionResponse);
    }
  }

  return {
    before,
    after,
    /** True when the availability invariant is actually in force this call. */
    get armed() {
      return Boolean(shape);
    },
    /**
     * How many slots a real availability response has put on the record.
     *
     * Read by the offer guard, which asks whether the assistant quoted times
     * when NOTHING had ever verified one. This set is the right authority for
     * that question because it is filled only from an availability tool's own
     * response -- the same record the booking invariant gates on -- so the
     * check needs no parsing of what was said.
     */
    verifiedCount() {
      return verifiedSlots.size;
    },
    /**
     * How many slots a POINT check confirmed open, as opposed to listed.
     *
     * Reported, not gated on. See pointVerifiedSlots.
     */
    pointVerifiedCount() {
      return pointVerifiedSlots.size;
    },
    counts() {
      return { ...counts };
    },
  };
}

/**
 * Time-writing tool names, for the unarmed counter only — never for gating.
 *
 * `reschedule` added with LVX49. Without it a reschedule on a business whose
 * availability shape is unknown failed open SILENTLY, which is the one thing
 * the fail-open direction is not allowed to do: the whole point of the counter
 * is that an unguarded write is visible rather than assumed.
 */
function looksLikeBooking(name) {
  return /^(book|schedule|reschedule)_/.test(name);
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

/** Key-sorted JSON, so argument order cannot make one call look like two. */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

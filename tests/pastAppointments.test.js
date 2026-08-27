/**
 * An appointment whose date has passed is not "an existing appointment".
 *
 * Reported from a live call: the assistant found appointments whose date had
 * already gone by and asked whether to book the new one "in addition to your
 * existing ones".
 *
 * The booking guard was never at fault — `upcomingForCaller` filters correctly.
 * The leak was the TOOL path: `internal.lookupByCaller` called
 * `listAppointmentsByCaller` without `upcomingOnly`, and nothing in the system
 * ever transitions an elapsed appointment out of status 'scheduled' (there is
 * no sweeper), so the query returned every appointment the caller had ever had,
 * oldest first. The model then reasoned aloud from a two-year-old row.
 */

import { describe, it, expect } from "vitest";
import internalAdapter from "../adapters/scheduling/internal.js";
import { makeFakeDeps } from "../lib/harness/fakeDeps.js";

const BUSINESS = "biz-past";
const CALLER = "+15551234567";
const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86_400_000).toISOString();

function ctxWith(seed) {
  const { deps } = makeFakeDeps({ seedAppointments: seed });
  return { businessId: BUSINESS, callerPhone: CALLER, deps };
}

const row = (scheduled_at, client_name) => ({
  business_id: BUSINESS,
  client_phone: CALLER,
  client_name,
  scheduled_at,
  status: "scheduled",
});

describe("lookupByCaller — past appointments", () => {
  it("does not return an appointment that has already happened", async () => {
    const ctx = ctxWith([row(iso(-30), "Old Booking")]);
    expect(await internalAdapter.lookupByCaller(ctx)).toEqual([]);
  });

  it("still returns upcoming ones", async () => {
    const ctx = ctxWith([row(iso(3), "Real Booking")]);
    const found = await internalAdapter.lookupByCaller(ctx);
    expect(found).toHaveLength(1);
    expect(found[0].client_name).toBe("Real Booking");
  });

  it("returns ONLY the upcoming one when the caller has both", async () => {
    // The live shape: a caller with history AND a real upcoming booking. The
    // past row sorted first, so it was the one the model saw and talked about.
    const ctx = ctxWith([row(iso(-400), "Two Years Ago"), row(iso(5), "Next Week")]);
    const found = await internalAdapter.lookupByCaller(ctx);
    expect(found.map((a) => a.client_name)).toEqual(["Next Week"]);
  });

  it("never reaches the database without a caller number", async () => {
    // Identity here comes from trusted Twilio metadata, never a model-supplied
    // value — no number, no lookup, rather than a business-wide list.
    const { deps } = makeFakeDeps({ seedAppointments: [row(iso(5), "Someone Else")] });
    expect(await internalAdapter.lookupByCaller({ businessId: BUSINESS, deps })).toEqual([]);
  });
});

describe("fakeDeps honours upcomingOnly", () => {
  // Until it did, no eval scenario could reproduce the bug OR verify the fix:
  // the harness silently ignored the option, so a scenario seeding a past
  // appointment behaved as though the product had no filter at all.
  it("filters when asked and does not when not", async () => {
    const { deps } = makeFakeDeps({
      seedAppointments: [row(iso(-10), "Past"), row(iso(10), "Future")],
    });

    const all = await deps.listAppointmentsByCaller(BUSINESS, { clientPhone: CALLER });
    expect(all.map((a) => a.client_name)).toEqual(["Past", "Future"]);

    const upcoming = await deps.listAppointmentsByCaller(BUSINESS, {
      clientPhone: CALLER,
      upcomingOnly: true,
    });
    expect(upcoming.map((a) => a.client_name)).toEqual(["Future"]);
  });
});

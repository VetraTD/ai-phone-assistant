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
import { executeToolCall } from "../services/tools.js";
import { loadConfig } from "../services/supabase.js";

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

// ---------------------------------------------------------------------------
// The hard-name spelling gate. Lives here rather than in its own file because
// it shares the executeToolCall plumbing exercised above.
// ---------------------------------------------------------------------------

describe("hard names are spelled before they become a record", () => {
  const config = () =>
    loadConfig({
      id: "b-name",
      name: "Testwork Dental",
      timezone: "America/Chicago",
      allowed_tasks: ["take_message"],
      business_capabilities: [{ capability_id: "messages", enabled: true, config: {} }],
    });

  const call = (caller_name) => ({
    id: "fc-1",
    name: "record_customer_request",
    args: { request_type: "message", caller_name, callback_number: "+15551234567" },
  });

  it("refuses once and asks for the spelling", async () => {
    const res = await executeToolCall(call("Venkateshwaria Ayalavarapu"), {
      config: config(),
      capabilityState: {},
      callerPhone: "+15551234567",
      spellingSettled: false,
    });
    expect(res.functionResponse.response.success).toBe(false);
    expect(res.functionResponse.response.message).toMatch(/spell/i);
    // Addressed to the model, not the caller — the "[not caller speech]" marker
    // is what stops it being read aloud verbatim on a text-free turn.
    expect(res.functionResponse.response.message).toMatch(/\[not caller speech\]/);
  });

  it("asks for an ordinary name too — policy changed 2026-08-29", async () => {
    // This test used to assert the opposite, and it was right for the policy it
    // was written against: only names looksHardToSpell flagged were confirmed.
    // But "Scripps" heard as "Smith" is a confident mis-hearing of a SHORT name,
    // which that heuristic cannot see by construction — and it is still the
    // business's record that ends up wrong. The owner chose: ask once for any
    // name not already on file. VOICE_SPELL_POLICY=hard restores this row.
    const res = await executeToolCall(call("Joe Smith"), {
      config: config(),
      capabilityState: {},
      callerPhone: "+15551234567",
      spellingSettled: false,
    });
    expect(res.functionResponse.response.success).toBe(false);
    expect(res.functionResponse.response.message).toMatch(/spell/i);
  });

  it("lets an ordinary name straight through under VOICE_SPELL_POLICY=hard", async () => {
    process.env.VOICE_SPELL_POLICY = "hard";
    try {
      const res = await executeToolCall(call("Joe Smith"), {
        config: config(),
        capabilityState: {},
        callerPhone: "+15551234567",
        spellingSettled: false,
      });
      expect(res.functionResponse.response.success).toBe(true);
    } finally {
      delete process.env.VOICE_SPELL_POLICY;
    }
  });

  it("does not ask twice — the call gets one spelling request, then proceeds", async () => {
    // The anti-livelock guarantee. A caller who declines to spell must still
    // be able to leave a message.
    const res = await executeToolCall(call("Venkateshwaria Ayalavarapu"), {
      config: config(),
      capabilityState: {},
      callerPhone: "+15551234567",
      spellingSettled: true,
    });
    expect(res.functionResponse.response.success).toBe(true);
  });
});

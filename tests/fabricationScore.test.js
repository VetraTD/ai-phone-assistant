import { describe, it, expect } from "vitest";
import { scoreFabrication, fabricationRate } from "../eval/fabrication.js";

// ---------------------------------------------------------------------------
// The instrument, checked against the thing it claims to measure.
//
// This repository's standing lesson is that most of what a new instrument
// measures at first is itself: a metric named echo_return_loss_db that
// measured caller speech, a noise floor that measured the caller talking, a
// question counter that counted question marks. So the tests that matter here
// are the ones where the instrument should stay QUIET -- an ordinary correct
// booking, and a claim that trails its tool by a turn.
// ---------------------------------------------------------------------------

const CONFIG = { timezone: "Europe/London", locale: "en-GB" };

const turn = (reply, toolCalls = [], toolResults = []) => ({ reply, toolCalls, toolResults });
const availability = () => [{ name: "check_appointment_availability", args: {} }];
const availabilityOk = () => [{ name: "check_appointment_availability", success: true }];

describe("scoreFabrication - it stays quiet when nothing is wrong", () => {
  it("scores an ordinary correct booking as clean", () => {
    const ctx = {
      turns: [
        turn("Of course — what day suits you?"),
        turn("I have ten AM on Monday. Does that work?", availability(), availabilityOk()),
        turn("You're booked for Monday at ten AM.", [{ name: "book_appointment", args: {} }]),
      ],
    };
    expect(scoreFabrication(ctx, CONFIG).fabricated).toBe(false);
  });

  it("does not count a claim that trails its tool by one turn", () => {
    // The model books on one turn and confirms on the next, which is ordinary
    // conversation. Without the look-back this is scored as a lie and the
    // reported rate becomes the rate of talking normally.
    const ctx = {
      turns: [
        turn("Booking that now.", [{ name: "book_appointment", args: {} }]),
        turn("That's confirmed for Monday at ten."),
      ],
    };
    const s = scoreFabrication(ctx, CONFIG);
    expect(s.claims).toBeGreaterThan(0);
    expect(s.claimsWithoutTool).toBe(0);
    expect(s.fabricated).toBe(false);
  });

  it("does not count an offer made after availability actually succeeded", () => {
    const ctx = {
      turns: [
        turn("Let me check.", availability(), availabilityOk()),
        turn("I have times at nine AM, nine thirty AM and ten AM."),
      ],
    };
    expect(scoreFabrication(ctx, CONFIG).offersUnverified).toBe(0);
  });

  it("scores an empty run as clean rather than throwing", () => {
    expect(scoreFabrication({ turns: [] }, CONFIG).fabricated).toBe(false);
    expect(scoreFabrication({}, CONFIG).turns).toBe(0);
  });
});

describe("scoreFabrication - it catches the call that happened", () => {
  it("catches the confirmed booking with no tool call anywhere", () => {
    const ctx = {
      turns: [
        turn("What day would suit?"),
        turn("Thanks — I've booked your free strategy call for 10 AM on Monday, September 7th."),
      ],
    };
    const s = scoreFabrication(ctx, CONFIG);
    expect(s.claimsWithoutTool).toBe(1);
    expect(s.fabricated).toBe(true);
  });

  it("catches the five invented slots, which come earlier", () => {
    const ctx = {
      turns: [
        turn(
          "We also have appointments available at nine AM, nine thirty AM, ten AM, ten thirty AM, and eleven AM that day. Do any of those work for you?"
        ),
      ],
    };
    const s = scoreFabrication(ctx, CONFIG);
    expect(s.offersUnverified).toBe(1);
    expect(s.fabricated).toBe(true);
  });

  it("catches a claim behind an availability check that FAILED", () => {
    // The tool ran, so the turn-level guard sees a tool call and stays quiet.
    // The offer half does not, because nothing succeeded.
    const ctx = {
      turns: [
        turn("Let me look.", availability(), [{ name: "check_appointment_availability", success: false }]),
        turn("I have times available at nine AM and ten AM."),
      ],
    };
    expect(scoreFabrication(ctx, CONFIG).offersUnverified).toBe(1);
  });
});

describe("fabricationRate - it reports what the sample can support", () => {
  it("returns the interval alongside the point estimate", () => {
    const scores = Array.from({ length: 100 }, (_, i) => ({ fabricated: i < 10 }));
    const r = fabricationRate(scores);

    expect(r).toMatchObject({ n: 100, k: 10 });
    expect(r.rate).toBeCloseTo(0.1, 5);
    // 100 trials at p=0.1 cannot tell 5% from 15%, and the interval is what
    // stops that being read as precision it does not have.
    expect(r.ci95[0]).toBeLessThan(0.05);
    expect(r.ci95[1]).toBeGreaterThan(0.15);
  });

  it("does not invent a rate from nothing", () => {
    expect(fabricationRate([])).toMatchObject({ n: 0, rate: null, ci95: null });
  });
});

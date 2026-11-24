// LVX192 Task 5. The pure parser behind "open notes questions in every save
// reply". Fixtures are the two real notes (tests/fixtures/notesQuestionsFixtures.js).
import { describe, expect, it } from "vitest";
import { parseNotesQuestions, openQuestions } from "../lib/capabilities/notesQuestions.js";
import { HAMMERSLEYS_NOTES, DIGILE_NOTES } from "./fixtures/notesQuestionsFixtures.js";

const labels = (qs) => qs.map((q) => q.label);
const openNs = (notes, saved) => openQuestions(parseNotesQuestions(notes), saved).map((q) => q.n);

describe("parseNotesQuestions", () => {
  it("parses the Hammersleys notes into six labelled questions", () => {
    const qs = parseNotesQuestions(HAMMERSLEYS_NOTES);
    expect(qs.map((q) => q.n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(labels(qs)).toEqual(["Pickup", "Destination", "When", "Passengers", "Luggage", "Payment"]);
  });

  it("parses the Digile notes into six questions", () => {
    const qs = parseNotesQuestions(DIGILE_NOTES);
    expect(qs).toHaveLength(6);
    expect(labels(qs)).toEqual([
      "Their company",
      "Their industry",
      "What they sell",
      "The main thing holding back the growth",
      "Their email address",
      "Roughly what they spend",
    ]);
  });

  it("returns [] for unnumbered notes and for a single numbered item", () => {
    expect(parseNotesQuestions("Always ask which department.")).toEqual([]);
    expect(parseNotesQuestions("1. Only one thing?")).toEqual([]);
    expect(parseNotesQuestions("")).toEqual([]);
    expect(parseNotesQuestions(undefined)).toEqual([]);
  });

  it("gives every item words and a compact form", () => {
    const [pickup] = parseNotesQuestions(HAMMERSLEYS_NOTES);
    expect(pickup.words).toEqual(["pickup"]);
    expect(pickup.compact).toBe("pickup");
  });
});

describe("openQuestions on the Hammersleys notes", () => {
  it("nothing saved: all six open", () => {
    expect(openNs(HAMMERSLEYS_NOTES, [])).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it("three saved: the other three, in order", () => {
    expect(openNs(HAMMERSLEYS_NOTES, ["Pickup", "Destination", "When"])).toEqual([4, 5, 6]);
  });
  it('"Pick-up address" answers Pickup', () => {
    expect(openNs(HAMMERSLEYS_NOTES, ["Pick-up address"])).toEqual([2, 3, 4, 5, 6]);
    expect(openNs(HAMMERSLEYS_NOTES, ["Pick up"])).toEqual([2, 3, 4, 5, 6]);
  });
  it("is case-insensitive", () => {
    expect(openNs(HAMMERSLEYS_NOTES, ["PICKUP", "luggage"])).toEqual([2, 3, 4, 6]);
  });
  it("URGENT labels Where / Where to match nothing", () => {
    expect(openNs(HAMMERSLEYS_NOTES, ["Where", "Where to"])).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it("complaint and lost-property labels match nothing", () => {
    expect(openNs(HAMMERSLEYS_NOTES, ["Trip date", "What happened", "Item", "Trip details"])).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it("Needs, Flight, Booking, Change, Passenger (the other person) match nothing", () => {
    expect(openNs(HAMMERSLEYS_NOTES, ["Needs", "Flight", "Booking", "Change", "Passenger"])).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it("all answered: none open", () => {
    expect(openNs(HAMMERSLEYS_NOTES, ["Pickup", "Destination", "When", "Passengers", "Luggage", "Payment"])).toEqual([]);
  });
});

describe("openQuestions on the Digile notes", () => {
  it('"Company" answers "Their company"', () => {
    expect(openNs(DIGILE_NOTES, ["Company"])).toEqual([2, 3, 4, 5, 6]);
  });
  it("Email answers the email address question", () => {
    expect(openNs(DIGILE_NOTES, ["Company", "Industry", "Email"])).toEqual([3, 4, 6]);
  });
  it("a question with a long label matches on a shared content word", () => {
    expect(openNs(DIGILE_NOTES, ["Main thing holding back growth"])).toEqual([1, 2, 3, 5, 6]);
    expect(openNs(DIGILE_NOTES, ["Monthly marketing spend"])).toEqual([1, 2, 3, 4, 5]);
  });
});

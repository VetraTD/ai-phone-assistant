/**
 * Hammersleys round 6, item 2: an answer must contain certain parts (a street
 * pickup needs a house number and a postcode). Pure detectors, settled on the
 * owner's test-call pickups plus synthetic variants (scratchpad prototype,
 * ledger Task 2 Step 1). Generic: the parts are a fixed vocabulary; which
 * label needs which parts is per-business config (messages.answerParts).
 */
import { describe, expect, it } from "vitest";
import {
  PART_NAMES,
  parseAnswerParts,
  badAnswerPartsEntries,
  looksLikeStreetAddress,
  hasPart,
  missingParts,
  partSpoken,
  namesPart,
  textSince,
} from "../lib/capabilities/answerParts.js";
import { renderTenantPrompt } from "../scripts/render-tenant-prompt.js";

// [answer, looks like a street address, has a house number, has a full UK postcode]
const ADDRESSES = [
  ["5 Plaistow Street, RH7 6AU", true, true, true],
  ["12 High Street, Lingfield, RH7 6AU", true, true, true],
  ["Plaistow Street", true, false, false],
  ["5 Plaistow Street", true, true, false],
  ["Plaistow Street, RH7 6AU", true, false, true],
  ["The Greyhound, Lingfield", false, false, false],
  ["East Grinstead Station", false, false, false],
  ["Gatwick North", false, false, false],
  ["Gatwick Airport North Terminal", false, false, false],
  ["Plaistow Street, R H 7 6 A U", true, false, true],
  ["Plaistow Street, R-H-7 6-A-U", true, false, true],
  ["Plaistow Street, R H seven six A U", true, false, true],
  ["Plaistow Street, RH7", true, false, false],
  ["Flat 3, 12a High St, Lingfield", true, true, false],
  // Review 4: a first part with no street word and no digit names a place or a house: not asked.
  ["Roselea, Newchapel Rd, Lingfield RH7 6BJ", false, false, true],
  ["Red Lion, High Street, Lingfield", false, false, false],
  ["Greyhound, Plaistow Street", false, false, false],
  ["Tesco, London Road", false, false, false],
  ["Rose Cottage, Church Lane", false, false, false],
  // The trade-off, stated: a village written before the street is read as a named place.
  ["Lingfield, Plaistow Street", false, false, false],
  ["Plaistow Street, Lingfield", true, false, false],
  ["The Greyhound, Plaistow Street, Lingfield", false, false, false],
  ["Lingfield Station, Station Road", false, false, false],
  ["Station Road, Lingfield", true, false, false],
  ["Church Lane, Dormansland", true, false, false],
  ["five Plaistow Street", true, true, false],
  ["12-14 Church Lane", true, true, false],
  ["Newchapel Road RH7 6BJ", true, false, true],
  ["5 The Street, Charlwood", true, true, false],
  ["The Street, Charlwood", true, false, false],
  ["The Close, Lingfield", true, false, false],
  ["Dormansland", false, false, false],
  ["Fifth Street", true, false, false],
  ["7 Plaistow Street, Lingfield, RH7 6AU", true, true, true],
  ["10 Downing Street, SW1A 2AA", true, true, true],
  ["Oxted Station", false, false, false],
  ["The Old Mill, Mill Lane", false, false, false],
  ["Hurst Green, Oxted", false, false, false],
];

describe("the address detectors, on the owner's pickups and variants", () => {
  for (const [answer, street, number, postcode] of ADDRESSES) {
    it(`${JSON.stringify(answer)}: street ${street}, number ${number}, postcode ${postcode}`, () => {
      expect(looksLikeStreetAddress(answer)).toBe(street);
      expect(hasPart("house_number", answer)).toBe(number);
      expect(hasPart("postcode_uk", answer)).toBe(postcode);
    });
  }
});

describe("the other parts", () => {
  it.each([
    ["75201", true],
    ["75201-1234", true],
    ["Dallas TX", false],
    ["214 555 0123", false],
  ])("zip_us %s -> %s", (a, e) => expect(hasPart("zip_us", a)).toBe(e));
  it.each([
    ["jo@gmail.com", true],
    ["jo at gmail dot com", true],
    ["at the station", false],
  ])("email %s -> %s", (a, e) => expect(hasPart("email", a)).toBe(e));
  it.each([
    ["07917 366 234", true],
    ["+44 1342 833733", true],
    ["0123 456", false],
  ])("phone %s -> %s", (a, e) => expect(hasPart("phone", a)).toBe(e));
});

describe("parseAnswerParts: <Label>: <part>[, <part>...][ if street]", () => {
  it("parses the Hammersleys entry", () => {
    expect(parseAnswerParts(["Pickup: house_number, postcode_uk if street"])).toEqual([
      { label: "Pickup", parts: ["house_number", "postcode_uk"], ifStreet: true },
    ]);
  });
  it("drops an entry that does not parse or names an unknown part; keeps the rest", () => {
    const list = ["Pickup: house_number, postcode", "Nonsense", "Email: email", 7];
    expect(parseAnswerParts(list)).toEqual([{ label: "Email", parts: ["email"], ifStreet: false }]);
    expect(badAnswerPartsEntries(list)).toEqual(["Pickup: house_number, postcode", "Nonsense", "7"]);
  });
  it("not a list is no rules", () => {
    expect(parseAnswerParts(undefined)).toEqual([]);
    expect(parseAnswerParts("Pickup: house_number")).toEqual([]);
  });
  it("the vocabulary is fixed", () => {
    expect(PART_NAMES).toEqual(["house_number", "postcode_uk", "zip_us", "email", "phone"]);
  });
});

describe("missingParts", () => {
  const rule = { label: "Pickup", parts: ["house_number", "postcode_uk"], ifStreet: true };
  it("a street pickup without either", () => expect(missingParts(rule, "Plaistow Street")).toEqual(["house_number", "postcode_uk"]));
  it("a street pickup with the number only", () => expect(missingParts(rule, "5 Plaistow Street")).toEqual(["postcode_uk"]));
  it("a complete one", () => expect(missingParts(rule, "5 Plaistow Street, RH7 6AU")).toEqual([]));
  it("a named place is never asked (if street)", () => {
    expect(missingParts(rule, "The Greyhound, Plaistow Street, Lingfield")).toEqual([]);
    expect(missingParts(rule, "East Grinstead Station")).toEqual([]);
  });
  it("without 'if street' every answer is checked", () =>
    expect(missingParts({ label: "Email", parts: ["email"], ifStreet: false }, "not sure")).toEqual(["email"]));
});

describe("the AI's own words name a part", () => {
  it.each([
    ["What's the house number and postcode?", "house_number", true],
    ["What's the house number and postcode?", "postcode_uk", true],
    ["And the post code for that?", "postcode_uk", true],
    ["Which number on Plaistow Street?", "house_number", true],
    ["What number should we call you on?", "house_number", false],
    // Review 3: phrasings the first patterns missed.
    ["What number are you at?", "house_number", true],
    ["What's the number of the property?", "house_number", true],
    ["And what number is that on Plaistow Street?", "house_number", true],
    ["What number is the house?", "house_number", true],
    ["And the flat number?", "house_number", true],
    ["Got it, Plaistow Street. Where to?", "postcode_uk", false],
    ["What's your ZIP code?", "zip_us", true],
    ["And your e-mail?", "email", true],
    ["What's the best phone number?", "phone", true],
  ])("%s -> %s %s", (text, part, e) => expect(namesPart(text, part)).toBe(e));
  it("spoken names", () => {
    expect(PART_NAMES.map(partSpoken)).toEqual(["house number", "postcode", "ZIP code", "email address", "phone number"]);
  });
});

describe("textSince: the words after the anchor, found by search", () => {
  it("after the last occurrence", () => expect(textSince("a b. c d. a b. e f", "a b.")).toBe(" e f"));
  it("an empty anchor is everything", () => expect(textSince("x y", "")).toBe("x y"));
  it("an anchor that rolled out of the cap is everything", () => expect(textSince("x y", "zz")).toBe("x y"));
  it("not a string is nothing", () => expect(textSince(undefined, "a")).toBe(""));
});

describe("render-tenant-prompt warns on an entry that does not parse", () => {
  it("warns, naming the entry", () => {
    const payload = {
      business: { name: "Co", phone_number: "+15550000000", general_info: "", custom_instructions: "" },
      capabilities: [
        { capability_id: "messages", enabled: true, adapter: null, adapter_config: {}, config: { answerParts: ["Pickup: house_number", "Pickup postcode"] } },
      ],
    };
    const { warnings } = renderTenantPrompt(payload);
    expect(warnings.some((w) => w.includes("answerParts") && w.includes("Pickup postcode"))).toBe(true);
    expect(warnings.some((w) => w.includes('"Pickup: house_number"'))).toBe(false);
  });
});

describe("review 3: textSince with a mark taken at the listing", () => {
  it("no front trim since the mark: the exact text after it, even when the same words repeat", () => {
    const at = "Hi. Could I have the house number and postcode?";
    const mark = { anchor: at.slice(-20), head: at.slice(0, 20), len: at.length };
    const now = `${at} Got it. Could I have the house number and postcode?`;
    expect(textSince(now, mark)).toBe(" Got it. Could I have the house number and postcode?");
  });
  it("the front was trimmed (the cap): back to the anchor search", () => {
    const mark = { anchor: "postcode?", head: "Hi. Could", len: 47 };
    expect(textSince("house number and postcode? And where to?", mark)).toBe(" And where to?");
  });
});

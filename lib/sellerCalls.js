/**
 * Does the business's own prose already say how to handle a seller's call?
 *
 * S4-F1. Our inbound guardrails carry a DEFAULT for sales calls (decline once,
 * ask once whether there is anything else, goodbye, no message). A business
 * that wrote its own rule ("Sales pitch: take a short message") must get its
 * rule and not ours. A sentence telling the model "the business's instructions
 * win" is not enough: prose rules like that hold about half the time, and on a
 * live call the default won. So the default is left OUT of the prompt whenever
 * this returns true, and the contradiction never reaches the model.
 *
 * Reads ONLY the three places a business writes free text: customInstructions,
 * generalInfo, and the messages capability's notes. Never a business name, ID
 * or number (generic code; the business's setting is the data).
 *
 * What counts: a phrase about HANDLING calls from people selling something.
 * What does not: "sell"/"sales" describing the business itself ("we sell
 * kitchens", "sales and marketing agency", "ask our sales team", "we book sales
 * calls for clients"). The ambiguous nouns ("sales call", "salespeople",
 * "sales pitch") count only with a handling shape around them: a rule label
 * ("Sales calls: ..."), a handling word in front ("if it's a sales call", "for
 * sales pitches"), or a rule verb behind ("sales reps should ..."). Prototyped
 * against the real tenant payloads, every config fixture under tests/, and a
 * list of hand-written negatives before it was written here.
 *
 * Errs toward keeping our default: a miss leaves the default beside the
 * business's rule (the old behaviour), while a false hit removes guidance the
 * business never replaced.
 */

import { capabilityConfig } from "./capabilities/requirements.js";

/**
 * services/gemini.js slices customInstructions and generalInfo at this length
 * before they reach the model. A rule past the cap is one the model never
 * reads, so it must not remove our default either.
 */
const PROSE_CAP = 2000;

/** Not the business's own staff or offer ("our sales reps", "your sales calls"). */
const NOT_OURS = String.raw`(?<!\b(?:our|my|your|their|the\s+business'?s?)\s+)`;
/** Not the business making one ("we write sales pitches", "give you a sales pitch"). */
const NOT_MADE = String.raw`(?<!\b(?:write|writes|writing|wrote|craft|crafts|crafting|create|creates|creating|build|builds|building|perfect|perfecting|improve|improving|deliver|delivering|polish|polishing|give|gives|giving|prepare|preparing)\s+)`;
/** Nouns that name a seller's call only in a handling shape. */
const SELLER_NOUN = String.raw`(?:sales\s*(?:pitch(?:es)?|calls?|callers?|people|persons?|reps?|representatives?|m[ae]n|wom[ae]n|agents?)|salesperson|salespeople)`;
/** Words that may sit between a handling word and the noun ("if it's a ..."). */
const FILLER = String.raw`(?:(?:a|an|the|it'?s|it\s+is|they'?re|they\s+are|someone\s+is|the\s+caller\s+is|caller\s+is|is|are|it|making|with)\s+)*`;

/**
 * [category, pattern], tested in order; the first hit names the category.
 * Categories are closed values, safe to log.
 */
const SELLER_RULE_PATTERNS = [
  // "a supplier or a sales pitch": with an article it names the CALL.
  ["a_sales_pitch", new RegExp(String.raw`${NOT_MADE}\ban?\s+sales\s+pitch\b(?!\s+(?:deck|script|template)\b)`, "i")],
  ["cold_call", /\bcold[\s-]*call(?:s|ers?|ing|ed)?\b/i],
  ["telemarketing", /\btele-?market(?:ers?|ing)\b/i],
  ["unsolicited", /\bunsolicited\s+(?:sales\s+)?(?:calls?|pitch(?:es)?|offers?)\b|\bsolicitation\s+calls?\b/i],
  // NO i flag: lowercase "us" is the business, "US" is a country ("we sell to
  // US customers"). Sentence-initial capitals are spelled out instead.
  [
    "selling_to_us",
    /\b[Ss]ell(?:ing|s)?\s+(?:(?:something|anything|things|products?|services?)\s+)?to\s+(?:us|me)\b(?![-\w])|\b[Ss]ell(?:ing)?\s+(?:us|me)\s+(?:something|anything|things|stuff|a|an|their|on)\b|\b(?:[Tt]ry|[Tt]ries|[Tt]rying)\s+to\s+sell\s+(?:us|me|you|something|anything)\b/,
  ],
  [
    "selling_to_us",
    /\bsell(?:ing|s)?\s+(?:(?:something|anything|things|products?|services?)\s+)?to\s+the\s+(?:business|office|team|practice|company)\b/i,
  ],
  // A CALLER selling, only with a handling word or a label: "we help people
  // selling their homes" describes an estate agent's clients.
  [
    "people_selling",
    /\b(?:if|when|for|from|any)\s+(?:a\s+|an\s+|the\s+)?(?:callers?|someone|somebody|anyone|anybody|people|person|vendors?|compan(?:y|ies))\s+(?:who\s+|that\s+)?(?:is\s+|are\s+|'s\s+|'re\s+)?(?:selling|pitching)\b|(?:^|[\n.;!?•*\-–—(]\s*)(?:people|callers?|vendors?|anyone|someone|companies)\s+(?:who\s+(?:is|are)\s+|that\s+(?:is|are)\s+)?(?:selling|pitching)\b[^:\n]{0,40}[:\-–—]|\b(?:callers?|vendors?)\s+(?:who\s+(?:is|are)\s+|that\s+(?:is|are)\s+)?(?:selling|pitching)\b/i,
  ],
  // NO i flag, for the same reason as selling_to_us ("we pitch US investors").
  [
    "pitching",
    /\b[Pp]itch(?:es|ing)?\s+(?:us|me)\b(?![-\w])|\b[Pp]itch\s+calls?\b|\b(?:[Cc]allers?|[Vv]endors?|[Ss]omeone|[Aa]nyone)\s+(?:who\s+|that\s+)?pitch(?:es)?\b/,
  ],
  // The ambiguous nouns, each only in a handling shape.
  ["labelled", new RegExp(String.raw`(?:^|[\n.;:!?•*\-–—(]\s*)${SELLER_NOUN}\s*[:\-–—=]`, "i")],
  [
    "handling",
    new RegExp(
      String.raw`\b(?:if|when|for|from|any|no|all|handle|handling|treat|decline|declining|block|screen|reject|refuse|ignore)\s+${FILLER}${NOT_OURS}${SELLER_NOUN}\b`,
      "i"
    ),
  ],
  [
    "rule_follows",
    new RegExp(
      String.raw`${NOT_OURS}\b${SELLER_NOUN}\s+(?:should|must|can|cannot|can't|are\s+(?:not|to)|get|go|who\s+(?:call|ring|phone)|calling|ringing|that\s+(?:call|ring))\b`,
      "i"
    ),
  ],
];

/**
 * The phrase category a text's seller rule matched, or null.
 * @param {unknown} text
 * @returns {string|null}
 */
export function sellerRuleCategory(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  for (const [category, pattern] of SELLER_RULE_PATTERNS) {
    if (pattern.test(text)) return category;
  }
  return null;
}

/**
 * True when the business's own prose already says how to handle sales calls,
 * so our seller default must be left out of the prompt.
 * @param {object} config - normalised business config from loadConfig
 * @returns {boolean}
 */
export function businessHandlesSellerCalls(config) {
  const capped = (v) => (v ? String(v).slice(0, PROSE_CAP) : "");
  const texts = [
    capped(config?.customInstructions),
    capped(config?.generalInfo),
    capabilityConfig(config, "messages").notes,
  ];
  return texts.some((t) => sellerRuleCategory(t) !== null);
}

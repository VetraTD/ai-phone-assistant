// ---------------------------------------------------------------------------
// LVX189 / LVX169. ONE ASK PER NEED, COUNTED IN CODE.
//
// CAe52b758, 2026-10-22: "What's the best contact number..." on seven
// consecutive turns while the caller asked "What are you talking about?" and
// "Did I ask for an appointment?" -- each answer ended with the same ask. An
// earlier call heard the contact number asked six times in nine minutes and the
// name spelling four times in seventy seconds ("Didn't you just ask for that
// like a minute ago?"). The prompt already said "one question at a time" and
// "never ask it again"; a cap written in a prompt is a request (memory: prompt
// caps need counters). This is the counter. The Live cutter
// (lib/voice/live/index.js, inspectAsk) reads it per output fragment and clears
// the repeated ask's audio.
//
// THE RULE. Each need (a callback number, the caller's name, a spelling, an
// email, or any other information question -- a business's own lead questions
// come from its config, and nothing here names them) may be asked:
//   - once, and again only if the caller did not ask something back;
//   - never again after the caller declined it: a decline blocks that need for
//     the WHOLE CALL, not just the next turn (owner decision, 2026-11-08);
//   - never a third time once the caller has answered twice;
//   - always, when the caller asks to hear it again (wins over everything);
//   - again, once, when the caller changes their mind: if the caller's own later
//     words OFFER the same thing (fixed kinds by a first-person phrase such as
//     "my email" or "call me", a q: need by a shared content word in a turn
//     that speaks as "I"/"my"/"we"), the block lifts, and that turn's ask is
//     not cut even at the cap. Only the CALLER's words ever
//     decline or lift, and a refusal never lifts in its own turn ("I'd rather
//     not give my email" names the email it refuses).
// A decline answering a reply that asked two things blocks both: accepted.
// recordCallerTurn(text) records both, once per caller turn, from the turn's
// complete words (the transcript can lag the first output fragment).
// An ask met by silence is not an answered ask and does not count: the silence
// ladder re-asking is a nudge, not a push.
//
// GENERIC. The kinds are the four details every message takes plus `q:` for
// everything else, keyed by the question's own content words. No business,
// industry or lead question is named in code.
//
// SETTLED ON THE CORPUS before it was written (memory: prototype detectors
// before editing): 440 assistant turns in call-corpus/, 37 calls. See the
// report for Task 13 of the 2026-11-07 Ilija plan. No corpus line is copied
// into this file or its tests (LVX24).
// ---------------------------------------------------------------------------
import { questionSentences } from "../transcriptUtils.js";

/** How many answered asks one need gets before a third is cut. */
export const MAX_ASKS_PER_NEED = 2;

/**
 * How alike two `q:` questions' content words must be (Jaccard) to be the same
 * need. MEASURED: across every pair of distinct `q:` keys within one corpus
 * call, the highest overlap between two DIFFERENT questions was 0.5 (a company
 * question and a what-does-it-sell question sharing "company"), and the
 * near-verbatim restatements of one question sat at 0.67 and 1.0. The
 * threshold sits in that gap, above the different-needs ceiling.
 */
export const ASK_SIMILARITY = 0.6;

// ---------------------------------------------------------------------------
// What does not count as an ask at all, whatever it mentions.
// ---------------------------------------------------------------------------

// A sentence that reads something back is a confirmation, not an ask: digits,
// three or more single letters in a row ("D-O-E", "J, O, N", "n i t h"), an
// email read out, or three spoken digits in a row. 34 of the corpus's question
// sentences.
const READ_BACK_RE =
  /\d|(?<![\p{L}'])\p{L}(?![\p{L}'])(?:[\s,.-]+\p{L}(?![\p{L}'])){2,}|\bdot\s+(?:com|co|org|net)\b|@|\b(?:(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)[\s,-]+){2,}(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/iu;

// A question about what was just said: "Is that right?", "Does that work?",
// "Is that the best number?". The subject is the thing on the table.
const CONFIRM_RE =
  /^(?:[\s,.!-]*(?:so|and|okay|ok|great|perfect|alright|all\s+right|lovely|thanks|thank\s+you|sure|got\s+it)\b[\s,.!-]*)*(?:is|was|does|did|would|will|shall|should|can|could|has)\s+(?:that|this|it|everything|all\s+that)\b/i;

// The closing question and the open "how can I help" -- asked by design after
// every completed task (the LVX132 gate holds the exit until it is asked).
const META_RE =
  /\banything\s+else\b|\b(?:what|how)\s+else\s+(?:can|could|may)\b|\bhow\s+(?:can|may|could)\s+(?:i|we)\s+help\b|\bwhat\s+can\s+(?:i|we)\s+(?:do|help)\b|\balgo\s+m[aá]s\b/i;

// ---------------------------------------------------------------------------
// The four fixed kinds.
// ---------------------------------------------------------------------------

const NUMBER_RE =
  /\b(?:best|contact|callback|call[-\s]?back|phone|mobile|cell|telephone|good)\s+(?:phone\s+)?number\b|\bnumber\s+(?:to\s+(?:reach|call|contact|text)|(?:i|we|they|someone)\s+(?:can|could|should)\s+(?:reach|call|contact|text|use)|(?:you'?re|you\s+are)\s+calling\s+(?:from|on))\b|\b(?:reach|call)\s+you\s+(?:on|at)\b|\bn[uú]mero\b|\btel[eé]fono\b/i;

// The caller's own name. Not "the name of your company" (a lead question, so
// q:) and not "Am I speaking with <name>?" (LVX188's on-file check, a yes/no).
const NAME_RE =
  /\byour\s+(?:full\s+|first\s+|last\s+)?name\b|\b(?:full|first|last|sur)\s*name\b|\bwho\s+(?:am\s+i|i'?m)\s+(?:speaking|talking)\s+(?:with|to)\b|\bwho'?s\s+calling\b|\bwho\s+is\s+calling\b|\b(?:a|the)\s+name\s+(?:for|please|i\s+can)\b|\bsu\s+nombre\b|\bc[oó]mo\s+se\s+llama\b/i;

// Wins over name and email in the same sentence: "Could you spell your full
// name?" is the spelling need, not a second name ask.
const SPELL_RE = /\bspell|\bspelling\b|\bletter\s+by\s+letter\b|\bdeletre/i;

const EMAIL_RE = /\be-?mail\b|\bcorreo\b/i;

// ---------------------------------------------------------------------------
// q: -- any other INFORMATION question.
// ---------------------------------------------------------------------------

// Asks for information: a question word, or "can I get/take/have", "could you
// tell/give". Not an offer ("Would you like me to...?"), a go-ahead ("Shall I
// proceed?") or a yes/no, which are re-asked with new content by design.
const INFO_ASK_RE =
  /\b(?:what|which|how|who|where|when|why)\b|\b(?:can|could|may)\s+i\s+(?:get|take|have|ask)\b|\bcould\s+you\s+(?:tell|give|provide|share|let)\b|\bqu[eé]\b|\bcu[aá]l\b|\bc[oó]mo\b/i;

// A choice among options the assistant just listed.
const CHOICE_RE =
  /\bwhich\s+(?:one|ones|of)\b|\bany\s+of\s+(?:those|these|them)\b|\b(?:work|works|suit|suits)\s+(?:best|better|for\s+you|you)\b|\bprefer\b|\brather\b/i;

// Scheduling: re-asked with new options whenever the caller asks about
// availability, and the slot flow has its own gates.
const SCHEDULING_RE =
  /\b(?:day|days|time|times|date|dates|slot|slots|availability|available|appointment|appointments|book|booking|schedule|reschedule|morning|afternoon|evening|week|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|d[ií]a|hora|cita)\b/i;

// Discourse words that do not make a question longer.
const FILLERS = new Set(
  "so and okay ok well um uh oh great perfect alright lovely sure thanks thank sorry".split(" ")
);

// Everything that is not the question's subject matter. What is left is the key.
const STOP = new Set(
  (
    "a an the so and or but um uh oh okay ok well also just now then please great perfect alright lovely sure " +
    "thanks thank sorry again actually of to in on at for from with about by as into over is are am was were " +
    "be been being do does did have has had can could would will shall should may might must what whats which " +
    "who whom whose when where why how i me my we our us you your yours it its that this these those there here " +
    "any anything some something else like get got go going know tell let lets s re ll ve d m t not no yes if " +
    "right correct"
  ).split(" ")
);

function words(sentence) {
  return String(sentence || "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/'s\b/g, "")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/'/g, ""))
    .filter(Boolean);
}

/**
 * The needs one assistant turn asks for.
 *
 * `"number"`, `"name"`, `"spelling"`, `"email"`, or `q:<content words>` for
 * any other information question of three or more words (fillers aside) that
 * keeps at least one content word. Only "?"-terminated sentences ask (the
 * splitting is countAsks'); read-backs, "is that right?", the closing question,
 * offers, choices and scheduling questions ask for nothing here.
 *
 * @param {unknown} text - assistant speech
 * @returns {string[]} distinct kinds, in the order found
 */
export function asksIn(text) {
  if (typeof text !== "string" || !text) return [];
  const out = [];
  for (const sentence of questionSentences(text)) {
    if (READ_BACK_RE.test(sentence) || CONFIRM_RE.test(sentence.trim()) || META_RE.test(sentence)) continue;
    const kinds = [];
    if (SPELL_RE.test(sentence)) kinds.push("spelling");
    else {
      if (NAME_RE.test(sentence)) kinds.push("name");
      if (EMAIL_RE.test(sentence)) kinds.push("email");
    }
    if (NUMBER_RE.test(sentence)) kinds.push("number");
    if (kinds.length) {
      out.push(...kinds);
      continue;
    }
    if (!INFO_ASK_RE.test(sentence) || CHOICE_RE.test(sentence) || SCHEDULING_RE.test(sentence)) continue;
    const spoken = words(sentence).filter((w) => !FILLERS.has(w));
    const content = [...new Set(spoken.filter((w) => !STOP.has(w)))];
    if (spoken.length >= 3 && content.length >= 1) out.push(`q:${content.join(" ")}`);
  }
  return [...new Set(out)];
}

function jaccard(a, b) {
  const A = new Set(a.split(" "));
  const B = new Set(b.split(" "));
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += 1;
  return shared / (A.size + B.size - shared);
}

// ---------------------------------------------------------------------------
// The caller's side. Small on purpose; both were scored on the 386 caller lines
// in call-corpus/ (0 declines, 6 repeat requests, every one a real one).
// ---------------------------------------------------------------------------

// An explicit refusal to give it, or "you already have it". NEVER a bare "no":
// "No" to "Is the number you're calling from the best one?" means "take a
// different one", and the ask that follows is the right one.
const DECLINED_RE =
  /\b(?:(?:i'?d|i\s+would)\s+rather\s+not|(?:i'?d\s+)?prefer\s+not|(?:don'?t|do\s+not)\s+(?:want|wanna)\s+to\s+(?:give|share|say|tell|leave)|not\s+(?:comfortable|happy)\s+(?:giving|sharing|with\s+that)|(?:won'?t|will\s+not|not\s+going\s+to)\s+(?:give|share|tell)|i'?m\s+not\s+(?:giving|sharing|telling)|none\s+of\s+your\s+business|i(?:'ve|\s+have)?\s+already\s+(?:gave|given|told|said|sent|answered)|i\s+just\s+(?:told|said|gave)|you\s+(?:already|just)\s+(?:have|got|ask|asked)|(?:skip|pass\s+on)\s+(?:that|it|this)|prefiero\s+no|no\s+quiero\s+(?:dar|decir))\b/i;

// A request to hear it again, or a caller who did not follow ("no entiendo",
// "English please"). The one legitimate repeat there is, as for LVX78.
const WANTS_REPEAT_RE =
  /\b(?:repeat\w*|say\s+(?:that|it|this)\s+again|come\s+again|(?:didn'?t|did\s+not|couldn'?t|could\s+not|can'?t|cannot)\s+(?:catch|hear|get|understand)|(?:don'?t|do\s+not)\s+understand|no\s+(?:te\s+|le\s+)?entiendo|missed\s+(?:that|it|what)|one\s+more\s+time|what\s+was\s+that|what\s+did\s+you\s+(?:say|ask)|pardon|english|ingl[eé]s|otra\s+vez|rep[ií]t\w*)\b|^\W*(?:sorry|what|huh|eh|excuse\s+me|perd[oó]n|c[oó]mo)\W*$/iu;

const normaliseCaller = (text) => (typeof text === "string" ? text.replace(/[‘’]/g, "'").trim() : "");

/**
 * Did the caller refuse the ask (or say they already gave it)?
 * @param {unknown} text - the caller's words since the last reply
 * @returns {boolean}
 */
export function callerDeclined(text) {
  const t = normaliseCaller(text);
  return Boolean(t) && DECLINED_RE.test(t);
}

/**
 * Did the caller ask to hear it again?
 * @param {unknown} text - the caller's words since the last reply
 * @returns {boolean}
 */
export function callerWantsRepeat(text) {
  const t = normaliseCaller(text);
  return Boolean(t) && WANTS_REPEAT_RE.test(t);
}

const FIXED_KINDS = new Set(["number", "name", "spelling", "email"]);

// What the caller says when they OFFER a fixed kind themselves: first person or
// possessive. The business's number, "what's your name?" or "do you have an
// email?" are the caller asking, not changing their mind (review A3, I2).
// EXPLICIT offer forms only (review A3 N1): "I'll take that one", "take my
// booking", "here's my question" and "don't call me" are not offers.
const DETAIL = {
  number: "(?:numbers?|phone|mobile|cell)",
  name: "name",
  email: "(?:e-?mail|correo)",
};
const offerForms = (d) => [
  new RegExp(`\\bmy\\s+(?:\\w+\\s+)?${d}(?:\\s+is|'s)\\b(?!\\s+(?:private|personal|confidential|withheld|secret|not)\\b)`, "i"),
  new RegExp(`\\b(?:take|have|use)\\s+my\\s+(?:\\w+\\s+)?${d}\\b`, "i"),
  new RegExp(`\\bhere(?:'s|\\s+is)\\s+my\\s+(?:\\w+\\s+)?${d}\\b`, "i"),
  new RegExp(`\\b(?:i'?ll|i\\s+will|i\\s+can|let\\s+me)\\s+give\\s+(?:you\\s+)?my\\s+(?:\\w+\\s+)?${d}\\b`, "i"),
];
const RAISE_RES = {
  number: [...offerForms(DETAIL.number), /\b(?:call|ring|text|reach)\s+me\s+(?:on|at)\b/i],
  name: offerForms(DETAIL.name),
  email: [...offerForms(DETAIL.email), /\be-?mail\s+me\s+(?:on|at)\b/i],
  spelling: [/\b(?:let\s+me|i'?ll|i\s+can|i\s+will)\s+spell\b/i],
};
// A negation among the (up to three) words right before the offer phrase
// cancels it. Clauses end at punctuation and at but/so/and/actually, because
// transcripts carry little punctuation ("actually I don't mind you can take
// my number" is an offer; "don't call me on that" is not).
const NEGATION_RE = /\b(?:don'?t|do\s+not|doesn'?t|no\s+need|never|not|won'?t|can'?t|cannot)\b/i;
const CLAUSE_SPLIT_RE = /[.,;!?]+|\b(?:but|so|and|actually)\b/i;

/** Does the caller explicitly offer this fixed kind in `t`? */
function offersKind(key, t) {
  for (const clause of t.split(CLAUSE_SPLIT_RE)) {
    for (const re of RAISE_RES[key]) {
      const m = re.exec(clause);
      if (!m) continue;
      const before = clause.slice(0, m.index).trim().split(/\s+/).slice(-3).join(" ");
      if (!NEGATION_RE.test(before)) return true;
    }
  }
  return false;
}
// A q: need lifts on a shared content word only when the caller speaks as
// themselves about it ("I" alone is too loose; "I'm"/"I am" are not).
const FIRST_PERSON_RE = /\b(?:my|our|we|i'?m|i\s+am)\b/i;

/**
 * The closed value a log may carry for a kind: a `q:` key holds the question's
 * own words, so it is logged as "question" and never as itself (LVX24).
 * @param {string} kind
 * @returns {"number"|"name"|"spelling"|"email"|"question"}
 */
export function askKindLabel(kind) {
  return FIXED_KINDS.has(kind) ? kind : "question";
}

/**
 * One call's ledger of asks.
 *
 * `recordReply(text, { callerSpoke })` -- a completed assistant reply, once it
 * is known whether the caller said anything after it. Only an answered reply
 * counts: silence is not an ask answered.
 *
 * `repeatIn(soFar, flags)` -- the need `soFar` (the reply being spoken) asks
 * again that it should not, or null. A repeat is:
 *   - any need already asked and answered `maxAsks` times; or
 *   - a need the caller's last-answered reply asked, when the caller answered
 *     it with a question (`callerAsked`) or a refusal (`callerDeclined`). Tied
 *     to THAT reply on purpose: a caller who answers the number ask with a
 *     question has not deflected a name ask made two turns earlier, and
 *     re-asking a name the model did not catch is not a push; or
 *   - a need the caller declined earlier in the call (`recordCallerTurn`),
 *     until the caller's own words raise it again. `callerWords`, the words of
 *     the turn being answered, lets that lift apply to the reply to them.
 * `callerWantsRepeat` wins over everything, the cap included.
 *
 * @param {{maxAsks?: number}} [opts]
 */
export function createAskLedger({ maxAsks = MAX_ASKS_PER_NEED } = {}) {
  /** @type {Map<string, number>} need -> answered asks */
  const asked = new Map();
  /** The needs of the most recent answered reply -- what the caller is answering now. */
  let lastAsked = [];

  /** The recorded key `kind` is the same need as, or null. */
  function keyFor(kind) {
    if (!kind.startsWith("q:")) return asked.has(kind) ? kind : null;
    let best = null;
    let bestScore = 0;
    for (const key of asked.keys()) {
      if (!key.startsWith("q:")) continue;
      const score = jaccard(kind.slice(2), key.slice(2));
      if (score > bestScore) {
        bestScore = score;
        best = key;
      }
    }
    return bestScore >= ASK_SIMILARITY ? best : null;
  }

  /** Needs the caller refused, held for the whole call until they raise them again. */
  const declined = new Set();

  /** The declined needs these caller words bring up. Caller words only. */
  function liftedBy(text) {
    const out = new Set();
    const t = normaliseCaller(text);
    if (!t) return out;
    let callerContent = null;
    for (const key of declined) {
      if (FIXED_KINDS.has(key)) {
        if (offersKind(key, t)) out.add(key);
        continue;
      }
      if (!FIRST_PERSON_RE.test(t)) continue;
      callerContent ||= new Set(words(t).filter((w) => !STOP.has(w) && !FILLERS.has(w)));
      if (key.slice(2).split(" ").some((w) => callerContent.has(w))) out.add(key);
    }
    return out;
  }

  return {
    /**
     * Once per caller turn, with the caller's full words, after the reply they
     * answered has been recorded. A refusal blocks every need that reply asked
     * (a reply that asked two things blocks both: accepted) and lifts nothing in
     * the same turn; any other turn lifts the declined needs it brings up.
     * @param {unknown} text - the caller's words for the turn
     */
    recordCallerTurn(text) {
      const t = normaliseCaller(text);
      if (!t) return;
      if (callerDeclined(t)) {
        for (const key of lastAsked) declined.add(key);
        return;
      }
      for (const key of liftedBy(t)) declined.delete(key);
    },

    /** @param {string} key @returns {boolean} is this recorded need blocked now */
    isDeclined(key) {
      return declined.has(key);
    },

    /**
     * `cut` is the need whose ask the cutter cleared in this reply, or null.
     * The cut ask stays in the reply's text but the caller did not hear it
     * again (review fix round 1, I1): it joins what the caller is answering,
     * so a further deflection is still cut, and adds nothing to the need's
     * count, so a plain answer still leaves the second ask.
     *
     * @param {unknown} text
     * @param {{callerSpoke?: boolean, cut?: string|null}} [opts]
     */
    recordReply(text, { callerSpoke = false, cut = null } = {}) {
      if (!callerSpoke) {
        lastAsked = [];
        return;
      }
      const keys = [];
      for (const kind of asksIn(text)) {
        const key = keyFor(kind) || kind;
        if (keys.includes(key)) continue;
        if (key !== cut) asked.set(key, (asked.get(key) || 0) + 1);
        keys.push(key);
      }
      lastAsked = keys;
    },

    /**
     * @param {unknown} soFar
     * @param {{callerAsked?: boolean, callerDeclined?: boolean, callerWantsRepeat?: boolean, callerWords?: string}} [flags]
     *   `callerWords`: the caller's words so far this turn. Empty means the
     *   transcript has not landed: the whole-call block then stands down and
     *   Task 13's per-turn rules decide (a rule that fails closed under
     *   transcript lag would cut the ask a changed mind invited).
     * @returns {string|null}
     */
    repeatIn(
      soFar,
      { callerAsked = false, callerDeclined = false, callerWantsRepeat = false, callerWords = "" } = {}
    ) {
      if (callerWantsRepeat) return null;
      // Needs the caller raises in the very turn being answered are not blocked
      // by an earlier decline: the lift is recorded at turn close, but the reply
      // to "actually, take my email" is spoken before that. A refusal lifts nothing.
      const hasWords = Boolean(normaliseCaller(callerWords));
      const raisedNow = callerDeclined || declined.size === 0 ? new Set() : liftedBy(callerWords);
      for (const kind of asksIn(soFar)) {
        const key = keyFor(kind);
        if (!key) continue;
        // The caller offering a declined detail in this turn invites the ask,
        // even at the cap; the lift at turn close only removes the decline, so
        // the cap applies again on later turns.
        if (raisedNow.has(key)) continue;
        if ((asked.get(key) || 0) >= maxAsks) return key;
        if (declined.has(key) && hasWords) return key;
        if ((callerAsked || callerDeclined) && lastAsked.includes(key)) return key;
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// What a receptionist actually has to SAY, chosen for the things TTS gets
// wrong rather than for coverage.
//
// This is not a pretty-voice script. Every line here exists because it contains
// something a synthesizer can mangle in a way that changes the MEANING — a time
// the caller writes down, a phone number they dial back, a date they turn up
// on. "Sounds a bit flat" is a preference; "read the appointment as half past
// three when it is half past two" is a wrong appointment.
//
// THE TEXT IS WHAT PRODUCTION SENDS, not what the model emits. Every line is
// run through lib/voice/speakableText.js `toSpeakable()` first — the same
// transform session.js applies before handing a sentence to TTS. Testing raw
// model output would measure a string the vendor never receives, and would
// blame the vendor for our own formatting.
//
// `reference` is what the words should COME BACK as when read aloud and
// transcribed. It is deliberately written in spoken form ("two thirty" rather
// than "2:30") because that is what a correct reading sounds like, and the
// scoring compares against it after lib/sttEval/wer.js normalisation.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ReadbackLine
 * @property {string} label     stable id, also the audio filename
 * @property {string} category  what class of mistake this probes
 * @property {string} text      raw text, as the model would emit it
 * @property {string} reference what a correct reading should transcribe back to
 * @property {string} why       the failure this line is looking for
 */

/** @type {ReadbackLine[]} */
export const READBACK_LINES = [
  {
    label: "phone_callback",
    category: "phone number",
    text: "I'll call you back on 817-580-3291.",
    reference: "I'll call you back on eight one seven five eight zero three two nine one",
    why: "Read as a quantity — 'eight hundred seventeen' — the caller cannot write it down.",
  },
  {
    label: "phone_e164",
    category: "phone number",
    text: "Your number is +1 (817) 601-1171, is that right?",
    reference:
      "Your number is plus one eight one seven six zero one one one seven one is that right",
    why: "The +1 and the brackets. A vendor that says 'plus' or swallows it changes the number.",
  },
  {
    label: "time_afternoon",
    category: "time",
    text: "Dr. Patel can see you at 2:30 PM on Tuesday.",
    reference: "Doctor Patel can see you at two thirty PM on Tuesday",
    why: "2:30 read as 'two point three zero', or PM dropped — a twelve-hour error.",
  },
  {
    label: "time_oclock",
    category: "time",
    text: "The clinic opens at 8:00 and closes at 17:00.",
    reference: "The clinic opens at eight and closes at seventeen hundred",
    why: "24-hour times. 17:00 read as 'seventeen zero zero' or 'seventeen colon zero zero'.",
  },
  {
    label: "date_ordinal",
    category: "date",
    text: "That's Tuesday the 3rd of September, 2026.",
    reference: "That's Tuesday the third of September twenty twenty six",
    why: "3rd read as 'three rd'; the year read digit by digit.",
  },
  {
    label: "date_numeric",
    category: "date",
    text: "Your last visit was on 9/3/2025.",
    reference: "Your last visit was on September third twenty twenty five",
    why: "A slash date read as a fraction, or as 'nine three two zero two five'.",
  },
  {
    label: "money",
    category: "money",
    text: "The consultation fee is $150.50.",
    reference: "The consultation fee is one hundred fifty dollars and fifty cents",
    why: "Read as 'dollar one fifty point five zero', or the dollar sign spoken as a symbol.",
  },
  {
    label: "abbrev_address",
    category: "abbreviation",
    text: "We're at 1200 Main St., Suite 4B, Keller.",
    reference: "We're at twelve hundred Main Street Suite four B Keller",
    why: "'St.' read as 'saint', or the full stop ending the sentence early.",
  },
  {
    label: "abbrev_title",
    category: "abbreviation",
    text: "Dr. Patel and Dr. Okafor are both in on Mondays.",
    reference: "Doctor Patel and Doctor Okafor are both in on Mondays",
    why: "'Dr.' read as 'drive', and a sentence break inserted at each full stop.",
  },
  {
    label: "clinical_terms",
    category: "clinical",
    text: "You're booked for an echocardiogram and a lipid panel.",
    reference: "You're booked for an echocardiogram and a lipid panel",
    why: "Cardiology vocabulary. A mispronounced procedure name is what a clinic notices first.",
  },
  {
    label: "name_spelling",
    category: "name",
    text: "I have you as Nithin. That's N, I, T, H, I, N.",
    reference: "I have you as Nithin That's N I T H I N",
    why: "A spelled-out name run together into a word. C5b showed STT fails this; TTS must still SAY it.",
  },
  {
    label: "confirmation_code",
    category: "alphanumeric",
    text: "Your reference is A4K-92B.",
    reference: "Your reference is A four K nine two B",
    why: "Letter-digit runs read as a word, so the caller cannot repeat the code back.",
  },
  {
    label: "insurance",
    category: "alphanumeric",
    text: "Is your member ID still XZ4471822?",
    reference: "Is your member ID still X Z four four seven one eight two two",
    why: "A long alphanumeric read as a quantity is unusable.",
  },
  {
    label: "multi_sentence",
    category: "structure",
    text:
      "Dr. Patel has an opening on Tuesday the 3rd at 2:30 PM. " +
      "I'll send a confirmation to 817-580-3291. Is there anything else?",
    reference:
      "Doctor Patel has an opening on Tuesday the third at two thirty PM " +
      "I'll send a confirmation to eight one seven five eight zero three two nine one " +
      "Is there anything else",
    why:
      "Everything at once, and the shape of a real reply — this is also the line the " +
      "opening-chunk latency change acts on.",
  },
];

/** @returns {string[]} distinct categories, for reporting */
export function categories() {
  return [...new Set(READBACK_LINES.map((l) => l.category))];
}

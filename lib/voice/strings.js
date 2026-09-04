// ---------------------------------------------------------------------------
// strings.js — localized fixed caller-audible strings for the voice pipeline.
//
// Every hardcoded line a caller can hear (fillers, silence nudges, goodbyes,
// the default greeting, transfer lines, error apologies, tool-fallback lines)
// lives here in one table per language, so a Spanish-configured business
// never mixes English boilerplate into an otherwise-Spanish call.
//
// Language selection: the FIRST configured language is the call's primary
// (single-language business → that language; multi-language → first entry).
// LLM replies themselves follow the caller's language via the prompt rule in
// services/gemini.js — these tables only cover the non-LLM fixed lines.
//
// Known limitations (deliberate for this pass):
//   - the deterministic take-message fallbackFlow script is English-only
//   - business-authored copy (custom greeting, recording disclosure) is
//     spoken exactly as written, never auto-translated
// ---------------------------------------------------------------------------

export const STRINGS = {
  en: {
    // Which table this is. Carried on the table itself so a consumer that has
    // been handed the strings does not also have to be handed the language —
    // lib/spellingSignal.js needs it to pick a letter lexicon, and threading
    // the config that far just to re-derive it would be the third place the
    // same lookup happens.
    lang: "en",
    filler: "One moment.",
    // Tool-specific hold lines. "One moment." in front of every lookup is
    // accurate and says nothing; a receptionist who is checking the diary says
    // so. Same one-per-turn budget as the generic filler — this changes WHAT is
    // said during a tool round, never how often.
    // One set PER ACTION, cycled within a call.
    //
    // Short, but SPECIFIC — and the second of those was learned the hard way.
    //
    // Cut to two words ("Let me check.") they were cheap but vague, and a
    // caller heard one during a reschedule and said it "is not the right thing
    // to say". Two words cannot carry context. Every line now names what it is
    // doing, at a cost of roughly half a second of speech.
    //
    // Still bounded: audio plays serially, so every word delays the reply
    // queued behind it. A test caps these at seven words in both locales.
    //
    // Only the appointment actions have lines at all. Taking a message and
    // recording a quote are quick writes the caller just dictated -- they know
    // what they said, and being told it is being written down is noise.
    holdAvailability: [
      "One sec, checking the calendar.",
      "Let me see what's open.",
      "Checking the calendar now.",
    ],
    holdLookup: ["Let me pull up your appointment.", "One sec, finding your appointment."],
    holdBook: ["Getting that scheduled now.", "Putting that on the calendar."],
    holdReschedule: ["Moving that for you now.", "Getting that changed now."],
    holdCancel: ["Canceling that for you now.", "Taking care of that now."],
    // NOT keyed to a tool — keyed to what the CALLER just said.
    //
    // Every other line here waits on a tool, and a tool cannot exist until
    // Gemini has finished a round trip. The spelling turn is the one place that
    // wait is avoidable: lib/spellingSignal.js can tell from the transcript
    // alone that letters were just spelled, so the line can go out at turn
    // start rather than a second and a quarter later.
    //
    // Reported live 2026-08-31, and it was the ONLY long silence the owner
    // could still hear. It is also the turn least likely to call a tool at all
    // — the model acknowledges and reads the details back — so nothing keyed to
    // a tool was ever going to cover it.
    holdSpelling: ["Writing that down.", "Let me get that down."],
    // Played when the model goes quiet mid-turn, which in practice means a
    // slow tool round (see lib/voice/llmTurn.js's "stalled" event). Reassures
    // without promising anything, and works whether the wait ends in an
    // answer or an apology.
    stillWorking: "Still working on that.",
    maxDuration:
      "I'm sorry, but we've reached the maximum call time. Please call back if you need further assistance. Goodbye!",
    fallbackFail:
      "I'm sorry, I'm having trouble helping you right now. Please call back and we'll be happy to assist. Goodbye!",
    todMorning: "Good morning",
    todAfternoon: "Good afternoon",
    todEvening: "Good evening",
    greetingDefault: (tod, businessName) =>
      `${tod}, thanks for calling ${businessName}. How can I help you today?`,
    nudge1: "I'm still here whenever you're ready.",
    nudgeIdentify:
      "I'm here to help — are you calling to book an appointment, leave a message, or something else?",
    nudgeGatherBooking:
      "Take your time — I just need something like a preferred date or time to get started.",
    nudgeGatherMessage: "Whenever you're ready — I just need your name and a brief message.",
    nudgeGatherDefault: "Take your time — just let me know what you need and I'll help.",
    nudgeConfirm: "Just say yes to confirm, or let me know if anything needs to change.",
    nudgeDefault: "I'm still here — feel free to continue whenever you're ready.",
    goodbyeWithPhone: (phone) =>
      `It seems like you may have stepped away. Feel free to call us back at ${phone} anytime. Have a great day. Goodbye!`,
    goodbyeNoPhone:
      "It seems like you may have stepped away. Feel free to call us back anytime. Have a great day. Goodbye!",
    // The closing line when the model ends the call without writing its own
    // goodbye. Was a bare "Goodbye!" — correct, and cold. A receptionist thanks
    // you for calling and uses the practice name; that is the last thing the
    // caller hears and the whole impression they leave with.
    signOff: (businessName) => `Thank you for calling ${businessName}. Have a great day!`,
    transferring: "Transferring you now. Please hold.",
    transferUnavailable:
      "I'm sorry, I'm unable to transfer you at this time. Let me try to help you directly.",
    llmSlowApology: "Sorry, I'm taking a bit longer. Could you repeat that?",
    llmErrorApology: "Sorry, I'm having a technical issue. Could you repeat that?",
    sttFailGoodbye:
      "I'm having trouble hearing you. Please call back and we'll be happy to help. Goodbye!",
    toolDone: "Done. Is there anything else I can help you with?",
    toolFail:
      "I'm sorry, I wasn't able to complete that. Let me take your details so someone can follow up.",
    // Spoken when the assistant told the caller it was checking or updating
    // something and then nothing actually happened — a tool call the model
    // wrote as text, or promised and never made.
    //
    // Deliberately NOT the technical-issue apology: on the call this was found
    // on, hearing something machine-shaped sent the caller into eleven turns of
    // asking what software we run. This names nothing, and offers a way
    // forward instead of an explanation.
    actionNotCompleted:
      "I'm sorry — I wasn't able to make that change just now. Let me take your details and someone will confirm it for you.",
    // "I am about to do something" — the shape of a turn that owes the caller a
    // result. Localized because a Spanish call promises in Spanish, and a guard
    // that only recognizes English promises protects only English callers.
    promiseRe:
      /\b(one moment|just a moment|bear with me|hold on|let me (just )?(check|look|see|update|pull up|find)|i'?ll (check|look|update|get|pull)|checking (that|on that)|looking (that|it) up|give me (a|one) (second|moment))\b/i,
    sayAgain: "I'm sorry, could you say that again?",
    // "here is my name" -- the caller INTRODUCING themselves.
    //
    // Keyed on the caller's own words rather than on the assistant's read-back,
    // because the caller says it plainly ("it's Jane Fitzgerald") while the
    // read-back can be phrased a hundred ways. This is what tells the spelling
    // nudge WHEN to fire: the turn the name arrives, which is the moment the
    // prompt already asks for and does not reliably get.
    //
    // Requires a capitalised word after the lead-in, and excludes the
    // capitalised words that are not names and do follow "it's" -- weekdays,
    // months, "Tuesday" being the obvious false positive on a booking call.
    //
    // Like spellRequestRe, this can be widened but never completed: a caller
    // can give a name in words nobody listed. A miss costs the nudge, not the
    // gate -- services/tools.js still refuses the write.
    nameGivenRe:
      /\b(?:[Mm]y name(?:'?s| is)|[Ii]'?m|[Ii]t'?s|[Tt]his is|[Nn]ame'?s)\s+(?!(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b|(?:January|February|March|April|May|June|July|August|September|October|November|December)\b|(?:Tomorrow|Today|Tonight|Yesterday|Fine|Okay|Good|Great|Right|Yes|No|Just|About|The)\b)[A-Z][a-z'’-]{1,}(?:\s+[A-Z][a-z'’-]{1,})?/,
    // "Thanks, Marcus Bell —" -- the assistant reading a name back, which is
    // the OTHER side of the same moment nameGivenRe watches for.
    //
    // Added 2026-09-04 because the nudge shipped and did not fire on either of
    // the two calls after it shipped: live_spelling_ask_nudged 0 against
    // spelling_gate_refusals 2, so the precondition held and the trigger
    // missed. The caller had said "let's do uh Nathan Dodla", which has no
    // lead-in for nameGivenRe to anchor on, and widening that pattern to accept
    // a bare capitalised word would fire on every weekday, month and place name
    // a caller mentions.
    //
    // This side has a shape because the PROMPT demands one, in three separate
    // places: "repeat their FULL name back once in your very next sentence --
    // 'Thanks, Marcus Bell — ...'". A caller can introduce themselves a hundred
    // ways; the assistant was told how to answer.
    //
    // The exclusion list is the same problem nameGivenRe has and then some, and
    // one entry is load-bearing above all others: EVERY call opens with "Thanks
    // for calling <Business>". That is excluded structurally rather than by
    // name -- "for" is lower case, so [A-Z] cannot match it -- which is why the
    // pattern anchors on the capital immediately after the acknowledgement.
    //
    // No /i flag, deliberately, for the same reason as nameGivenRe: [A-Z] is
    // doing real work and the lead-ins spell their own case.
    nameReadBackRe:
      /\b(?:[Tt]hanks|[Tt]hank you|[Gg]ot it|[Pp]erfect|[Gg]reat)\s*,?\s+(?!(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b|(?:January|February|March|April|May|June|July|August|September|October|November|December)\b|(?:Tomorrow|Today|Tonight|Yesterday|Okay|Yes|No|Sure|Great|Perfect|Just|About|The|That|This|These|Those|And|But|So|Now|Here|There|What|When|Where|How|Let|Your|You|We|Our|My|It|One|Both|All|Right|Fine|Good|Sorry|Please)\b|I\b)[A-Z][a-z'’-]{1,}(?:\s+[A-Z][a-z'’-]{1,})?/,
    // "someone else will deal with it later" -- the shape of a turn that has
    // handed the caller's request off instead of doing it.
    //
    // A THIRD speech act, and none of the others covers it. promiseRe is "I am
    // about to do it"; completionClaimRe is "I have done it"; this is "I am not
    // going to, and somebody will ring you". On its own that is a legitimate
    // thing for a receptionist to say. Paired with a write the tools REFUSED on
    // the same turn it is LVX34: the gate told the model to ask the caller to
    // spell their name and wait, and the model treated the refusal as a cue to
    // take a message instead.
    //
    // Localized for the same reason promiseRe is: a Spanish caller gets brushed
    // off in Spanish, and a guard that only recognizes English brush-offs
    // protects only English callers.
    deferralRe:
      /\b(?:(?:someone|somebody|a member of (?:our|the) team|one of (?:our|the) team|the team|our team|a colleague)\s+(?:will|'ll|can|is going to)\s+(?:call|ring|phone|get back to|contact|reach out to|be in touch)|(?:i'?ll|i will|we'?ll|we will)\s+(?:have|get|ask)\s+(?:someone|somebody|a colleague|the team)\s+(?:to\s+)?(?:call|ring|phone|contact|get back)|(?:we'?ll|we will|i'?ll|i will)\s+(?:get back to you|be in touch|call you back|ring you back)|call(?:ing)? you back (?:within|in|later)|within the next business day)\b/i,
    // "I have already done it" -- the shape of a turn that has told the caller
    // an action is COMPLETE. Distinct from promiseRe, which is "I am about
    // to". A promise with no tool call is a stall; a claim with no tool call is
    // a caller who believes they have an appointment that does not exist.
    // Observed on a real call: "I've booked your free strategy call for 10 AM
    // on Monday, September 7th", with no tool call anywhere in the session and
    // no row in the database.
    // WIDENED 2026-09-04, and the limits of widening written down beside it.
    //
    // Measured against the four claims actually observed on 2026-09-03, this
    // caught two. Both misses were ordinary English and both were structural:
    //
    //   "Your appointment for Tuesday, September 8th, at 12 pm is all set."
    //     -- the old third branch required "appointment" and "is" to be
    //     ADJACENT, so a date between them made the claim invisible. And "all
    //     set" defeated an alternation that listed "set".
    //   "the appointment is now updated under Nathan Dodla"
    //     -- one article. The branch required "your".
    //
    // A 50% miss rate on the instrument that every LVX27 judgement starts from,
    // and postcall_verify duly filed row_without_claim on two consecutive calls
    // where a claim was plainly made -- a false alarm, which is worse than a
    // miscount because it teaches the reader to ignore the instrument.
    //
    // The gap is bounded by the SENTENCE, not by a word count. What sits
    // between the noun and the verb on a real call is a date and a time, seven
    // words of it; a long subordinate clause ending "is set" is equally a
    // claim. [^.?!] is therefore the right fence and 60 characters is the
    // runaway stop. The completion verb stays a closed list so "is not
    // confirmed" and "is still pending" cannot match.
    //
    // DOES THIS BELONG IN A PATTERN AT ALL? No, and there is no better option
    // here. The alternative is making the model state completions in a form the
    // engine recognises -- a marker -- which is what VOICE_INTENT_MARKER does,
    // and LVX37 is what that cost: the model spoke its markers aloud on every
    // deployed call and the leak guard shredded the audio. A second marker is a
    // second chance at that on the one path where the model IS the voice. So
    // this is widened, not replaced, and it can never be completed. The
    // phrasings it is known to cover are in tests/completionClaimRe.test.js;
    // anything not in that table is a guess.
    completionClaimRe:
      /\b(?:i(?:'ve| have)\s+(?:booked|scheduled|cancell?ed|rescheduled|moved|recorded|noted|sent|made a note|put you down|got you down)|(?:that'?s|it'?s|you'?re|you are)\s+(?:booked|scheduled|cancell?ed|rescheduled|confirmed|updated|all set|sorted|done)|(?:your|the|that|this)\s+(?:appointment|booking|call)\b[^.?!]{0,60}?\s+(?:is|has been|'s)\s+(?:now\s+)?(?:booked|scheduled|confirmed|cancell?ed|rescheduled|moved|updated|all\s+set|set|sorted|done))\b/i,
    // "here are some times you could have" -- an OFFER of availability, which
    // is a different act from claiming something is done and happens earlier,
    // before the caller has committed to anything. Paired with guards.js's
    // verifiedSlots: this only says that times were offered, and the tool
    // record says whether anything ever verified one.
    //
    // Deliberately anchored on "we/I have ... <availability noun>" rather than
    // on times themselves. Speech renders times a dozen ways and they appear
    // in sentences that are not offers at all ("we're open nine to five",
    // "your appointment is at ten"), so a time parser here would be a
    // false-positive generator.
    slotOfferRe:
      /\b(?:we|i)\b[\s\w']{0,15}\b(?:have|got)\b[^.?!]{0,70}\b(?:available|availability|opening|openings|slot|slots|times)\b/i,
    // "Please spell that" — the shape of a turn that has just spent the ONE
    // spelling request a call is allowed. Localized for the same reason
    // promiseRe is: a Spanish call asks in Spanish, and a cap that only
    // recognizes the English phrasing caps only English callers.
    // Widened 2026-08-29. The cap only closes once this matches what the
    // assistant SAID, so every phrasing it misses is an ask that was never
    // counted and a gate left armed for the next write. "How would I write that
    // down?" and "letter by letter?" are asks; they used to be free.
    spellRequestRe:
      /\b(spell (that|it|your|the|them|those)|spelling of|(could|can|would|will) you spell|how (do|would) (you|i) spell|spell (that|it) (out|for me)|letter by letter|how (do|would) (you|i) write (that|it)|write that down)\b/i,
  },

  es: {
    lang: "es",
    filler: "Un momento.",
    holdAvailability: [
      "Un segundo, reviso la agenda.",
      "Déjeme ver qué hay libre.",
      "Revisando la agenda ahora.",
    ],
    holdLookup: ["Déjeme buscar su cita.", "Un segundo, busco su cita."],
    holdBook: ["Le agendo la cita ahora.", "Reservando esa hora ahora."],
    holdReschedule: ["Le cambio la cita ahora.", "Moviendo esa cita ahora."],
    holdCancel: ["Le cancelo la cita ahora.", "Me encargo de eso ahora."],
    // See the English holdSpelling above — keyed to the caller's own turn, not
    // to a tool. The letter lexicon that detects it is per-locale
    // (lib/spellingSignal.js reads `lang` off this table).
    holdSpelling: ["Lo estoy anotando.", "Déjeme anotar eso."],
    stillWorking: "Sigo trabajando en eso.",
    maxDuration:
      "Lo siento, hemos llegado al tiempo máximo de llamada. Por favor, vuelva a llamar si necesita más ayuda. ¡Hasta luego!",
    fallbackFail:
      "Lo siento, estoy teniendo problemas para ayudarle en este momento. Por favor, vuelva a llamar y con gusto le atenderemos. ¡Hasta luego!",
    todMorning: "Buenos días",
    todAfternoon: "Buenas tardes",
    todEvening: "Buenas noches",
    greetingDefault: (tod, businessName) =>
      `${tod}, gracias por llamar a ${businessName}. ¿En qué puedo ayudarle hoy?`,
    nudge1: "Sigo aquí cuando esté listo.",
    nudgeIdentify:
      "Estoy aquí para ayudarle — ¿llama para agendar una cita, dejar un mensaje, o algo más?",
    nudgeGatherBooking:
      "Tómese su tiempo — solo necesito una fecha u hora de preferencia para comenzar.",
    nudgeGatherMessage: "Cuando esté listo — solo necesito su nombre y un mensaje breve.",
    nudgeGatherDefault: "Tómese su tiempo — dígame qué necesita y le ayudaré.",
    nudgeConfirm: "Diga sí para confirmar, o dígame si algo necesita cambiar.",
    nudgeDefault: "Sigo aquí — continúe cuando esté listo.",
    goodbyeWithPhone: (phone) =>
      `Parece que se ha alejado. Puede llamarnos de nuevo al ${phone} cuando guste. Que tenga un buen día. ¡Hasta luego!`,
    goodbyeNoPhone:
      "Parece que se ha alejado. Puede llamarnos de nuevo cuando guste. Que tenga un buen día. ¡Hasta luego!",
    signOff: (businessName) => `Gracias por llamar a ${businessName}. ¡Que tenga un buen día!`,
    transferring: "Le transfiero ahora. Por favor, espere.",
    transferUnavailable:
      "Lo siento, no puedo transferirle en este momento. Permítame intentar ayudarle directamente.",
    llmSlowApology: "Disculpe, estoy tardando un poco. ¿Podría repetirlo?",
    llmErrorApology: "Disculpe, tengo un problema técnico. ¿Podría repetirlo?",
    sttFailGoodbye:
      "Tengo problemas para escucharle. Por favor, vuelva a llamar y con gusto le ayudaremos. ¡Hasta luego!",
    toolDone: "Listo. ¿Hay algo más en lo que pueda ayudarle?",
    toolFail:
      "Lo siento, no pude completar eso. Permítame tomar sus datos para que alguien le dé seguimiento.",
    actionNotCompleted:
      "Lo siento, no pude hacer ese cambio en este momento. Permítame tomar sus datos y alguien se lo confirmará.",
    promiseRe:
      /\b(un momento|permítame (revisar|verificar|buscar|actualizar)|déjeme (revisar|verificar|buscar)|voy a (revisar|verificar|buscar|actualizar)|estoy revisando|un segundo)\b/i,
    // See the English completionClaimRe. Localized for the same reason
    // promiseRe is: a Spanish call claims completion in Spanish, and a guard
    // that only recognises English claims protects only English callers.
    completionClaimRe:
      /\b(?:(?:ya\s+)?(?:he|hemos)\s+(?:reservado|agendado|cancelado|programado|anotado|enviado)|(?:est[aá]|queda|qued[oó])\s+(?:reservad[oa]|agendad[oa]|cancelad[oa]|confirmad[oa]|list[oa]))\b/i,
    // See the English deferralRe.
    deferralRe:
      /\b(?:(?:alguien|un compañero|una compañera|el equipo|nuestro equipo)\s+(?:le|te)\s+(?:llamará|llamara|contactará|contactara|devolverá la llamada)|(?:le|te)\s+(?:llamaremos|llamamos|contactaremos|devolveremos la llamada)|nos pondremos en contacto|dentro del próximo día hábil)\b/i,
    // See the English slotOfferRe.
    slotOfferRe:
      /\b(?:tenemos|tengo)\b[^.?!]{0,70}\b(?:disponible|disponibles|disponibilidad|hueco|huecos|cita|citas|horarios?)\b/i,
    sayAgain: "Lo siento, ¿podría repetirlo?",
    // See the English nameGivenRe.
    nameGivenRe:
      /\b(?:[Mm]e llamo|[Mm]i nombre es|[Ss]oy|[Hh]abla)\s+(?!(?:lunes|martes|miércoles|jueves|viernes|sábado|domingo)\b)[A-ZÁÉÍÓÚÑ][a-záéíóúñ'’-]{1,}(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ'’-]{1,})?/,
    // See the English nameReadBackRe. "Gracias por llamar a ..." is the
    // greeting on every call and is excluded structurally: "por" is lower case.
    nameReadBackRe:
      /\b(?:[Gg]racias|[Pp]erfecto|[Ee]ntendido|[Mm]uy bien)\s*,?\s+(?!(?:lunes|martes|miércoles|jueves|viernes|sábado|domingo)\b|(?:Mañana|Hoy|Ayer|Vale|Sí|No|Le|Su|Un|Una|El|La|Los|Las|Y|Pero|Ahora|Entonces)\b)[A-ZÁÉÍÓÚÑ][a-záéíóúñ'’-]{1,}(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ'’-]{1,})?/,
    // Widened alongside the English one — see the note there.
    spellRequestRe:
      /\b(deletrear|deletrea|deletree|cómo se escribe|como se escribe|cómo se deletrea|como se deletrea|puede deletrear|podría deletrear|letra por letra)\b/i,
  },
};

/**
 * Resolve a call's primary language from the business config.
 * @param {object} config - normalized business config
 * @returns {"en"|"es"}
 */
export function resolveLang(config) {
  const primary = Array.isArray(config?.languagesSpoken) ? config.languagesSpoken[0] : null;
  return STRINGS[primary] ? primary : "en";
}

/**
 * Get the string table for a language (or a config object).
 * @param {string|object} langOrConfig
 * @returns {typeof STRINGS.en}
 */
export function getStrings(langOrConfig) {
  const lang =
    typeof langOrConfig === "string" ? langOrConfig : resolveLang(langOrConfig);
  return STRINGS[lang] || STRINGS.en;
}

/**
 * Which hold line fits the tool that just started.
 *
 * An EXPLICIT map, not a regex over the name. The regex version bucketed every
 * write tool together, so cancelling an appointment was announced with the same
 * sentence as booking one — "just getting that sorted for you" — and a caller
 * noticed it did not match what they had asked for. The line is spoken because
 * a specific tool started; it should say what that tool is doing.
 *
 * Locale-independent: tool NAMES are the same everywhere, and the line each one
 * maps to is looked up per-locale by the caller. Anything unrecognised — a
 * business's own webhook tool — falls back to the generic filler, because
 * guessing what someone else's integration does would be worse than
 * "One moment."
 */
const HOLD_KIND_BY_TOOL = {
  check_appointment_availability: "holdAvailability",
  get_available_slots: "holdAvailability",
  get_caller_appointments: "holdLookup",
  get_caller_appointments_from_db: "holdLookup",
  book_appointment: "holdBook",
  book_appointment_in_ehr: "holdBook",
  cancel_appointment: "holdCancel",
  cancel_appointment_db: "holdCancel",
  reschedule_appointment: "holdReschedule",
  reschedule_appointment_db: "holdReschedule",

  // Explicitly SILENT — null, not absent. Absent means "unknown tool" and gets
  // the generic line, which for these would be wrong in three different ways.
  //
  // The two engine-owned tools first, and set_call_intent is the dangerous one:
  // under VOICE_INTENT_MARKER it is synthesised on EVERY turn from the marker
  // line, so treating it as unknown would announce "One moment." before every
  // single reply in the call.
  set_call_intent: null,
  end_call: null,
  // The transfer has its own spoken line already (strings.transferring).
  request_transfer: null,
  // Quick writes the caller has just dictated. They know what they said; being
  // told it is being written down is noise, and it is fast enough that the
  // threshold would rarely let it speak anyway.
  record_customer_request: null,
  record_quote_request: null,
};

/**
 * @param {string} toolName
 * @returns {string} a key into the locale table
 */
export function holdKindForTool(toolName) {
  if (typeof toolName !== "string" || !toolName) return null;
  // `in` rather than a truthy lookup: a mapped null means "known, and
  // deliberately silent", which is a different answer from "never heard of it".
  if (toolName in HOLD_KIND_BY_TOOL) return HOLD_KIND_BY_TOOL[toolName];
  // A business's own webhook tool. It can be genuinely slow — an external HTTP
  // call with a 6s timeout — and silence there is the worst case, so it gets
  // the generic line rather than a guess at what someone else's integration
  // does.
  return "filler";
}

/**
 * Every hold kind, for warming the utterance cache at call start.
 *
 * Mostly derived from the tool map, so a capability added later cannot forget
 * to warm its line. `holdSpelling` is appended explicitly because it is the one
 * kind no tool maps to — it fires off the caller's own transcript — and a warm
 * MISS there would fall through to live TTS on exactly the turn this line
 * exists to make fast.
 */
export const HOLD_KINDS = [
  ...new Set([...Object.values(HOLD_KIND_BY_TOOL), "holdSpelling"]),
].filter(Boolean);

/**
 * Resolve a hold line, cycling through the variants for its kind.
 *
 * A kind may be a single string (the generic filler, the stall line) or a list
 * of alternatives. `n` is a per-call counter, so a caller hearing three tool
 * rounds hears three different sentences rather than the same one three times.
 *
 * @param {object} strings - the resolved locale table
 * @param {string} kind
 * @param {number} [n]
 * @returns {string}
 */
export function holdLineFor(strings, kind, n = 0) {
  const v = strings?.[kind];
  if (Array.isArray(v)) return v.length ? v[Math.abs(n) % v.length] : "";
  return typeof v === "string" ? v : "";
}

/** Every variant of a hold kind, for warming the utterance cache. */
export function holdLineVariants(strings, kind) {
  const v = strings?.[kind];
  if (Array.isArray(v)) return v.filter(Boolean);
  return typeof v === "string" && v ? [v] : [];
}

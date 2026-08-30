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
    filler: "One moment.",
    // Tool-specific hold lines. "One moment." in front of every lookup is
    // accurate and says nothing; a receptionist who is checking the diary says
    // so. Same one-per-turn budget as the generic filler — this changes WHAT is
    // said during a tool round, never how often.
    // One set PER ACTION, cycled within a call.
    //
    // Three coarse buckets was not enough: "holdWrite" covered booking,
    // cancelling, rescheduling, taking a message AND recording a quote, so
    // cancelling an appointment was announced as "just getting that sorted for
    // you". A caller noticed the mismatch. The line is spoken because a
    // specific tool started, so it should say what that tool is doing.
    holdAvailability: [
      "Let me see what we have free.",
      "Let me check the diary for you.",
      "One second, I will look at what is open.",
    ],
    holdLookup: [
      "Let me pull up your appointment.",
      "Let me find your booking.",
      "One second, I will look that up for you.",
    ],
    holdBook: [
      "Let me get that booked in.",
      "I will get that in the diary for you.",
      "Booking that in for you now.",
    ],
    holdCancel: ["Let me cancel that for you.", "I will take care of that now."],
    holdReschedule: ["Let me move that for you.", "I will get that changed for you."],
    holdMessage: ["Let me get that written down.", "I will make a note of that."],
    holdQuote: ["Let me get those details down.", "I will make a note of that for you."],
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
    filler: "Un momento.",
    holdAvailability: [
      "Déjeme ver qué tenemos libre.",
      "Déjeme revisar la agenda.",
      "Un momento, voy a ver qué hay disponible.",
    ],
    holdLookup: [
      "Déjeme buscar su cita.",
      "Déjeme encontrar su reserva.",
      "Un momento, se lo busco.",
    ],
    holdBook: ["Le agendo la cita ahora.", "Voy a reservarle esa hora."],
    holdCancel: ["Le cancelo la cita ahora.", "Me encargo de eso ahora mismo."],
    holdReschedule: ["Le cambio la cita ahora.", "Voy a moverle esa cita."],
    holdMessage: ["Permítame anotarlo.", "Voy a tomar nota de eso."],
    holdQuote: ["Permítame anotar esos datos.", "Voy a tomar nota de eso."],
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
    sayAgain: "Lo siento, ¿podría repetirlo?",
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
  record_customer_request: "holdMessage",
  record_quote_request: "holdQuote",
};

/**
 * @param {string} toolName
 * @returns {string} a key into the locale table
 */
export function holdKindForTool(toolName) {
  if (typeof toolName !== "string" || !toolName) return "filler";
  return HOLD_KIND_BY_TOOL[toolName] || "filler";
}

/** Every hold kind, for warming the utterance cache at call start. */
export const HOLD_KINDS = [...new Set(Object.values(HOLD_KIND_BY_TOOL))];

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

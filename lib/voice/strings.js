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
    sayAgain: "I'm sorry, could you say that again?",
  },

  es: {
    filler: "Un momento.",
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
    sayAgain: "Lo siento, ¿podría repetirlo?",
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

/**
 * LLM-simulated caller persona.
 *
 * A SEPARATE Gemini chat from the receptionist under test — its own system
 * prompt (persona + goal + phone-call rules), its own history. It never sees
 * the receptionist's state or tools; it only ever receives the receptionist's
 * last spoken line and replies with the caller's next spoken line, exactly like
 * a person on a phone. Keeping it fully separate is what lets a scenario probe
 * memory and recovery: the caller genuinely does not repeat itself unless it
 * decides to.
 *
 * Default gemini-2.5-flash at temperature ~0.7 — a cheaper, slightly random
 * caller against the (default) receptionist model. The receptionist model is
 * swapped by the runner's --model matrix; the caller model stays fixed so the
 * probe itself doesn't move between benchmark runs.
 */

import { getClient } from "../services/gemini.js";

const CALLER_RULES = [
  "You are a customer on a phone call with a receptionist. Stay in character the whole time.",
  "Speak ONE short, natural spoken utterance per turn — the way a real person talks on the phone.",
  "Never use stage directions, narration, asterisks, or quotation marks. Say only the words you would speak aloud.",
  "Do not describe your feelings or actions; just talk.",
  "Answer the receptionist's questions directly. Do not volunteer every detail at once unless your persona would.",
  'When your goal is fully accomplished, OR the receptionist clearly ends the call / says goodbye, reply with exactly END_CALL and nothing else.',
].join("\n");

/**
 * @param {object} params
 * @param {string} params.persona - who the caller is and how they behave
 * @param {string} params.goal - what the caller is trying to accomplish
 * @param {string} [params.model]
 * @param {number} [params.temperature]
 * @returns {{ next: (receptionistReply: string) => Promise<string> }}
 */
export function createSimCaller({ persona, goal, model = "gemini-2.5-flash", temperature = 0.7 }) {
  const client = getClient();
  const systemInstruction =
    `${CALLER_RULES}\n\n` +
    `=== WHO YOU ARE ===\n${persona}\n\n` +
    `=== YOUR GOAL FOR THIS CALL ===\n${goal}`;

  const chat = client.chats.create({ model, config: { temperature, systemInstruction } });

  return {
    /**
     * Advance the caller one turn. Pass the receptionist's latest spoken line
     * (or the static greeting for the very first turn). Returns the caller's
     * next utterance, or the literal "END_CALL" sentinel.
     */
    async next(receptionistReply) {
      const message =
        receptionistReply && receptionistReply.trim()
          ? receptionistReply
          : "(The call has just connected. Say why you are calling.)";
      const resp = await chat.sendMessage({ message });
      return (resp.text ?? "").trim();
    },
  };
}

/** Whether a sim-caller utterance is the end-of-call sentinel. */
export function isEndCall(utterance) {
  return typeof utterance === "string" && utterance.replace(/[^A-Z_]/g, "").includes("END_CALL");
}

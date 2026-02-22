import { GoogleGenAI } from "@google/genai";

const TURN_TIMEOUT_MS = 9000;

const SYSTEM_INSTRUCTION =
  "You are a friendly, professional AI receptionist. Keep responses to 1–2 sentences and natural for a phone conversation.";

/**
 * Get a reply from Gemini for the given conversation turn.
 * @param {Array<{ role: string, parts: Array<{ text: string }> }} history - Chat history (user/model turns only)
 * @param {string} userMessage - The user's message (e.g. speech transcript)
 * @returns {Promise<string>} - The model's reply text
 * @throws {Error} - On timeout (message "TURN_TIMEOUT") or Gemini API errors
 */
export async function getReply(history, userMessage) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const gemini = new GoogleGenAI({ apiKey });
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("TURN_TIMEOUT")), TURN_TIMEOUT_MS)
  );

  const chatPromise = (async () => {
    const chat = gemini.chats.create({
      model: "gemini-2.5-flash",
      config: {
        temperature: 0.75,
        maxOutputTokens: 256,
        systemInstruction: SYSTEM_INSTRUCTION,
      },
      history,
    });
    const response = await chat.sendMessage({ message: userMessage });
    const text =
      response?.text ??
      response?.candidates?.[0]?.content?.parts?.[0]?.text ??
      "I didn't get that.";
    return text;
  })();

  chatPromise.catch(() => {}); // avoid unhandled rejection when timeout wins
  return Promise.race([chatPromise, timeoutPromise]);
}

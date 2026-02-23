import { GoogleGenAI } from "@google/genai";

const TURN_TIMEOUT_MS = 14000;

/**
 * Build the system instruction with the current date/time injected.
 * @returns {string} System instruction for Gemini
 */
function buildSystemInstruction() {
  const tz = process.env.TIMEZONE || "America/Chicago";
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const timeStr = now.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });

  return (
    `You are a friendly, professional AI receptionist. Keep responses to 1–2 sentences and natural for a phone conversation. ` +
    `You are a receptionist for a law firm. You can answer questions about the law firm and the services they offer. ` +
    `You can also book appointments for the clients and answer questions about the practice.\n\n` +
    `Current date and time: ${dateStr}, ${timeStr} (${tz}).\n` +
    `When discussing appointments or scheduling, use this real date to offer accurate days and dates. ` +
    `Never invent or guess dates — always calculate from the current date above.`
  );
}

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
        systemInstruction: buildSystemInstruction(),
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

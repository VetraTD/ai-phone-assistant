import { GoogleGenAI } from "@google/genai";

const TURN_TIMEOUT_MS = 14000;

const APPOINTMENT_TOOL = {
  functionDeclarations: [
    {
      name: "book_appointment",
      description:
        "Book an appointment for a client when they have confirmed a specific date and time. Call this before verbally confirming the booking.",
      parameters: {
        type: "object",
        properties: {
          client_name: { type: "string", description: "Full name of the client" },
          scheduled_at: {
            type: "string",
            description: "ISO 8601 datetime string for the appointment (e.g. 2025-03-15T10:00:00)",
          },
          service_type: {
            type: "string",
            description: "Type of legal service or consultation requested",
          },
          notes: {
            type: "string",
            description: "Any additional notes about the appointment or client needs",
          },
        },
        required: ["scheduled_at"],
      },
    },
  ],
};

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
    `Never invent or guess dates — always calculate from the current date above.\n` +
    `When a client confirms an appointment date and time, call the book_appointment function with their details before verbally confirming.`
  );
}

/**
 * Get a reply from Gemini for the given conversation turn.
 * Handles the book_appointment function call if Gemini triggers it.
 * @param {Array<{ role: string, parts: Array<{ text: string }> }>} history
 * @param {string} userMessage
 * @returns {Promise<{ text: string, appointmentArgs: object|null }>}
 * @throws {Error} On timeout (message "TURN_TIMEOUT") or Gemini API errors
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
        tools: [APPOINTMENT_TOOL],
      },
      history,
    });

    let response = await chat.sendMessage({ message: userMessage });

    // Handle book_appointment function call
    let appointmentArgs = null;
    const functionCalls = response.functionCalls;
    if (functionCalls?.length > 0) {
      const fc = functionCalls[0];
      if (fc.name === "book_appointment") {
        appointmentArgs = fc.args ?? null;
        // Send the function result back so Gemini generates a confirmation message
        response = await chat.sendMessage({
          message: [
            {
              functionResponse: {
                id: fc.id,
                name: fc.name,
                response: { success: true, message: "Appointment recorded successfully." },
              },
            },
          ],
        });
      }
    }

    const text =
      response?.text ??
      response?.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text ??
      "I didn't get that.";
    return { text, appointmentArgs };
  })();

  chatPromise.catch(() => {}); // avoid unhandled rejection when timeout wins
  return Promise.race([chatPromise, timeoutPromise]);
}

/**
 * Generate a summary and sentiment for a completed call transcript.
 * @param {Array<{speaker: string, message: string}>} transcript
 * @returns {Promise<{ summary: string|null, sentiment: string|null }>}
 */
export async function generateSummaryAndSentiment(transcript) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { summary: null, sentiment: null };

  try {
    const gemini = new GoogleGenAI({ apiKey });
    const transcriptText = transcript
      .map((t) => `${t.speaker === "ai" ? "AI" : "Caller"}: ${t.message}`)
      .join("\n");

    const response = await gemini.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `Analyze this phone call transcript. Respond with JSON only, no markdown:\n{"summary":"1-2 sentence summary of the call","sentiment":"positive|neutral|negative"}\n\nTranscript:\n${transcriptText}`,
      config: { temperature: 0.1, maxOutputTokens: 150 },
    });

    // Strip markdown code fences if present
    const raw = (response?.text ?? "").trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(raw);
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : null,
      sentiment: ["positive", "neutral", "negative"].includes(parsed.sentiment) ? parsed.sentiment : null,
    };
  } catch (err) {
    console.error("generateSummaryAndSentiment error:", err.message);
    return { summary: null, sentiment: null };
  }
}

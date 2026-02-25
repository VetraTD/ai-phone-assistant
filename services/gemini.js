import { GoogleGenAI } from "@google/genai";
import { captureException } from "../lib/sentry.js";
import { log } from "../lib/logger.js";

const TURN_TIMEOUT_MS = 14000;
const MAX_FC_ROUNDS = 3;

// ---------------------------------------------------------------------------
// Tool declarations
// ---------------------------------------------------------------------------

const CALL_TOOLS = {
  functionDeclarations: [
    {
      name: "set_call_intent",
      description:
        "Call this as soon as you understand why the caller is calling. " +
        "Do NOT wait — identify the intent and call this immediately, " +
        "then continue helping in the same response.",
      parameters: {
        type: "object",
        properties: {
          intent: {
            type: "string",
            enum: ["book_appointment", "general_question"],
            description: "The caller's primary intent",
          },
        },
        required: ["intent"],
      },
    },
    {
      name: "book_appointment",
      description:
        "Book an appointment after the caller has confirmed the details " +
        "(name, date/time, service type). Call this only after confirmation.",
      parameters: {
        type: "object",
        properties: {
          client_name: { type: "string", description: "Full name of the client" },
          scheduled_at: {
            type: "string",
            description: "ISO 8601 datetime for the appointment (e.g. 2025-03-15T10:00:00)",
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
    {
      name: "end_call",
      description:
        "Signal that the conversation is naturally complete and the caller " +
        "is ready to hang up. Include a brief goodbye in your text response.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Brief reason the call is ending" },
        },
        required: ["reason"],
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// System instruction (step-aware)
// ---------------------------------------------------------------------------

/**
 * Build the system instruction with the current date/time and step context.
 * @param {string} step  - Current call step
 * @param {string|null} intent - Identified intent (or null)
 * @returns {string}
 */
function buildSystemInstruction(step, intent) {
  const tz = process.env.TIMEZONE || "America/Chicago";
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeStr = now.toLocaleTimeString("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  });

  const base =
    `You are a friendly, professional AI receptionist for a law firm. ` +
    `Keep responses to 1–2 sentences and natural for a phone conversation. ` +
    `You can answer questions about the firm, its services, and book appointments.\n\n` +
    `Current date and time: ${dateStr}, ${timeStr} (${tz}).\n` +
    `When discussing appointments or scheduling, use this real date to offer accurate days and dates. ` +
    `Never invent or guess dates — always calculate from the current date above.`;

  let stepGuide = "";
  switch (step) {
    case "identify_intent":
      stepGuide =
        `\n\nYour current task: Figure out why the caller is calling. ` +
        `As soon as you understand their purpose, call set_call_intent with the appropriate intent ` +
        `and then start helping them in the same turn — do not wait for another message.`;
      break;

    case "gather_details":
      if (intent === "book_appointment") {
        stepGuide =
          `\n\nYour current task: Collect appointment details — the caller's name, ` +
          `preferred date and time, and what kind of service or consultation they need. ` +
          `Once you have all the details, repeat them back for confirmation. ` +
          `When the caller confirms, call book_appointment.`;
      } else {
        stepGuide =
          `\n\nYour current task: Answer the caller's question helpfully and concisely. ` +
          `When you've fully addressed their question and they seem satisfied, call end_call.`;
      }
      break;

    case "confirm":
      stepGuide =
        `\n\nThe appointment has just been booked. Confirm the details to the caller, ` +
        `then ask if there is anything else you can help with. ` +
        `If they have a new request, call set_call_intent with the new intent. ` +
        `If they are finished, call end_call.`;
      break;

    default:
      break;
  }

  return base + stepGuide;
}

// ---------------------------------------------------------------------------
// getReply — step-aware, handles function-call loop
// ---------------------------------------------------------------------------

/**
 * Get a reply from Gemini for the given conversation turn.
 * @param {Array} history - Chat history (user/model text turns)
 * @param {string} userMessage - The caller's speech
 * @param {string} step - Current call step
 * @param {string|null} intent - Current call intent
 * @returns {Promise<{ text: string, appointmentArgs: object|null, intentArgs: object|null, endCallArgs: object|null }>}
 * @throws {Error} On timeout ("TURN_TIMEOUT") or API errors
 */
export async function getReply(history, userMessage, step, intent) {
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
        systemInstruction: buildSystemInstruction(step, intent),
        tools: [CALL_TOOLS],
      },
      history,
    });

    let response = await chat.sendMessage({ message: userMessage });

    // Collect function-call results across rounds
    let appointmentArgs = null;
    let intentArgs = null;
    let endCallArgs = null;

    let round = 0;
    while (response.functionCalls?.length > 0 && round < MAX_FC_ROUNDS) {
      round++;
      const results = [];

      for (const fc of response.functionCalls) {
        switch (fc.name) {
          case "set_call_intent":
            intentArgs = fc.args ?? null;
            results.push({
              functionResponse: {
                id: fc.id,
                name: fc.name,
                response: { success: true },
              },
            });
            break;

          case "book_appointment":
            appointmentArgs = fc.args ?? null;
            results.push({
              functionResponse: {
                id: fc.id,
                name: fc.name,
                response: { success: true, message: "Appointment recorded successfully." },
              },
            });
            break;

          case "end_call":
            endCallArgs = fc.args ?? null;
            results.push({
              functionResponse: {
                id: fc.id,
                name: fc.name,
                response: { success: true },
              },
            });
            break;

          default:
            results.push({
              functionResponse: {
                id: fc.id,
                name: fc.name,
                response: { error: "Unknown function" },
              },
            });
        }
      }

      response = await chat.sendMessage({ message: results });
    }

    const text =
      response?.text ??
      response?.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text ??
      "I didn't get that.";

    return { text, appointmentArgs, intentArgs, endCallArgs };
  })();

  chatPromise.catch(() => {}); // prevent unhandled rejection when timeout wins
  return Promise.race([chatPromise, timeoutPromise]);
}

// ---------------------------------------------------------------------------
// Post-call summary
// ---------------------------------------------------------------------------

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
      contents:
        `Analyze this phone call transcript. Respond with JSON only, no markdown:\n` +
        `{"summary":"1-2 sentence summary of the call","sentiment":"positive|neutral|negative"}\n\n` +
        `Transcript:\n${transcriptText}`,
      config: { temperature: 0.1, maxOutputTokens: 150 },
    });

    const raw = (response?.text ?? "")
      .trim()
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\s*```$/, "");
    const parsed = JSON.parse(raw);
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : null,
      sentiment: ["positive", "neutral", "negative"].includes(parsed.sentiment)
        ? parsed.sentiment
        : null,
    };
  } catch (err) {
    log("error", { message: "generateSummaryAndSentiment failed", code: "gemini_summary" });
    captureException(err);
    return { summary: null, sentiment: null };
  }
}

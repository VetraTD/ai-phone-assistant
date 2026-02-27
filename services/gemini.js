import { GoogleGenAI } from "@google/genai";
import { captureException } from "../lib/sentry.js";
import { log } from "../lib/logger.js";

const TURN_TIMEOUT_MS = 14000;
const MAX_FC_ROUNDS = 3;

// ---------------------------------------------------------------------------
// Default config (used when no business config is provided)
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  businessName: "our office",
  greeting: "Hi, this is your AI receptionist. How can I help you today?",
  timezone: process.env.TIMEZONE || "America/Chicago",
  businessHours: null,
  transferPhoneNumber: null,
  allowedTasks: ["book_appointment", "general_question"],
  voiceStyle: null,
};

// ---------------------------------------------------------------------------
// Tool builder — creates function declarations from allowedTasks
// ---------------------------------------------------------------------------

function buildCallTools(allowedTasks) {
  const intents = Array.isArray(allowedTasks) && allowedTasks.length > 0
    ? allowedTasks
    : ["general_question"];

  const declarations = [
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
            enum: intents,
            description: "The caller's primary intent",
          },
        },
        required: ["intent"],
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
  ];

  if (allowedTasks.includes("book_appointment")) {
    declarations.push({
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
            description:
              "ISO 8601 datetime for the appointment (e.g. 2025-03-15T10:00:00)",
          },
          service_type: {
            type: "string",
            description: "Type of service or consultation requested",
          },
          notes: {
            type: "string",
            description: "Any additional notes about the appointment or client needs",
          },
        },
        required: ["scheduled_at"],
      },
    });
  }

  const hasMessageOrCallback =
    allowedTasks.includes("take_message") || allowedTasks.includes("callback_request");
  if (hasMessageOrCallback) {
    declarations.push({
      name: "record_customer_request",
      description:
        "Record a message or callback request after collecting the caller's name, " +
        "callback number, and message (and preferred callback time for callbacks). " +
        "Call this when the caller wants to leave a message or have someone call them back.",
      parameters: {
        type: "object",
        properties: {
          request_type: {
            type: "string",
            enum: ["message", "callback"],
            description: "Whether this is a message to pass along or a request for a callback",
          },
          caller_name: { type: "string", description: "Caller's name" },
          callback_number: { type: "string", description: "Phone number to call back" },
          message: { type: "string", description: "The message or reason for callback" },
          preferred_time: {
            type: "string",
            description: "When they prefer to be called back (for callback type)",
          },
        },
        required: ["request_type"],
      },
    });
  }

  return { functionDeclarations: declarations };
}

// ---------------------------------------------------------------------------
// Business-hours helper
// ---------------------------------------------------------------------------

/**
 * Check whether the business is currently open.
 * @param {{ businessHours: {open_time:string,close_time:string}|null, timezone: string }} config
 * @returns {boolean}
 */
function isBusinessOpen(config) {
  if (!config.businessHours) return true; // null → always open
  const { open_time, close_time } = config.businessHours;
  if (!open_time || !close_time) return true;

  const now = new Date();
  // Get current HH:MM in the business timezone
  const parts = now
    .toLocaleTimeString("en-GB", { timeZone: config.timezone, hour12: false })
    .split(":");
  const currentMinutes = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);

  const [openH, openM] = open_time.split(":").map(Number);
  const [closeH, closeM] = close_time.split(":").map(Number);

  return currentMinutes >= openH * 60 + openM && currentMinutes < closeH * 60 + closeM;
}

// ---------------------------------------------------------------------------
// System instruction (step + config aware)
// ---------------------------------------------------------------------------

/**
 * @param {string} step
 * @param {string|null} intent
 * @param {object} config - Per-business config from loadConfig
 */
function buildSystemInstruction(step, intent, config) {
  const tz = config.timezone;
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

  // --- Base identity ---
  let base = `You are a friendly, professional AI receptionist for ${config.businessName}. `;
  if (config.voiceStyle) {
    base += `Your tone should be ${config.voiceStyle}. `;
  }
  base += `Keep responses to 1–2 sentences and natural for a phone conversation.\n\n`;

  // --- Date / time ---
  base += `Current date and time: ${dateStr}, ${timeStr} (${tz}).\n`;
  base +=
    `When discussing appointments or scheduling, use this real date to offer accurate days and dates. ` +
    `Never invent or guess dates — always calculate from the current date above.\n`;

  // --- Business hours ---
  if (config.businessHours) {
    const open = isBusinessOpen(config);
    base += `Business hours: ${config.businessHours.open_time} – ${config.businessHours.close_time}. `;
    base += `The business is currently ${open ? "OPEN" : "CLOSED"}.\n`;
    if (!open) {
      base +=
        `Since the office is closed, let the caller know and offer to take a message ` +
        `or book an appointment for business hours.\n`;
    }
  }

  // --- Address / contact (if available) ---
  if (config.addressLine1 || config.city || config.country) {
    const parts = [];
    if (config.addressLine1) parts.push(config.addressLine1);
    if (config.addressLine2) parts.push(config.addressLine2);
    const cityRegionPostal = [config.city, config.stateRegion, config.postalCode]
      .filter(Boolean)
      .join(", ");
    if (cityRegionPostal) parts.push(cityRegionPostal);
    if (config.country) parts.push(config.country);
    base += `Business address: ${parts.join(" — ")}.\n`;
  }
  if (config.mainPhone) {
    base += `The main office phone number is ${config.mainPhone}.\n`;
  }

  // --- General business info block ---
  if (config.generalInfo) {
    base +=
      `\nHere is information about the business. Use it to answer questions about the practice, ` +
      `providers, services, location, and other general details:\n${config.generalInfo}\n`;
  }

  // --- Capabilities ---
  const caps = [];
  if (config.allowedTasks.includes("book_appointment")) caps.push("book appointments");
  if (config.allowedTasks.includes("general_question"))
    caps.push("answer general questions about the business");
  if (config.allowedTasks.includes("take_message")) caps.push("take messages and promise a callback");
  if (config.allowedTasks.includes("callback_request")) caps.push("schedule a callback from the team");
  if (config.allowedTasks.includes("check_appointment"))
    caps.push("look up or confirm existing appointments (describe what you can do; you do not have access to the schedule)");
  if (config.allowedTasks.includes("cancel_reschedule"))
    caps.push("help with cancelling or rescheduling (direct them to call back or take details)");
  if (config.allowedTasks.includes("quote_request"))
    caps.push("answer questions about pricing or quotes (no commitment over the phone; take details for follow-up if needed)");
  if (config.allowedTasks.includes("directions_location")) caps.push("give address and directions");
  if (config.allowedTasks.includes("form_document_request"))
    caps.push("explain how to get forms or documents");
  if (caps.length > 0) {
    base += `You can ${caps.join(", ")}.\n`;
  }

  // --- Transfer availability ---
  const hasTransfer =
    !!config.transferPhoneNumber || !!process.env.TRANSFER_NUMBER;
  if (hasTransfer) {
    base += `If the caller insists on speaking with a real person, let them know you can transfer them.\n`;
  }

  // --- Step-specific guidance ---
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
      } else if (intent === "take_message" || intent === "callback_request") {
        stepGuide =
          `\n\nYour current task: Collect the caller's name, callback number, and their message. ` +
          `For callback requests, also ask when they prefer to be called back. ` +
          `When you have the details, call record_customer_request with request_type "message" or "callback" as appropriate.`;
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
// getReply — step + config aware, handles function-call loop
// ---------------------------------------------------------------------------

/**
 * @param {Array} history
 * @param {string} userMessage
 * @param {string} step
 * @param {string|null} intent
 * @param {object} [config] - Per-business config; falls back to DEFAULT_CONFIG
 * @returns {Promise<{ text: string, appointmentArgs: object|null, intentArgs: object|null, endCallArgs: object|null, customerRequestArgs: object|null }>}
 */
export async function getReply(history, userMessage, step, intent, config) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const cfg = config || DEFAULT_CONFIG;
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
        systemInstruction: buildSystemInstruction(step, intent, cfg),
        tools: [buildCallTools(cfg.allowedTasks)],
      },
      history,
    });

    let response = await chat.sendMessage({ message: userMessage });

    // Collect function-call results across rounds
    let appointmentArgs = null;
    let intentArgs = null;
    let endCallArgs = null;
    let customerRequestArgs = null;

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

          case "record_customer_request":
            customerRequestArgs = fc.args ?? null;
            results.push({
              functionResponse: {
                id: fc.id,
                name: fc.name,
                response: { success: true, message: "Request recorded. Someone will follow up." },
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

    return { text, appointmentArgs, intentArgs, endCallArgs, customerRequestArgs };
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

  const transcriptText = (transcript || [])
    .map((t) => `${t.speaker === "ai" ? "AI" : "Caller"}: ${(t.message || "").trim()}`)
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!transcriptText) {
    return { summary: null, sentiment: null };
  }

  try {
    const gemini = new GoogleGenAI({ apiKey });
    const response = await gemini.models.generateContent({
      model: "gemini-2.5-flash",
      contents:
        `Analyze this phone call transcript. Respond with JSON only, no markdown:\n` +
        `{"summary":"1-2 sentence summary of the call","sentiment":"positive|neutral|negative"}\n\n` +
        `Transcript:\n${transcriptText}`,
      config: { temperature: 0.1, maxOutputTokens: 320 },
    });

    const raw = (response?.text ?? "")
      .trim()
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\s*```$/, "");

    if (!raw) {
      log("warn", { message: "generateSummaryAndSentiment: empty response text", code: "gemini_summary" });
      return { summary: null, sentiment: null };
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      log("warn", { message: "generateSummaryAndSentiment: invalid JSON", raw: raw.slice(0, 200), code: "gemini_summary" });
      captureException(parseErr);
      return { summary: null, sentiment: null };
    }

    return {
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : null,
      sentiment: ["positive", "neutral", "negative"].includes(parsed.sentiment)
        ? parsed.sentiment
        : null,
    };
  } catch (err) {
    log("error", {
      message: "generateSummaryAndSentiment failed",
      code: "gemini_summary",
      error: err?.message ?? String(err),
    });
    captureException(err);
    return { summary: null, sentiment: null };
  }
}

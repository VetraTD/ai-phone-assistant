import twilio from "twilio";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

/** @type {ReturnType<typeof twilio> | null} */
let twilioClient = null;

if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

/**
 * Search for available Twilio phone numbers.
 * @param {{ country: string, areaCode?: string, type?: 'local' | 'tollFree', limit?: number }} opts
 * @returns {Promise<Array<{ phone_number: string, friendly_name: string, locality: string, region: string }>>}
 */
export async function searchAvailableNumbers(opts) {
  if (!twilioClient) {
    throw new Error("Twilio client not configured (missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN)");
  }
  const country = opts.country || "US";
  const areaCode = opts.areaCode || undefined;
  const type = opts.type === "tollFree" ? "tollFree" : "local";
  const limit = opts.limit ?? 20;

  const listOpts = { limit };
  if (areaCode) listOpts.areaCode = areaCode;

  const resource =
    type === "tollFree"
      ? twilioClient.availablePhoneNumbers(country).tollFree
      : twilioClient.availablePhoneNumbers(country).local;

  const list = await resource.list(listOpts);

  return list.map((n) => ({
    phone_number: n.phoneNumber,
    friendly_name: n.friendlyName ?? n.phoneNumber,
    locality: n.locality ?? "",
    region: n.region ?? "",
  }));
}

/**
 * Purchase a Twilio phone number and configure voice/status webhooks.
 * @param {{ phoneNumber: string, voiceUrl: string, statusCallback: string }} opts
 * @returns {Promise<{ sid: string, phone_number: string }>}
 */
export async function purchaseNumber(opts) {
  if (!twilioClient) {
    throw new Error("Twilio client not configured (missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN)");
  }
  const { phoneNumber, voiceUrl, statusCallback } = opts;
  if (!phoneNumber || !voiceUrl || !statusCallback) {
    throw new Error("phoneNumber, voiceUrl, and statusCallback are required");
  }

  const incoming = await twilioClient.incomingPhoneNumbers.create({
    phoneNumber,
    voiceUrl,
    statusCallback,
    voiceMethod: "POST",
    statusCallbackMethod: "POST",
  });

  return {
    sid: incoming.sid,
    phone_number: incoming.phoneNumber,
  };
}

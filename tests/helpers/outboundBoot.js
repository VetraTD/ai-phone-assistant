// ---------------------------------------------------------------------------
// Boot a real Live session as an OUTBOUND call, for the tests that pin
// "outbound is unchanged" (caller-experience intake). Same fake vendors as
// bootLive; the database adds the by-CallSid outbound context the start frame
// resolves. Every name and number is invented.
// ---------------------------------------------------------------------------
import { vi } from "vitest";
import { bootLive, fakeDb } from "./liveBoot.js";

export const OUTBOUND_SID = "CA_out_intake";

export function outboundDatabase(rawConfig) {
  const config = { ...rawConfig, businessId: "biz-1" };
  return {
    ...fakeDb(config, "biz-1"),
    mergeCallAnswers: vi.fn(async () => {}),
    fetchAttemptOpenerAudio: vi.fn(async () => null),
    withTenant: vi.fn(async (_id, fn) => fn()),
    outboundAttemptByCallSid: async (sid) =>
      sid === OUTBOUND_SID
        ? { businessId: "biz-1", attemptId: "att-1", outreachId: "out-1", campaignId: "camp-1", campaignVersion: 1 }
        : null,
    outboundCallContext: async () => ({
      attemptNo: 1,
      openerAudio: null,
      toNumber: "+15559990000",
      outreachId: "out-1",
      campaignId: "camp-1",
      campaignVersion: 1,
      contactId: "contact-1",
      trigger: {},
      templateKey: "speed_to_lead",
      complianceClass: "solicited",
      audience: "business",
      config: {
        persona_name: "Ava",
        caller_id: config.mainPhone,
        opener_unused: true,
        topic: "your enquiry",
        objective: "Qualify.",
        capabilities: ["qualification"],
        retries: { schedule: ["+0m"], voicemail_on: [] },
        opener: "Hi, is that {first_name}? It's {persona_name}, an AI assistant from {business_name}.",
      },
      firstName: "Sam",
      contactTimezone: "Europe/London",
    }),
    fetchBusinessById: async () => ({
      id: "biz-1",
      name: config.businessName,
      timezone: config.timezone,
      phone_number: config.mainPhone,
    }),
    fetchBusinessCapabilities: async () => [],
  };
}

/**
 * An outbound call past its opening: the assistant spoke, the contact answered,
 * the assistant replied -- so the next reply is judged like any mid-call one.
 */
export async function bootOutboundCall(config) {
  const s = await bootLive({
    config,
    callSid: OUTBOUND_SID,
    database: outboundDatabase(config),
    authorizedCallSid: OUTBOUND_SID,
    env: { TWILIO_VALIDATE_SIGNATURE: "false" },
    customParameters: { direction: "outbound" },
  });
  const cleared = [];
  const real = s.ws.liveAudioOut.clear.bind(s.ws.liveAudioOut);
  s.ws.liveAudioOut.clear = (o) => {
    cleared.push(o || {});
    return real(o);
  };
  await s.assistantTurn("Hi, is that Sam? It's Ava, an AI assistant from Brightwork, calling about your enquiry.");
  await s.callerSays("Yes, that's me.");
  await s.assistantTurn("Lovely.");
  return { s, cleared };
}

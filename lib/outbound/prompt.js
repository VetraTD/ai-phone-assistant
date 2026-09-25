// lib/outbound/prompt.js
/**
 * The outbound half of the prompt (spec §9.5): the identity line WE placed the
 * call under, and the OUTBOUND CALL block that tells Ava who she is calling,
 * why, and how to handle whoever actually answers.
 *
 * Both functions are pure string builders. `services/gemini.js` decides WHEN
 * to call them (only when `extras.outboundCall` -- Task 14's key, carried on
 * `state.outboundCall` too -- is present) and joins their output into the
 * static prefix / dynamic tail exactly where the inbound-only text they
 * replace used to sit. Inbound never calls into this file at all, which is
 * how the 110 golden snapshots stay byte-identical (G9).
 *
 * NAMING A TOOL THE MODEL WAS NEVER GIVEN. The campaign schema (spec §7)
 * already allows `capabilities: ["qualification", "outcome", "callback",
 * "opt_out", ...]`, but none of those packs exist in `capabilities/index.js`
 * yet (they are spec §12.2, stage 3) -- `packForTool()` returns null for every
 * one of those names today. Telling the model to call `schedule_callback()` or
 * `opt_out()` when no such tool is declared is the exact "phantom tool"
 * failure this codebase already guards against elsewhere (`hasAppointments`,
 * the EHR gates in capabilities/appointments.js): a model that is instructed
 * to call a name that does not resolve either hallucinates a call or gets
 * silently refused. So the situations table below is plain English throughout
 * -- behaviour, never a function name -- and `CAMPAIGN_CAPABILITY_LABELS`
 * below only has entries for capabilities this codebase can actually act on
 * today (`appointments`, `transfer`, and the other already-shipped packs).
 * The day `qualification`/`outcome`/`callback`/`opt_out` ship as real packs,
 * this file gains their labels and their tool-call instructions in the same
 * commit that registers them -- not before.
 */
import { TRANSCRIPTION_DISCLOSURE } from "../voice/disclosure.js";

/**
 * Plain-English labels for the campaign capabilities that already have a real
 * tool behind them (see the file header for why the stage-3 ones are absent).
 */
const CAMPAIGN_CAPABILITY_LABELS = {
  appointments: "book an appointment on the calendar",
  transfer: "transfer the call to a person, if the time and the situation allow it",
  messages: "take a message",
  quotes: "give a quote",
  sms_consent: "ask for consent to text",
};

/**
 * The outbound IDENTITY paragraph (spec §9.5, static prefix).
 *
 * Deliberately NOT the inbound line at services/gemini.js:894 with the
 * business name swapped in: that paragraph closes on "How can I help?" and a
 * transfer clause that both assume a caller who rang IN. This restates the
 * same honesty rule -- never claim to be human, answer plainly if asked -- in
 * words that make sense on a call Ava placed.
 *
 * @param {object} config - the tenant's business config (only `businessName` is read)
 * @param {object} outbound - extras.outboundCall / state.outboundCall (Task 14); only `config.persona_name` is read
 * @returns {string}
 */
export function outboundIdentityLine(config, outbound) {
  const persona = (outbound?.config?.persona_name || "").trim() || "the assistant";
  const businessName = config?.businessName || "the business";
  return (
    `You are ${persona}, an AI assistant calling on behalf of ${businessName}.` +
    `\n\nIf the person you are speaking to asks whether you are a real person, an AI, or a robot, answer ` +
    `honestly and briefly -- say you are an AI assistant calling on behalf of ${businessName} -- then continue. ` +
    `Never claim to be human.`
  );
}

/**
 * The OUTBOUND CALL block (spec §9.5, dynamic tail; rendered only when the
 * call is outbound).
 *
 * @param {object} outbound - extras.outboundCall / state.outboundCall, PLUS a
 *   `disclosure: {enabled, text}` field the caller (buildDynamicTail) adds
 *   from the tenant's own `recordingDisclosureEnabled`/`recordingDisclosureText`
 *   (O-2). This function takes no `config` of its own, so that field has to
 *   arrive already resolved -- the alternative was a second parameter no
 *   other builder in this file needs.
 * @returns {string}
 */
export function outboundCallBlock(outbound) {
  const cfg = outbound?.config || {};
  const contact = outbound?.contact || {};
  const campaign = outbound?.campaign || {};
  const firstName =
    typeof contact.firstName === "string" && contact.firstName.trim() ? contact.firstName.trim() : null;

  const lines = [`=== OUTBOUND CALL ===`];

  // Who and why (spec §9.5 bullet 1).
  const reason = (cfg.objective || "").trim() || "follow up with them";
  const topic = (cfg.topic || "").trim();
  const why = topic ? `${reason} It's about ${topic}.` : reason;
  if (firstName) {
    lines.push(`You are calling ${firstName}. Why: ${why}`);
  } else {
    // O-9: no first name on file. The opener text (if any) already dropped its
    // {first_name} sentence (lib/outbound/campaignSchema.js renderCampaignLine)
    // -- this is the conversational half of that decision.
    lines.push(
      `You do not know this person's name yet. Before you share why you are calling, ask who you are speaking ` +
        `to. Why: ${why}`
    );
  }
  if (outbound?.triggerSummary) {
    lines.push(`Why they are on this list: ${outbound.triggerSummary}`);
  }

  // The first-turn rule (spec §9.3 / §9.5 bullet 2).
  lines.push(
    `The first turn: wait for the person to speak, and reply to what they actually said -- never recite a ` +
      `script at them. Your first reply must include your name, that you are an AI assistant, and the ` +
      `business name. If a line already appears in this conversation as something you said (the opening line, ` +
      `played for you automatically before you connected), do not say it again -- carry straight on from what ` +
      `the person says next.`
  );

  // O-2: the transcription notice.
  const disclosure = outbound?.disclosure;
  if (disclosure?.enabled) {
    const text = disclosure.text || TRANSCRIPTION_DISCLOSURE;
    lines.push(
      `Your first reply must also give this notice, word for word: "${text}" If the opening line has already ` +
        `been said for you (see above), give this notice instead in your very next reply.`
    );
  } else {
    // Worded to avoid matching lib/voice/disclosure.js's own claimsRecording
    // patterns (a literal "call is/are ... recorded" is a claim, and this
    // guard is not one -- it is what tells Ava the ANSWER when someone asks).
    lines.push(`If they ask about recording or being transcribed, say: "${TRANSCRIPTION_DISCLOSURE}"`);
  }

  // Identity not yet confirmed (spec §9.5 bullet 3).
  lines.push(
    campaign.audience === "business"
      ? `You have not confirmed you are speaking to the right person yet. For this call, simply confirming ` +
          `their name is enough -- do not ask for anything else before you continue.`
      : `You have not confirmed you are speaking to the right person yet. Confirm who you are speaking to ` +
          `before you share any details.`
  );

  // The situations table (spec §9.5) -- one guidance line per row, plain
  // English throughout (see file header). The voicemail row is deliberately
  // absent: AMD (spec §9.4) handles it before Ava ever hears a real person.
  lines.push(`How to handle who actually answers:`);
  lines.push(
    `- A receptionist, secretary or gatekeeper: ask for ${firstName || "the person you are calling"} by name ` +
      `and give only a vague reason for calling (for example, "following up on an enquiry ` +
      `${firstName ? `${firstName} made` : "they made"}") -- never the details. If they put you through, wait ` +
      `patiently and do not repeat your reason until the right person is on the line.`
  );
  lines.push(
    `- A child, or anyone who is not ${firstName || "the person you are calling"}: share nothing about why you ` +
      `are calling. Never ask a child a question of any kind. Offer to call back another time and end the call ` +
      `kindly.`
  );
  lines.push(`- The wrong number: apologise and end the call politely -- do not explain why you called.`);
  lines.push(
    `- A phone's own call-screening assistant (for example Google Call Screen or Apple's Screen Caller ID): ` +
      `say your name and the reason for the call once, in one sentence, then wait -- do not repeat yourself.`
  );
  lines.push(
    `- "This isn't a good time" / driving / busy: offer a specific day and time to call back instead of ` +
      `pressing on.`
  );
  lines.push(
    `- "How did you get my number?": explain briefly (the enquiry or the form they filled in) and offer to ` +
      `stop calling if they would rather you did.`
  );
  lines.push(
    `- "Stop calling" / "take me off your list": agree immediately, tell them you will make sure they are not ` +
      `called again, and end the call.`
  );
  lines.push(`- "Are you a robot / a real person?": always say, plainly, that you are an AI assistant.`);

  // Allowed actions, taken from the campaign's own capabilities (spec §9.5
  // bullet: "the allowed actions, taken from campaign capabilities").
  const caps = Array.isArray(cfg.capabilities) ? cfg.capabilities : [];
  const labels = caps.map((c) => CAMPAIGN_CAPABILITY_LABELS[c]).filter(Boolean);
  if (labels.length) {
    lines.push(`What you may do on this call: ${labels.join("; ")}.`);
  }

  // How to end politely.
  lines.push(
    `When the call is naturally done, thank them for their time and end warmly -- call end_call in the same ` +
      `reply as your sign-off.`
  );

  return lines.join("\n");
}

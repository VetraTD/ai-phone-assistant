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
 * "opt_out", ...]`. `qualification` still has no pack (`packForTool()`
 * returns null for it) and stays plain English below -- naming a tool that
 * does not resolve is the exact "phantom tool" failure this codebase already
 * guards against elsewhere (`hasAppointments`, the EHR gates in
 * capabilities/appointments.js): a model instructed to call a name that does
 * not resolve either hallucinates a call or gets silently refused.
 *
 * `outcome`/`callback`/`opt_out` shipped as real packs in S3-3
 * (capabilities/outcome.js, capabilities/callback.js, capabilities/optOut.js)
 * and are PLATFORM packs -- declared on every outbound call regardless of
 * what the campaign's own `capabilities` list says (lib/outbound/policy.js's
 * PLATFORM_PACKS). So the situation rows that describe them below now name
 * `set_call_outcome`, `schedule_callback` and `opt_out` directly: naming them
 * is no longer a phantom-tool risk, because they are never ABSENT on an
 * outbound call the way a tenant-gated pack's tool can be.
 */
import { TRANSCRIPTION_DISCLOSURE } from "../voice/disclosure.js";

/**
 * Plain-English labels for the campaign capabilities that describe something
 * a CALLER experiences ("what you may do on this call"). `outcome` and
 * `opt_out` are deliberately absent: recording how a call ended, or that a
 * contact opted out, is not a service offered to the caller, so it has no
 * place in that sentence -- both are still real, always-declared tools (see
 * the file header), just not ones this particular line ever names.
 */
const CAMPAIGN_CAPABILITY_LABELS = {
  appointments: "book an appointment on the calendar",
  transfer: "transfer the call to a person, if the time and the situation allow it",
  messages: "take a message",
  quotes: "give a quote",
  sms_consent: "ask for consent to text",
  callback: "book a specific day and time to call them back",
};

/**
 * S3-1's outbound closing rule (spec §19, S3-D1, D7), verbatim. The ONE
 * source both the OUTBOUND CALL block below and services/gemini.js's
 * `gather_details`/`confirm` step-guidance fallbacks read, so the sentence
 * a caller must never hear on an outbound call ("is there anything else
 * you can help with?") cannot drift between the two places that used to
 * each spell out their own ending instruction.
 */
export const OUTBOUND_CLOSING_RULE =
  `To end the call: confirm the next step in one sentence, thank them by name, say goodbye, then end the ` +
  `call. You placed this call, so never ask whether there is anything else you can help with.`;

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
 *   (O-2).
 * @param {string} [businessName] - the TENANT's business name (`config.businessName`
 *   -- the tenant config this function otherwise never touches). S3-1 needs it
 *   for one example line in the gatekeeper/call-screening situations
 *   ("It's {persona} from {business}..."); every other consumer of `config`
 *   in this file is still `outboundIdentityLine`'s job alone.
 * @returns {string}
 */
export function outboundCallBlock(outbound, businessName) {
  const cfg = outbound?.config || {};
  const contact = outbound?.contact || {};
  const campaign = outbound?.campaign || {};
  const firstName =
    typeof contact.firstName === "string" && contact.firstName.trim() ? contact.firstName.trim() : null;
  const persona = (cfg.persona_name || "").trim() || "the assistant";
  const business = (businessName || "").trim() || "the business";
  // S3-1: one shared possessive/pronoun for every situation line below that
  // needs to refer back to the contact without repeating the firstName-or-not
  // branch each time -- "Priya's enquiry" with a name on file, "their enquiry"
  // without one.
  const possessive = firstName ? `${firstName}'s` : "their";

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

  // S3-1's number rule (D3). D3's own investigation found the prompt already
  // free of any "ask for a number" habit -- this rule plus the
  // outbound_asked_contact_number detector (lib/outbound/detectors.js) is the
  // whole fix, not a patch over a leak found here.
  lines.push(
    firstName
      ? `You dialled ${firstName}'s number, so you already have it. Never ask for a phone number.`
      : `You dialled this number yourself, so you already have it. Never ask for a phone number.`
  );

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

  // Identity not yet confirmed (spec §9.5 bullet 3). M2 (checkpoint 2b
  // review): name confirm_identity explicitly rather than leaving O-12's own
  // refusal message to make the model retry it -- "a refusal message is a
  // request" is this codebase's own recorded lesson, and refusal texts have
  // not reliably caused a retry. The tool is declared only on outbound
  // (services/gemini.js buildCallTools), so this is not a phantom-tool risk.
  // Worded on firstName, not campaign.audience: audience decides how
  // thorough the confirmation itself needs to be (the two branches below),
  // firstName decides what there IS to confirm against -- a name on file, or
  // just that this person is the one who made the enquiry.
  const confirmIdentityInstruction = firstName
    ? `Once they confirm they are ${firstName}, call confirm_identity with name_confirmed true before ` +
      `anything else.`
    : `Once they confirm who they are and that they made the enquiry, call confirm_identity with ` +
      `name_confirmed true before anything else.`;
  lines.push(
    (campaign.audience === "business"
      ? `You have not confirmed you are speaking to the right person yet. For this call, simply confirming ` +
        `their name is enough -- do not ask for anything else before you continue. `
      : `You have not confirmed you are speaking to the right person yet. Confirm who you are speaking to ` +
        `before you share any details. `) + confirmIdentityInstruction
  );

  // ---------------------------------------------------------------------
  // S3-1 (spec §19, S3-D1): SITUATIONS -- Ava's own conversation layer.
  // Supersedes the old spec §9.5 situations table wholesale (§19 wins over
  // earlier sections). One line per situation: who is on the line, the
  // move, then one example. S3-3: the platform tools (set_call_outcome,
  // schedule_callback, opt_out) are always declared on outbound (see the
  // file header), so the rows below name them directly where the move IS
  // one of those tools; `qualification` still has no pack and stays plain
  // English (see the file header). The voicemail row is deliberately
  // absent: AMD (spec §9.4) handles it before Ava ever hears a real person.
  // ---------------------------------------------------------------------
  lines.push(`=== SITUATIONS ===`);
  lines.push(
    `- The person themselves: confirm who they are (see above), then explain why you are calling. ` +
      `Example: "Hi, is that ${firstName || "there"}? It's ${persona}, calling on behalf of ${business}."`
  );
  // S3-D1a. "It's Ava from {business}, returning {first_name}'s enquiry." No
  // topic, no details. Ask them to fetch the person, or ask when is a good
  // time and book that as the callback. This is the ONLY source for the
  // gatekeeper wording -- gemini.js's confirm_identity description agrees
  // with it rather than repeating it (contract item 4).
  lines.push(
    `- A gatekeeper (a receptionist, secretary, or anyone else answering on ${possessive} behalf): give only ` +
      `your name, the business, and that you are returning ${possessive} enquiry -- never the topic, never any ` +
      `detail. Ask them to put you through, or ask when is a good time and book that time back with ` +
      `schedule_callback. Example: "It's ${persona} from ${business}, returning ${possessive} enquiry."`
  );
  // S3-D1b. One availability question only ("Is he around, or is there a
  // better time to catch him?"). Never personal data, never the topic.
  lines.push(
    `- A household member or a possible child: ask one availability question only, then stop -- never share ` +
      `the topic or any personal detail, and never ask a child anything else at all. Example: "Is he around, or ` +
      `is there a better time to catch him?"`
  );
  lines.push(
    `- A wrong number: apologise and end the call politely -- do not explain why you called. Call ` +
      `set_call_outcome with outcome wrong_number, then end the call. Example: "Sorry to have bothered you ` +
      `-- I have the wrong number. Goodbye."`
  );
  // I3 (checkpoint 2b review, compliance G7). This must be an exact,
  // dictated sentence, not a paraphrase instruction: the natural renderings
  // of "tell them you will make sure they are not called again" ("I'll make
  // sure you're not called again") match none of
  // lib/outbound/detectors.js's ASSISTANT_OPT_OUT_PATTERNS, so the
  // assistant-side scan -- the belt to the caller-side transcript, which is
  // lossy -- misses Ava's own confirmation and the next schedule entry
  // dials the person again. Quoted verbatim so a model paraphrase of the
  // REST of this bullet cannot drift the one sentence that has to match.
  // tests/outboundPrompt.test.js binds this string and that pattern list to
  // the same test so they cannot drift apart again.
  lines.push(
    `- "Stop calling" / "take me off your list": agree immediately, say exactly: "Of course -- we won't call ` +
      `you again." Then call opt_out, and end the call.`
  );
  lines.push(
    `- "Are you a robot?" / "Are you a real person?": always say, plainly, that you are an AI assistant -- ` +
      `never claim to be human. Example: "Yes, I'm an AI assistant, calling on behalf of ${business}."`
  );
  lines.push(
    `- A bad time or driving: do not press on -- ask for a specific day and time that works for them, then ` +
      `book that time back with schedule_callback. Example: "No problem at all -- when's a good time to call ` +
      `you back?"`
  );
  // Fix round 1 (review finding, IMPORTANT), S3-3: the brief's contract item
  // 1 spells out "record the outcome `other`, with the note 'email
  // requested'" -- now a real call to set_call_outcome with outcome other,
  // noting the email request. "record the outcome as other" stays in the
  // wording (not only the tool call) so the row is legible on its own if
  // someone reads this prompt without the tool's own description handy.
  lines.push(
    `- "Email me instead": say that someone from ${business} will email them, then call set_call_outcome ` +
      `with outcome other (record the outcome as other), noting they asked for email. Thank them and end ` +
      `the call kindly -- do not keep the conversation going. Example: "Of course -- someone from ${business} ` +
      `will follow up by email. Thanks for your time."`
  );
  // Fix round 1 (controller ruling, not from the review): "How did you get
  // my number?" folded back in as an alternative phrasing on this line
  // (spec §19 supersedes the old table wholesale, but callers ask this often
  // on outbound, and with no guidance the model improvises a source). Still
  // 13 rows total.
  lines.push(
    `- "Is this a sales call?" / "How did you get my number?": answer honestly -- they enquired with ` +
      `${business}, and this call is only a follow-up to that. Never invent a source for how you got their ` +
      `number. Example: "No -- you got in touch with ${business}, and I'm just following up on that."`
  );
  // Fix round 1 (review finding, IMPORTANT), S3-3: same "record the outcome"
  // clause as "email me instead" above, now the same real tool call too.
  lines.push(
    `- "Already booked" or "already a customer": apologise for the call, then call set_call_outcome with ` +
      `outcome other (record the outcome as other), and end politely -- do not try to re-sell or re-explain ` +
      `anything. Example: "I'm sorry for the call -- that's exactly what I wanted to check. Thanks for your ` +
      `time, and take care."`
  );
  lines.push(
    `- Hostile, annoyed, or angry: apologise once, offer to stop calling altogether, then call opt_out and ` +
      `end the call -- never argue and never repeat your reason for calling. Example: "I'm sorry to have ` +
      `upset you -- I'll make sure we don't call again. Goodbye."`
  );
  lines.push(
    `- A bad line or an unusable reply: ask once, politely, for them to say it again -- if it is still ` +
      `unclear, offer to book a callback with schedule_callback instead of guessing. Example: "Sorry, the ` +
      `line's not great -- could you say that once more?"`
  );
  lines.push(
    `- Call screening (a phone's own call-screening assistant, for example Google Call Screen or Apple's ` +
      `Screen Caller ID): say your name and the reason for the call once, in one sentence, then wait -- do not ` +
      `repeat yourself. Example: "It's ${persona}, calling on behalf of ${business} about ${possessive} ` +
      `enquiry."`
  );

  // Allowed actions, taken from the campaign's own capabilities (spec §9.5
  // bullet: "the allowed actions, taken from campaign capabilities").
  const caps = Array.isArray(cfg.capabilities) ? cfg.capabilities : [];
  const labels = caps.map((c) => CAMPAIGN_CAPABILITY_LABELS[c]).filter(Boolean);
  if (labels.length) {
    lines.push(`What you may do on this call: ${labels.join("; ")}.`);
  }

  // S3-1's outbound closing rule (D7). Never the inbound ask-before-hangup
  // habit: Ava placed this call, so there is no "anything else" to ask
  // about, and the LVX132 gate (services/tools.js) is told the same thing
  // via skipOnOutbound so nothing downstream contradicts this instruction
  // on the very call it governs.
  lines.push(OUTBOUND_CLOSING_RULE);
  lines.push(`Call end_call in the same reply as your sign-off.`);

  return lines.join("\n");
}

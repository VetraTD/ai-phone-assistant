/**
 * Text-confirmation consent capability pack (ledger O25).
 *
 * CORE: the tool is registered on every call, like transfer.js's, and refused
 * at execution when the tenant has caller-facing SMS switched off
 * (`businesses.sms_followup_enabled`, default false since migration 017). What
 * forks per tenant is the PROMPT: a business that does not text is told it
 * cannot, rather than being offered a protocol for something that will never
 * happen. A receptionist that offers a text nobody will send is worse than one
 * that never mentions texting.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A PACK AND NOT A LINE IN THE ENGINE
 * ---------------------------------------------------------------------------
 * Two capabilities send caller-facing SMS — appointments and messages — and a
 * third will. The permission to send is the same question in every case, so it
 * belongs to neither of them, and putting it in the engine would make it
 * per-tenant configuration living in the one place the contract says must never
 * hold any (`_contract.js`: "ENGINE ... never per-tenant"). One file, one line
 * in the registry, no engine edit: the seam held.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PACK IS ACTUALLY FOR
 * ---------------------------------------------------------------------------
 * `DEFAULT_SMS_TEMPLATES.appointment_confirmation` puts a patient's name, a
 * clinic's name and an appointment time into an unencrypted SMS. That is
 * lawful when the individual has asked for that channel (45 CFR 164.522(b)) and
 * undefended when they have not; the identical answer is also TCPA prior
 * express consent, where the exposure is $500-$1,500 per message with no cap.
 * One question closes both, which is why it is one tool and not two features.
 *
 * The gate is `services/notifications.js` `sendCallerSms`. This pack is only
 * the asking.
 */

import { isValidE164 } from "../lib/validate.js";
import { SMS_CONSENT_SCRIPT, SMS_CONSENT_SCRIPT_VERSION } from "../lib/smsConsent.js";

const RECORD_SMS_CONSENT_DECLARATION = {
  name: "record_sms_consent",
  description:
    "Record whether the caller agreed to receive a text message. Call this " +
    "immediately after asking the text-confirmation question, with granted=true " +
    "if they said yes and granted=false if they said no. Never send or promise a " +
    "text before this has returned success.",
  parameters: {
    type: "object",
    properties: {
      granted: {
        type: "boolean",
        description: "true if the caller agreed to be texted, false if they declined",
      },
    },
    required: ["granted"],
  },
};

/**
 * The protocol. Its own section rather than a guardrail bullet because it is an
 * ordered procedure, and the ORDER is the part that is easy to get wrong.
 *
 * Step 1 exists because of a real ordering trap: the confirmation text is sent
 * the instant a booking succeeds, so a receptionist that books first and offers
 * the text afterwards has already missed the send. `sendCallerSms` holds a
 * blocked message for five minutes and releases it when consent lands, so the
 * natural conversational order still works — but a prompt is a request and the
 * hold is the belt. Both exist deliberately.
 */
const SMS_CONSENT_PROTOCOL_SECTION =
  `=== TEXT CONFIRMATIONS ===\n` +
  `You may offer to text the caller a confirmation. Before any text can be sent you must ask permission, and you must ask it in these words:\n` +
  `"${SMS_CONSENT_SCRIPT}"\n` +
  `1. Ask it BEFORE you book an appointment or record a message, not after — the text is prepared the moment that succeeds.\n` +
  `2. Then call record_sms_consent with granted=true if they agreed and granted=false if they declined. Record a "no" as carefully as a "yes"; it is what stops us texting someone who does not want it.\n` +
  `3. Only say a text is coming after record_sms_consent has returned success=true AND the caller agreed.\n` +
  `4. If the caller declines, do not raise it again on this call and do not mention texting in the goodbye.\n` +
  `5. The text goes to the number they are calling from. If they ask you to text a different number, explain that you can only text the number they called from, and offer to take the other number as part of a message instead.`;

/** @type {import("./_contract.js").CapabilityPack} */
export default {
  id: "sms_consent",
  label: "Text confirmations",
  description:
    "The receptionist asks permission before texting a caller, and records the answer. " +
    "Only used when caller text follow-ups are switched on in Settings; texts are never " +
    "sent without a recorded yes.",
  core: true,
  adapterKind: null,

  toolNames: [RECORD_SMS_CONSENT_DECLARATION.name],

  // Not an action tool. Recording permission does nothing for the caller by
  // itself, so it must not unlock a same-turn end_call — hanging up on someone
  // the moment they say "yes, text me" is the failure this prevents.
  actionTools: [],

  /**
   * Registered for every tenant that CAN text, and withheld from one that
   * cannot. Changed 2026-09-04, reversing an earlier decision on purpose.
   *
   * ---------------------------------------------------------------------------
   * Why the earlier decision was reversed rather than worked around
   * ---------------------------------------------------------------------------
   *
   * The first version gated registration on `smsFollowupEnabled` and was
   * reverted for breaking "core packs register their tools regardless of
   * configuration". That contract is real and its reason is real: a prompt that
   * refers to an unregistered tool is the phantom-tool bug messages.js was made
   * core to kill.
   *
   * Registering always and refusing in execute() satisfied the letter of it and
   * did not work. On a real call to a tenant with texting OFF, the assistant
   * opened with it -- the caller's first substantive turn was spent on "would
   * it be okay if we sent you text messages regarding your appointment?" --
   * record_sms_consent failed twice, and the caller's baffled "Hello." was read
   * as an answer to the consent question. On an earlier call it narrated the
   * discovery mid-sentence: "Actually, my mistake, we can't send texts."
   *
   * The prompt fork below already says "You cannot send text messages on this
   * line", and the model raised it anyway. A tool the model does not have is a
   * tool it cannot raise; that is the only version of this that holds, and it is
   * the same doctrine as everything else in this repository -- a prompt line is
   * a request, never a guarantee.
   *
   * ---------------------------------------------------------------------------
   * The contract, amended
   * ---------------------------------------------------------------------------
   *
   * A core pack still ignores `allowedTasks`: the operator's module toggles
   * cannot strip it. What it may now do is withhold a tool for an action the
   * tenant is PHYSICALLY UNABLE to perform, which is a different question from
   * a capability being switched off.
   *
   * The phantom-tool risk does not apply, and that is checkable rather than
   * asserted: when the tool is withheld the prompt does not mention it either --
   * the fork below emits a guardrail saying texting is unavailable and nothing
   * that names record_sms_consent. Both halves are pinned in
   * tests/capabilityRegistry.test.js.
   *
   * The execution refusal stays as defence in depth.
   */
  tools(config) {
    return config?.smsFollowupEnabled ? [RECORD_SMS_CONSENT_DECLARATION] : [];
  },

  prompt(config) {
    if (!config?.smsFollowupEnabled) {
      // The tool is registered but the business does not text anyone, so the
      // only thing worth saying about texting is that it is not available.
      //
      // This closes a hole that predates the tool: with nothing in the prompt
      // either way, a model could already improvise "I'll text you that" on any
      // call, and nothing would have sent anything. A caller told a text is
      // coming and given none is a broken promise whether or not a tool exists.
      return {
        static: {
          guardrails: [
            `- You cannot send text messages on this line. Never offer to text the caller and never say a text is on its way.\n`,
          ],
        },
      };
    }
    return {
      static: {
        capabilities: ["text you a confirmation, if you would like one"],
        protocols: [SMS_CONSENT_PROTOCOL_SECTION],
        guardrails: [
          `- Never tell a caller a text is on its way unless record_sms_consent returned success=true for granted=true on this call or you have been told they already agreed.\n`,
        ],
      },
    };
  },

  /**
   * Written HERE and awaited, unlike record_customer_request which defers its
   * write to onEffect.
   *
   * The difference is what a wrong answer costs. Message-taking reports success
   * optimistically because the caller is mid-sentence and the fallback flow can
   * re-record a lost message. Consent has no fallback flow: if the row does not
   * land, the gate blocks every text and the caller is told one is coming that
   * never arrives — so the model must be told the truth, which means waiting for
   * the insert. It is one INSERT on a connection `executeToolCallGuarded` has
   * already checked out and scoped.
   */
  async execute(fc, ctx = {}) {
    const granted = fc.args?.granted === true;
    const phone = ctx.callerPhone;

    // The gate that makes always-registering safe. A business with caller text
    // follow-ups switched off sends nothing, so recording a consent for it
    // would be a row nobody ever reads and a promise nobody keeps.
    if (!ctx.config?.smsFollowupEnabled) {
      const message =
        "This business does not send text messages. Do not offer or promise a text; carry on with the call.";
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: false, message } },
        stateEffects: {
          toolResult: { name: fc.name, success: false, message },
          toolCallEvent: { name: fc.name, args: fc.args ?? {} },
        },
      };
    }

    // A withheld caller ID arrives as a non-E.164 string ("anonymous"), so
    // there is no number to consent FOR. Refused before the write rather than
    // after, so no row claims consent for a number we do not have.
    if (!isValidE164(phone)) {
      const message =
        "There is no caller ID on this call, so a text cannot be sent. Offer to confirm by phone instead.";
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: false, message } },
        stateEffects: {
          toolResult: { name: fc.name, success: false, message },
          toolCallEvent: { name: fc.name, args: fc.args ?? {} },
        },
      };
    }

    const id = await ctx.deps?.recordSmsConsent?.({
      businessId: ctx.businessId,
      callId: ctx.callId || null,
      phoneNumber: phone,
      granted,
      script: SMS_CONSENT_SCRIPT,
      scriptVersion: SMS_CONSENT_SCRIPT_VERSION,
    });

    if (!id) {
      const message =
        "Their answer could not be recorded, so no text can be sent. Do not promise one; carry on with the call.";
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: false, message } },
        stateEffects: {
          toolResult: { name: fc.name, success: false, message },
          toolCallEvent: { name: fc.name, args: fc.args ?? {} },
        },
      };
    }

    const message = granted
      ? "Noted — you can tell them a text confirmation is coming."
      : "Noted — they declined a text. Do not offer again on this call.";

    return {
      functionResponse: { id: fc.id, name: fc.name, response: { success: true, message } },
      stateEffects: {
        toolResult: { name: fc.name, success: true, message },
        toolCallEvent: { name: fc.name, args: fc.args ?? {} },
        // Recorded on the call's scratchpad so the model sees it in CALLER FACTS
        // and stops re-asking, and so a later turn can tell the two answers
        // apart from "never asked".
        capabilityState: {
          sms_consent: {
            granted,
            callerFacts: {
              "Text confirmation": granted ? "caller agreed" : "caller declined",
            },
          },
        },
        capabilityEffects: [{ capability: "sms_consent", type: "answered", data: { granted } }],
      },
    };
  },

  /**
   * Release anything `sendCallerSms` held while consent was missing.
   *
   * A DEFERRED effect on purpose, and the deferral is the correctness argument:
   * `execute` runs inside `executeToolCallGuarded`'s tenant scope, which is an
   * open transaction. Sending the text from there would put it on a caller's
   * handset before the consent row had committed — and if that transaction then
   * rolled back, the system would have texted a patient with no record that
   * they ever agreed. `onEffect` runs after the scope closes, so a released
   * text is always backed by a committed row.
   *
   * Nothing here re-reads consent. It was just written by the call that
   * produced this effect, and re-reading it would race its own commit.
   */
  onEffect(effect, engine) {
    if (effect.type !== "answered") return;
    if (!effect.data?.granted) return;

    const { businessId, callerNumber, callSid } = engine.call || {};
    const { notifications, log } = engine.deps || {};
    if (!businessId || !callerNumber || !notifications?.releaseHeldCallerSms) return;

    notifications
      .releaseHeldCallerSms(businessId, callerNumber)
      .catch((err) => log?.error?.("sms_followup_failed", { callSid, reason: err?.message }));
  },
};

// capabilities/qualification.js
/**
 * S3-10 (spec §12.2, Task 24): the "qualification" CAMPAIGN pack --
 * `record_answer({key, value})`.
 *
 * CAMPAIGN, not platform (contrast lib/outbound/policy.js's PLATFORM_PACKS --
 * outcome/callback/opt_out -- which are unioned onto EVERY outbound call
 * regardless of what the campaign's own `capabilities` list says). This pack's
 * `tools()` returns nothing at all unless BOTH `ctx.outboundCall` is present
 * AND the campaign's own `config.capabilities` names `"qualification"` --
 * gated at the SOURCE, the same way every tenant pack (appointments,
 * messages, ...) gates itself on `config.allowedTasks` rather than relying
 * solely on services/gemini.js's filterForOutboundCampaign / services/tools.js's
 * execution-time mirror downstream. This is what keeps `record_answer` off
 * every inbound call (named risk 3): filterForOutboundCampaign's inbound
 * branch only strips PLATFORM_PACKS, so a pack whose OWN `tools()` returns a
 * declaration unconditionally would leak straight through on inbound. Task 26
 * (inbound callback recognition, spec §12.3) is what widens this gate to
 * ALSO declare the tool on a qualifying inbound call -- out of scope here.
 *
 * `record_answer`'s valid keys are exactly the campaign's own
 * `config.questions[].key` (lib/outbound/campaignSchema.js) -- an unknown key
 * is refused, naming the valid ones. Not an action tool (`actionTools: []`,
 * named risk 2): recording an answer is a note, not a caller-visible task
 * completed for them, so it must not unlock same-turn end_call and must not
 * be blocked by O-12's unverified-party refusal (services/tools.js) -- a
 * gatekeeper who will never pass confirm_identity must still be able to
 * answer on the contact's behalf, the same reasoning callback.js and
 * outcome.js already give for their own tools.
 *
 * PERSISTENCE. Answers accumulate in `capabilityState.qualification.answers`
 * for the rest of THIS call (so the booking gate below, and a later
 * record_answer in the same call, both see what has already been given), and
 * are ALSO merged into `calls.answers` (jsonb, migration 043) immediately,
 * via `ctx.deps.mergeCallAnswers` -- the same primitive and the same
 * "immediate write inside this tool's own tenant scope" pattern
 * capabilities/outcome.js's `_outcome_note` and capabilities/callback.js's
 * `callback_requested_at` already use (services/tools.js's
 * executeToolCallGuarded holds a tenant scope open for the whole call, so
 * this write is never outside it -- named risk 5). Answers therefore land in
 * `calls.answers` well before the call ends -- by the time
 * lib/outbound/postCall.js's step 7 reads `calls.answers` for the results
 * webhook payload, whatever this tool wrote is already there. No change to
 * postCall.js's own code is needed for that to be true.
 *
 * NEVER `_outcome_note` or `_missing_required` (the two leading-underscore
 * keys outcome.js and the booking gate below use): a campaign question key
 * matches `/^[a-z][a-z0-9_]{0,39}$/` (lib/outbound/campaignSchema.js's
 * QUESTION_KEY_RE), which REQUIRES the first character to be a lowercase
 * letter, so a question key can never collide with a leading-underscore key
 * regardless of what any campaign ever names a question.
 *
 * `prompt(cfg, ctx)` (fix round 1, controller Ruling R-S3-10-prompt: the full
 * Task 24 contract binds). `lib/outbound/prompt.js:44`'s `qualify_then_book`
 * goal line ("Ask the questions, then offer a time to talk") names no
 * questions of its own -- record_answer's `key` enum is the only OTHER place
 * a question could reach the model, and it carries keys ("clinic_name"),
 * never the human `ask` text a receptionist would actually say out loud.
 * Without this, the model has been told WHAT TO DO but never WHAT TO ASK.
 *
 * Follows capabilities/transfer.js:75-88's shape (the brief's own template):
 * a `static.capabilities` clause, gated the same way `tools()` above is --
 * nothing at all with no `ctx.outboundCall` (inbound), and nothing when the
 * campaign's own capabilities list omits `"qualification"`. This mirrors
 * `outboundAllowsPack` in lib/capabilities/promptAssembler.js (`!outbound`
 * returns `true`, i.e. EVERY pack's `prompt()` runs unconditionally on
 * inbound) -- exactly the same shape `tools()`'s own comment already
 * documents for services/gemini.js's `collectTools`/`filterForOutboundCampaign`,
 * so the self-gate here is not optional, it is the ONLY gate on inbound.
 *
 * `static.capabilities` entries are joined into ONE sentence by
 * services/gemini.js (`clauses.join(", ")`, "You can: ..."), so each
 * question becomes its OWN array entry -- a short clause, not a multi-line
 * block -- rather than one giant string with embedded newlines that would
 * read as broken prose once spliced into that sentence.
 *
 * Never touches the opener or the voicemail: `renderCampaignLine`
 * (lib/outbound/campaignSchema.js) only ever sees the fixed placeholder set
 * (`first_name`, `persona_name`, `business_name`, `topic`,
 * `caller_id_spoken`) and has no access to `config.questions` at all, so
 * there is no code path for a question to leak into either render -- this
 * pack does not change that, and tests/qualificationPack.test.js asserts it
 * stays true.
 */
import { bumpCounter } from "../lib/voice/metrics.js";

function campaignQuestions(ctx) {
  const outbound = ctx?.outboundCall;
  return Array.isArray(outbound?.config?.questions) ? outbound.config.questions : [];
}

function validKeys(questions) {
  return questions.map((q) => q?.key).filter((k) => typeof k === "string" && k);
}

/** Questions with both a usable `key` and a non-empty `ask` -- the two fields `prompt()` renders. */
function askableQuestions(questions) {
  return questions.filter(
    (q) => q && typeof q.key === "string" && q.key && typeof q.ask === "string" && q.ask.trim()
  );
}

/** Is this campaign's qualification capability turned on for this outbound call? */
function qualificationEnabled(ctx) {
  const outbound = ctx?.outboundCall;
  if (!outbound) return false; // named risk 3: inbound never reaches past here
  const capabilities = Array.isArray(outbound.config?.capabilities) ? outbound.config.capabilities : [];
  return capabilities.includes("qualification");
}

function recordAnswerDeclaration(questions) {
  const keys = validKeys(questions);
  return {
    name: "record_answer",
    description:
      "Record the caller's answer to one of this call's qualification questions. Call this right after " +
      "they answer each one -- do not wait until the end of the call to record several at once, and do " +
      "not invent an answer they did not give.",
    parameters: {
      type: "object",
      properties: {
        key: {
          type: "string",
          ...(keys.length ? { enum: keys } : {}),
          description: keys.length
            ? `Which question this answers. One of: ${keys.join(", ")}.`
            : "Which question this answers.",
        },
        value: {
          type: "string",
          description: "The caller's answer, in their own words, at most 500 characters.",
        },
      },
      required: ["key", "value"],
    },
  };
}

function refusal(fc, message) {
  return {
    functionResponse: { id: fc.id, name: fc.name, response: { success: false, message } },
    stateEffects: {
      toolResult: { name: fc.name, success: false, message },
      toolCallEvent: { name: fc.name, args: fc.args ?? {}, silent: true },
    },
  };
}

/** @type {import("./_contract.js").CapabilityPack} */
export default {
  id: "qualification",
  label: "Qualification questions",
  description:
    "Ask the campaign's qualification questions and record each answer. Only available on an outbound " +
    "call whose campaign lists it; never used on inbound.",
  core: false,
  adapterKind: null,

  toolNames: ["record_answer"],
  // Named risk 2: never an action tool. See the file header.
  actionTools: [],

  tools(cfg, ctx = {}) {
    // Named risk 3: no ctx.outboundCall at all means inbound (or the cascade/
    // text harness, which supply neither field) -- return nothing, full stop.
    // Task 26 (inbound callback recognition) is the only place this widens.
    if (!qualificationEnabled(ctx)) return [];
    return [recordAnswerDeclaration(campaignQuestions(ctx))];
  },

  /**
   * `static.capabilities`: one clause per askable question, each naming its
   * key, its required/optional status, and the `ask` text a receptionist
   * would actually say -- see the file header for why this exists and how it
   * is shaped. Gated identically to `tools()` above (named risk 3): `{}` with
   * no `ctx.outboundCall`, or when the campaign never turned qualification
   * on, or when the campaign has no question with both a key and an `ask`.
   */
  prompt(cfg, ctx = {}) {
    if (!qualificationEnabled(ctx)) return { static: { capabilities: [] } };
    const questions = askableQuestions(campaignQuestions(ctx));
    if (questions.length === 0) return { static: { capabilities: [] } };

    const lead = "ask the campaign's qualification questions, recording each answer with record_answer";
    const perQuestion = questions.map(
      (q) => `${q.key} (${q.required ? "required" : "optional"}): "${q.ask}"`
    );
    return { static: { capabilities: [lead, ...perQuestion] } };
  },

  async execute(fc, ctx = {}) {
    const questions = campaignQuestions(ctx);
    const keys = validKeys(questions);
    const key = fc.args?.key;
    const value = fc.args?.value;

    if (typeof key !== "string" || !keys.includes(key)) {
      bumpCounter("qualification_answer_refused");
      const named = typeof key === "string" && key ? ` "${key}"` : "";
      return refusal(
        fc,
        `Unknown question key${named}. Valid keys: ${keys.length ? keys.join(", ") : "(none configured for this call)"}.`
      );
    }
    if (typeof value !== "string" || value.length > 500) {
      bumpCounter("qualification_answer_refused");
      return refusal(fc, `The value for "${key}" must be a string of at most 500 characters. Valid keys: ${keys.join(", ")}.`);
    }

    const callSid = ctx.callSid || null;
    if (callSid) {
      await ctx.deps?.mergeCallAnswers?.(callSid, { [key]: value });
    }

    bumpCounter("qualification_answer_recorded");
    const priorAnswers = ctx?.capabilityState?.qualification?.answers || {};
    const message = "Recorded.";
    return {
      functionResponse: { id: fc.id, name: fc.name, response: { success: true, message } },
      stateEffects: {
        toolResult: { name: fc.name, success: true, message },
        toolCallEvent: { name: fc.name, args: fc.args ?? {} },
        capabilityState: { qualification: { answers: { ...priorAnswers, [key]: value } } },
        capabilityEffects: [{ capability: "qualification", type: "answered", data: { key } }],
      },
    };
  },

  /**
   * A history note only, so the model does not re-ask a question it has
   * already recorded an answer for -- the same reason appointments.js's own
   * onEffect leaves a note after a booking or a change. Also what stops
   * lib/capabilities/effects.js's dispatchCapabilityEffects logging
   * `capability_effect_unhandled` on every single recorded answer: a pack
   * that emits a capabilityEffect must have an onEffect, or every call to it
   * is an "unhandled" error log.
   */
  onEffect(effect, engine) {
    if (effect.type !== "answered") return;
    const key = effect.data?.key;
    if (key) engine.addHistoryNote(`record_answer recorded an answer for "${key}". Do not ask this question again.`);
  },
};

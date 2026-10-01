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
 * `_callback_requested_at` already use (services/tools.js's
 * executeToolCallGuarded holds a tenant scope open for the whole call, so
 * this write is never outside it -- named risk 5). Answers therefore land in
 * `calls.answers` well before the call ends -- by the time
 * lib/outbound/postCall.js's step 7 reads `calls.answers` for the results
 * webhook payload, whatever this tool wrote is already there. No change to
 * postCall.js's own code is needed for that to be true.
 *
 * NEVER `_outcome_note`, `_missing_required`, or `_callback_requested_at`
 * (the leading-underscore keys outcome.js, the booking gate below, and
 * callback.js use): a campaign question key matches
 * `/^[a-z][a-z0-9_]{0,39}$/` (lib/outbound/campaignSchema.js's
 * QUESTION_KEY_RE), which REQUIRES the first character to be a lowercase
 * letter, so a question key can never collide with a leading-underscore key
 * regardless of what any campaign ever names a question. Minor (review):
 * `_callback_requested_at` was plain `callback_requested_at` until this
 * wave -- the ONE key here that was NOT actually protected by this claim,
 * despite the header implying it was (a campaign question literally named
 * `callback_requested_at` fits QUESTION_KEY_RE and would have collided).
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
import { log } from "../lib/logger.js";

function campaignQuestions(ctx) {
  const outbound = ctx?.outboundCall;
  if (!outbound) return callbackQuestions(ctx);
  return Array.isArray(outbound?.config?.questions) ? outbound.config.questions : [];
}

/**
 * S4-1 (spec §12.3): on an INBOUND call recognised as a lead's callback
 * (lib/outbound/callbackRecognition.js), the questions still unanswered for
 * their open outreach. `ctx.callbackOutreach` is set only by that helper, only
 * on inbound, so every other inbound call still reads [] here.
 */
function callbackQuestions(ctx) {
  const remaining = ctx?.callbackOutreach?.remainingQuestions;
  return Array.isArray(remaining) ? remaining : [];
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
  // Named risk 3: inbound never reaches past here -- except a recognised
  // callback with at least one question still to ask (S4-1).
  if (!outbound) return callbackQuestions(ctx).length > 0;
  const capabilities = Array.isArray(outbound.config?.capabilities) ? outbound.config.capabilities : [];
  return capabilities.includes("qualification");
}

function recordAnswerDeclaration(questions, { withAsk = false } = {}) {
  const keys = validKeys(questions);
  // A callback's tail line lists the questions in words, not keys; this maps one to the other.
  const gloss = withAsk
    ? " " + askableQuestions(questions).map((q) => `${q.key} = "${q.ask}"`).join("; ") + "."
    : "";
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
            ? `Which question this answers. One of: ${keys.join(", ")}.${gloss}`
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

/**
 * 2026-10-01 (spec 2026-10-01-outbound-live-first-line §5b): the read-back
 * gate's comparison form -- lower case, letters and digits only, no spaces
 * at all. "St. Mary's Clinic 2" and the model's own transcript of reading it
 * back ("st marys clinic 2", or "Bright work Clinic" for "Brightwork Clinic")
 * compare equal; a different value never does.
 */
function readBackForm(text) {
  return String(text ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Refusals before a confirm answer is saved anyway, logged uncertain (spec §5b: no third ask). */
const READ_BACK_MAX_REFUSALS = 2;
const READ_BACK_FIRST = "Read the answer back to them first, then save it.";

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
    return [recordAnswerDeclaration(campaignQuestions(ctx), { withAsk: !ctx?.outboundCall })];
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
    // A recognised callback gets its questions in the DYNAMIC tail
    // (services/gemini.js buildCallbackSection); the cached static prefix
    // stays exactly what it is for every other inbound call.
    if (!ctx?.outboundCall) return { static: { capabilities: [] } };
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

    // 2026-10-01 (spec §5b): a question marked `confirm` is saved only after
    // the AI has read the answer back -- Live's caller transcript is lossy
    // ("best college" for a clinic's name), and only the person can tell. The
    // evidence is the AI's own heard speech earlier in this call
    // (ctx.assistantSaidThisCall, lib/voice/live/index.js) containing the
    // value. Refusals count per key; after READ_BACK_MAX_REFUSALS the write
    // goes through, logged qualification_answer_uncertain -- a caller is never
    // stuck in a spelling loop, and nothing is stored differently.
    // Live only: the cascade (lib/voice/session.js, a recognised inbound
    // callback) supplies no assistantSaidThisCall and stays ungated -- its STT
    // is not the lossy one this exists for. tests/liveOutboundLiveMode.test.js
    // proves the Live wire end to end, so a broken wire cannot hide as "off".
    const question = questions.find((q) => q?.key === key);
    if (question?.confirm === true && typeof ctx.assistantSaidThisCall === "string") {
      const qualificationState = ctx?.capabilityState?.qualification || {};
      const refusals = Number(qualificationState.readBackRefusals?.[key]) || 0;
      const wanted = readBackForm(value);
      const readBack = wanted.length > 0 && readBackForm(ctx.assistantSaidThisCall).includes(wanted);
      if (!readBack) {
        if (refusals < READ_BACK_MAX_REFUSALS) {
          bumpCounter("qualification_answer_refused");
          bumpCounter("qualification_read_back_refused");
          const out = refusal(fc, READ_BACK_FIRST);
          out.stateEffects.capabilityState = {
            qualification: { readBackRefusals: { ...(qualificationState.readBackRefusals || {}), [key]: refusals + 1 } },
          };
          return out;
        }
        bumpCounter("qualification_answer_uncertain");
        log.info("qualification_answer_uncertain", { key, callSid: ctx.callSid || null });
      }
    }

    const callSid = ctx.callSid || null;
    // FINAL FIX WAVE I2: a recognised callback's answers exist to be written.
    // No call sid there is a missing wire (the cascade tool ctx once had none),
    // and answering "Recorded." for a write that never ran is a fabricated
    // success -- fail loudly to the model and to the logs instead.
    if (!callSid && ctx.callbackOutreach) {
      bumpCounter("qualification_answer_refused");
      bumpCounter("qualification_answer_no_callsid");
      log.error("qualification_answer_no_callsid", {
        key,
        businessId: ctx.businessId ?? null,
        outreachId: ctx.callbackOutreach?.outreachId ?? null,
        severity: "warn",
      });
      return refusal(fc, `The answer for "${key}" could not be recorded. Do not tell them it was.`);
    }
    if (callSid) {
      // Minor (review): unlike opt_out/outcome.js's own writes, this used
      // `?.()` straight through -- a missing `mergeCallAnswers` wire silently
      // no-opped and the tool still answered "Recorded." mergeCallAnswers
      // (services/db.js) resolves to `undefined` on a genuine SUCCESS too
      // (unlike insertSuppression's true/false), so the wire's PRESENCE, not
      // its return value, is what a missing dependency looks like here.
      if (typeof ctx.deps?.mergeCallAnswers !== "function") {
        bumpCounter("qualification_answer_refused");
        return refusal(fc, `The answer for "${key}" could not be recorded. Do not tell them it was.`);
      }
      await ctx.deps.mergeCallAnswers(callSid, { [key]: value });
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

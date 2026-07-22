/**
 * Prompt-only capability packs.
 *
 * Four modules that contribute nothing but a clause to the CAPABILITIES line:
 * they have no tools, no adapter, no execution and no state effects. The
 * receptionist simply answers from the knowledge base, or collects details and
 * hands off to the message protocol.
 *
 * They are worth having as real packs for two reasons:
 *
 *  1. They keep the CAPABILITIES line's ordering owned by the registry rather
 *     than split between the registry and a leftover if-chain in the engine.
 *
 *  2. They are the third shape the pack contract has to handle — a capability
 *     with no tools at all. Appointments (stateful, adapter-backed, strict
 *     identity) and messages (stateless, notification-only) are the other two.
 *     A contract that only fits capabilities with tools would have been an
 *     appointment framework wearing a costume.
 *
 * `quotes` is the one to watch: Step C grows it into a full capability with a
 * tool, execution and a notification effect, and doing that must not require
 * editing services/gemini.js, services/tools.js or lib/voice/session.js. That
 * is the falsifiable test of this whole design.
 */

/**
 * Build a minimal prompt-only pack.
 * @param {string} id
 * @param {string} moduleTask - the allowed_tasks entry that enables it
 * @param {string} clause - its CAPABILITIES clause
 */
function infoOnlyPack(id, moduleTask, clause) {
  return {
    id,
    core: false,
    adapterKind: null,
    toolNames: [],
    actionTools: [],

    prompt(config) {
      const allowed = config?.allowedTasks || [];
      return { static: { capabilities: allowed.includes(moduleTask) ? [clause] : [] } };
    },
  };
}

/**
 * General Q&A. Answers come from the KNOWLEDGE BASE section the engine builds
 * from business_knowledge rows, not from anything this pack contributes.
 */
export const generalQuestion = infoOnlyPack(
  "general_question",
  "general_question",
  "answer general questions about the business"
);

export const directions = infoOnlyPack(
  "directions",
  "directions_location",
  "provide address and directions"
);

export const forms = infoOnlyPack(
  "forms",
  "form_document_request",
  "explain how to get forms or documents"
);

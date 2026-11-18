/**
 * Shared tool-result shapes.
 *
 * Every capability's execute() returns the same envelope: a `functionResponse`
 * that goes back to the model, and `stateEffects` the engine applies to the
 * turn. These helpers keep that envelope consistent so a pack author does not
 * have to rediscover the shape — and so the difference between "the tool
 * failed" and "the tool refused" stays visible.
 */

/**
 * Returned when a tool that needs a tenant is called without one.
 *
 * lib/voice/session.js logs "no_business_found" and continues with
 * state.businessId unset, so this is reachable on a real call. Running a data
 * tool unscoped would query across every tenant, so it refuses outright and
 * steers the model to take a message instead.
 */
export const NO_BUSINESS_MESSAGE =
  "I'm not able to look that up right now. Let me take a message and someone will follow up.";

/**
 * Uniform "this tool cannot run without a tenant" result.
 * @param {{id?: string, name: string, args?: object}} fc
 * @param {object} [extraStateEffects] - pack-specific effects to merge
 */
export function noBusinessResult(fc, extraStateEffects = {}) {
  return {
    functionResponse: {
      id: fc.id,
      name: fc.name,
      response: { success: false, message: NO_BUSINESS_MESSAGE },
    },
    stateEffects: {
      ...extraStateEffects,
      // Phrased for the caller, so it may be spoken verbatim when the model
      // produces no text (see the callerSafe note in services/gemini.js).
      toolResult: { name: fc.name, success: false, message: NO_BUSINESS_MESSAGE, callerSafe: true },
      toolCallEvent: { name: fc.name, args: fc.args ?? {} },
    },
  };
}

/**
 * The result for a tool the receptionist has no way to run — no pack owns it
 * and no integration matches. Distinct from a failure: nothing was attempted.
 * @param {{id?: string, name: string, args?: object}} fc
 */
export function unknownToolResult(fc) {
  return {
    // "Unknown function" is for the model's benefit and must never be spoken;
    // the toolResult carries the caller-facing apology instead.
    functionResponse: { id: fc.id, name: fc.name, response: { error: "Unknown function" } },
    stateEffects: {
      toolResult: {
        name: fc.name,
        success: false,
        message: "I'm sorry, I wasn't able to do that.",
        callerSafe: true,
      },
      toolCallEvent: { name: fc.name, args: fc.args },
    },
  };
}

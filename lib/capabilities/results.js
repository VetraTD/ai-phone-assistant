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
      toolResult: { name: fc.name, success: false, message: NO_BUSINESS_MESSAGE },
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
    functionResponse: { id: fc.id, name: fc.name, response: { error: "Unknown function" } },
    stateEffects: {
      toolResult: { name: fc.name, success: false, message: "I'm sorry, I wasn't able to do that." },
      toolCallEvent: { name: fc.name, args: fc.args },
    },
  };
}

/**
 * The scheduling adapter interface.
 *
 * One capability kind, several backends. A capability calls these; it never
 * names a provider.
 *
 * @typedef {object} SchedulingAdapter
 * @property {string} id
 * @property {string} label - human name, for the settings UI
 * @property {string[]} verifiableFields
 *   Facts this backend can actually prove a caller against. Empty means it can
 *   prove nothing, so identity fields on it are collect-only no matter what an
 *   operator configures. This is what stops the UI offering a guarantee the
 *   backend cannot deliver.
 * @property {(integrations: Array) => boolean} [claimsIntegration]
 *   Legacy routing: did this business reach this backend before it had explicit
 *   configuration? Preserves behavior mid-migration.
 * @property {boolean} [routesThroughIntegration]
 *   True when the model calls this backend's tools directly and execution goes
 *   through services/integrations.js rather than the methods below.
 * @property {((ctx: object) => Promise<Array>)|null} lookupByCaller
 * @property {((ctx: object, args: object) => Promise<{ok: boolean, id?: string}>)|null} book
 * @property {((ctx: object, args: object) => Promise<{ok: boolean}>)|null} cancel
 * @property {((ctx: object, args: object) => Promise<{ok: boolean}>)|null} reschedule
 * @property {((ctx: object, args: object) => Promise<Array>)|null} findSlots
 */

export {};

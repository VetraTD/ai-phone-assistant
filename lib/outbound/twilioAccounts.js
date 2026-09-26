// lib/outbound/twilioAccounts.js
/**
 * O-26 / C17: dial from either Twilio account.
 *
 * Before this task the service held only account A's REST credentials
 * (`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`), and `createTwilioClientFor`
 * (lib/outbound/internalRoutes.js) built ONE client, ignoring its `callerId`
 * argument entirely ("account A today (C17 seam)", its own long-standing
 * comment). A second Twilio account (B) can now also own a campaign's
 * `caller_id` (`TWILIO_ACCOUNT_SID_ALT`/`TWILIO_AUTH_TOKEN_ALT`, added at
 * go-live), and every REST call this service makes about an outbound call --
 * `calls.create`, hanging up an unroutable call, the AMD voicemail update,
 * the transfer redial, the sweep's lost-callback fetch -- must use the
 * client for the account that actually owns the caller ID in play. Twilio's
 * Calls resource is account-scoped: using the wrong account's client against
 * an existing call's SID just 404s, and creating a call with a `from` number
 * the authenticated account does not own is refused outright.
 *
 * Two layers, the same split `createCallerIdValidator` already has between
 * "the cache/timeout logic" and "how a client is built":
 *   - `createAccountRouter({accounts, ...opts})` is the injectable core --
 *     `accounts` is `{A: clientGetter|null, B: clientGetter|null}`, so a test
 *     can hand it fake Twilio clients with no real credentials.
 *   - `createTwilioAccountRouter(env)` is the production factory: builds
 *     lazy REAL `twilio()` clients from the env, and delegates to the core.
 *
 * REUSES `createCallerIdValidator` (internalRoutes.js) for BOTH accounts,
 * rather than a second cache implementation -- one instance per configured
 * account, each with its own success-only, TTL cache, exactly as account A's
 * dispatch-time check has always had. `resolveAccountFor` checks accounts in
 * order (A, then B) and stops at the first match: a real Twilio number is
 * provisioned on exactly one account, so the first match IS the owner --
 * this only ever costs a second REST call when A does NOT own the number
 * (or B is not configured, in which case there is no second account to ask).
 */
import twilio from "twilio";
import { createCallerIdValidator } from "./internalRoutes.js";

/**
 * Which accounts are configured (spec O-26): each pair is required in full
 * -- B configured without its SID (or without its token) is the same as B
 * not configured at all, never a half-built client.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{A: boolean, B: boolean}}
 */
export function configuredAccounts(env = process.env) {
  return {
    A: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN),
    B: Boolean(env.TWILIO_ACCOUNT_SID_ALT && env.TWILIO_AUTH_TOKEN_ALT),
  };
}

/**
 * The injectable core: which of A/B owns a caller ID (`resolveAccountFor`),
 * and each account's client, resolved by caller ID (`twilioClientFor`).
 *
 * @param {{
 *   accounts: {A?: (() => object)|null, B?: (() => object)|null},
 *   timeoutMs?: number, cacheTtlMs?: number, now?: () => number,
 * }} o
 *   `accounts.A`/`accounts.B`: a client-getter (sync or returning a client
 *   shaped like `{incomingPhoneNumbers: {list}, calls}`) for a CONFIGURED
 *   account, or `null`/omitted when that account is not configured.
 */
export function createAccountRouter({ accounts, timeoutMs, cacheTtlMs, now } = {}) {
  const present = { A: typeof accounts?.A === "function", B: typeof accounts?.B === "function" };
  const opts = { ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(cacheTtlMs !== undefined ? { cacheTtlMs } : {}), ...(now !== undefined ? { now } : {}) };

  // One createCallerIdValidator PER CONFIGURED account: same cache/timeout/
  // lookup code account A's dispatch-time check has always used, just
  // instantiated once more for account B rather than a second cache
  // mechanism written from scratch.
  const validators = {};
  if (present.A) validators.A = createCallerIdValidator({ twilioClientFor: accounts.A, ...opts });
  if (present.B) validators.B = createCallerIdValidator({ twilioClientFor: accounts.B, ...opts });
  const order = [present.A && "A", present.B && "B"].filter(Boolean);

  /**
   * Which configured account owns `phoneE164` -- checked in order (A, then
   * B), stopping at the first match. THROWS on a timeout or a lookup error
   * (the same contract `createCallerIdValidator` already has), so a caller
   * that needs "ambiguous means retry, not permanently invalid" -- the
   * dispatch-time gate fact, run inside a DB transaction it must roll back
   * cleanly -- gets that for free. Resolves `null` when neither configured
   * account owns the number (a clean negative, never swallowed).
   * @param {string} phoneE164
   * @returns {Promise<"A"|"B"|null>}
   */
  async function resolveAccountFor(phoneE164) {
    if (!phoneE164) return null;
    for (const key of order) {
      if (await validators[key](phoneE164)) return key;
    }
    return null;
  }

  /**
   * The owning account's client for a REST call about an existing or
   * about-to-be-placed outbound call.
   *
   * - No `callerId`, or B is not configured at all: account A (or B, if only
   *   B is configured) with no lookup -- an existing caller with only one
   *   account's credentials keeps exactly today's behaviour, no REST call.
   * - `resolveAccountFor` throwing (a timeout/lookup error) or resolving
   *   `null` (owned by neither configured account) falls back to account A
   *   rather than returning nothing: the true fail-closed control point for
   *   an unowned caller_id is the SEPARATE dispatch-time gate fact
   *   (`callerIdValid`, itself built on `resolveAccountFor`) -- a campaign
   *   whose caller_id cannot be confirmed never reaches a REST call at all.
   *   A later touch point (the AMD callback, a transfer redial, the sweep)
   *   reaching this fallback means an ALREADY-VALIDATED number's cache entry
   *   expired (each validator's TTL) or this is a cold instance that has
   *   never looked it up -- Twilio's own account-scoping 404s a genuine
   *   mismatch, which every call site here already catches, logs and
   *   continues past (doorRoutes.js's `updateCall`, dispatch.js's `hangUp`,
   *   internalRoutes.js's lost-callback fetch).
   * @param {string} [callerId]
   * @returns {Promise<object|null>}
   */
  async function twilioClientFor(callerId) {
    if (!callerId || !present.B) return present.A ? accounts.A() : present.B ? accounts.B() : null;
    let key = null;
    try {
      key = await resolveAccountFor(callerId);
    } catch {
      key = null;
    }
    if (key) return accounts[key]();
    return present.A ? accounts.A() : accounts.B();
  }

  return { resolveAccountFor, twilioClientFor, configured: present };
}

/**
 * The production factory: builds lazy REAL `twilio()` clients from the env
 * (never eagerly -- the Twilio SDK's constructor throws outright on a SID
 * that does not start with "AC", so importing this module, or calling this
 * function, must not require valid credentials for an account that is not
 * configured), and delegates account resolution to `createAccountRouter`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{timeoutMs?: number, cacheTtlMs?: number, now?: () => number}} [opts]
 */
export function createTwilioAccountRouter(env = process.env, opts = {}) {
  const present = configuredAccounts(env);
  let clientA = null;
  let clientB = null;
  return createAccountRouter({
    accounts: {
      A: present.A ? () => (clientA ??= twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN)) : null,
      B: present.B ? () => (clientB ??= twilio(env.TWILIO_ACCOUNT_SID_ALT, env.TWILIO_AUTH_TOKEN_ALT)) : null,
    },
    ...opts,
  });
}

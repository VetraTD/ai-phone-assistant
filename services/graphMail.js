// ---------------------------------------------------------------------------
// Owner email through Microsoft 365: the Graph sendMail API, app-only token.
//
// Used by services/notifications.js when MAIL_TRANSPORT=graph, and by
// scripts/graph-mail-smoke.js. No SDK: two POSTs with fetch.
//
// Why not SMTP with a password: Microsoft turns Basic-auth SMTP AUTH off by
// default from December 2026 and removes it in 2027, and a tenant with security
// defaults blocks it already. An app-only OAuth token (client credentials),
// sending from one shared mailbox, is the route that keeps working.
//
// WHAT NEVER LEAVES THIS MODULE: the recipient, the subject, the body, the
// client secret, the token, or Microsoft's own error text. Microsoft's error
// bodies can quote the address, so they are never read. A failure is a closed
// reason (graph_token_failed, graph_refused, graph_timeout) and, when there was
// one, the HTTP status.
// ---------------------------------------------------------------------------

/**
 * How long one send may take, start to finish. The token request has this as
 * its own timeout too, and a send's token wait and its sendMail share one
 * deadline of this length, so a slow token followed by a hung send still ends
 * here rather than at twice this. Below the 10 s cap notifyCallRequests puts
 * on a send (services/notifications.js), so a hung Microsoft call is reported
 * as this module's timeout, not as the flush's.
 */
export const GRAPH_FETCH_TIMEOUT_MS = 8_000;

/** A cached token is refetched this long before Microsoft says it expires. */
const TOKEN_EARLY_REFRESH_MS = 60_000;
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

/** The four variables graph mode needs, all of them. */
export const GRAPH_MAIL_VARS = Object.freeze([
  "MS_GRAPH_TENANT_ID",
  "MS_GRAPH_CLIENT_ID",
  "MS_GRAPH_CLIENT_SECRET",
  "MS_GRAPH_SENDER",
]);

function present(value) {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Which transport MAIL_TRANSPORT selects, read the one way both readers use:
 * services/notifications.js (which sends) and lib/bootChecks.js (which reports
 * at boot), so the two cannot disagree about whether email is on. Pure: reads
 * only the env it is handed, at call time.
 *
 * Unset or blank is "smtp". "graph" in any case, with surrounding space, is
 * "graph". Anything else is "smtp" with `invalid` set.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{ transport: "smtp" | "graph", invalid: boolean }}
 */
export function mailTransportSetting(env = process.env) {
  const raw = typeof env.MAIL_TRANSPORT === "string" ? env.MAIL_TRANSPORT.trim().toLowerCase() : "";
  return {
    transport: raw === "graph" ? "graph" : "smtp",
    invalid: raw !== "" && raw !== "smtp" && raw !== "graph",
  };
}

/**
 * The NAMES (never the values) of the graph variables that are missing or blank.
 * @param {Record<string, string|undefined>} env
 * @returns {string[]}
 */
export function missingGraphMailVars(env = process.env) {
  return GRAPH_MAIL_VARS.filter((name) => !present(env[name]));
}

/**
 * The graph settings, or null when any of the four is missing or blank. Values
 * are trimmed: a secret pasted with a trailing newline is the same secret.
 * @param {Record<string, string|undefined>} env
 * @returns {{ tenantId: string, clientId: string, clientSecret: string, sender: string } | null}
 */
export function graphMailConfig(env = process.env) {
  if (missingGraphMailVars(env).length) return null;
  return {
    tenantId: env.MS_GRAPH_TENANT_ID.trim(),
    clientId: env.MS_GRAPH_CLIENT_ID.trim(),
    clientSecret: env.MS_GRAPH_CLIENT_SECRET.trim(),
    sender: env.MS_GRAPH_SENDER.trim(),
  };
}

/** A failure that carries a closed reason and an HTTP status, and nothing else. */
class GraphFailure extends Error {
  constructor(reason, status = null) {
    super(reason);
    this.reason = reason;
    this.status = status;
  }
}

function asFailure(err, fallbackReason) {
  if (err instanceof GraphFailure) return err;
  if (err?.name === "AbortError" || err?.name === "TimeoutError") return new GraphFailure("graph_timeout");
  return new GraphFailure(fallbackReason);
}

/**
 * One deadline: an AbortSignal for fetch, plus a race for anything that ignores
 * the signal. The race rejects before the abort fires, so a timeout is reported
 * as a timeout rather than as whatever error the aborted fetch throws.
 */
function deadline(ms) {
  const controller = new AbortController();
  let timer = null;
  const expired = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new GraphFailure("graph_timeout"));
      controller.abort();
    }, ms);
  });
  expired.catch(() => {});
  return {
    signal: controller.signal,
    within: (promise) => Promise.race([promise, expired]),
    clear: () => clearTimeout(timer),
  };
}

/** Release a response body that is deliberately not read. */
function discard(response) {
  try {
    const cancelled = response?.body?.cancel?.();
    if (cancelled && typeof cancelled.catch === "function") cancelled.catch(() => {});
  } catch {
    /* nothing to release */
  }
}

/**
 * A sender for one mailbox. Holds the token in memory.
 *
 * @param {{ tenantId: string, clientId: string, clientSecret: string, sender: string }} config
 * @returns {{ send: (mail: { to: string, subject: string, contentType: "Text" | "HTML", content: string }) =>
 *   Promise<{ ok: true, status: number } | { ok: false, reason: string, status: number | null }> }}
 */
export function createGraphMailer(config) {
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`;
  // The address goes into the path as Microsoft documents it, with "@" kept;
  // anything else that could end the segment is escaped.
  const sendUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.sender).replace(/%40/g, "@")}/sendMail`;

  /** @type {{ token: string, expiresAt: number } | null} */
  let cached = null;
  /** @type {Promise<string> | null} */
  let inFlight = null;

  async function requestToken() {
    const budget = deadline(GRAPH_FETCH_TIMEOUT_MS);
    try {
      const response = await budget.within(
        fetch(tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            scope: GRAPH_SCOPE,
            grant_type: "client_credentials",
          }).toString(),
          signal: budget.signal,
        })
      );
      if (!response.ok) {
        discard(response);
        throw new GraphFailure("graph_token_failed", response.status);
      }
      const body = await budget.within(response.json());
      const token = typeof body?.access_token === "string" ? body.access_token : "";
      if (!token) throw new GraphFailure("graph_token_failed", response.status);
      const lifetimeMs = Number(body.expires_in) * 1000;
      const expiresAt = Date.now() + (Number.isFinite(lifetimeMs) ? lifetimeMs : 0) - TOKEN_EARLY_REFRESH_MS;
      return { token, expiresAt };
    } catch (err) {
      throw asFailure(err, "graph_token_failed");
    } finally {
      budget.clear();
    }
  }

  /** The cached token, or the one request already on its way, or a new one. */
  function token() {
    if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.token);
    if (!inFlight) {
      inFlight = requestToken()
        .then((fresh) => {
          cached = fresh;
          return fresh.token;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  /** Never throws. 202 is the only success. No retry here. */
  async function send({ to, subject, contentType, content }) {
    const budget = deadline(GRAPH_FETCH_TIMEOUT_MS);
    let accessToken = null;
    try {
      accessToken = await budget.within(token());
      const response = await budget.within(
        fetch(sendUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: {
              subject,
              body: { contentType, content },
              toRecipients: [{ emailAddress: { address: to } }],
            },
            saveToSentItems: false,
          }),
          signal: budget.signal,
        })
      );
      discard(response);
      if (response.status === 202) return { ok: true, status: 202 };
      // A rejected token is dropped so the next send fetches a new one. Only
      // this one: a newer token fetched meanwhile is kept.
      if (response.status === 401 && cached?.token === accessToken) cached = null;
      return { ok: false, reason: "graph_refused", status: response.status };
    } catch (err) {
      const failure = asFailure(err, accessToken ? "graph_refused" : "graph_token_failed");
      return { ok: false, reason: failure.reason, status: failure.status };
    } finally {
      budget.clear();
    }
  }

  return { send };
}

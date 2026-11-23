// The dashboard's Content-Security-Policy (firebase.json) names the API origin
// literally in connect-src. If VITE_API_URL (or VITE_NUMBER_API_URL) points
// anywhere else — a custom API domain, a preview channel — the browser blocks
// every request and the dashboard looks dead with nothing in the logs. The app
// build calls this and fails instead (vite.config.js).
//
// Local addresses are not checked: a build pointing at localhost is a local
// build and is never deployed.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function connectSources(firebaseJson) {
  const all = firebaseJson?.hosting?.headers?.find((h) => h.source === "**")?.headers || [];
  const csp = all.find((h) => h.key === "Content-Security-Policy")?.value || "";
  const directive = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("connect-src "));
  return directive ? directive.split(/\s+/).slice(1) : [];
}

/**
 * What is wrong with the API address a production app build was given, or null.
 * An unset or local address would ship a dashboard that cannot reach its API.
 * A build for checking on this computer says so with `localBuild`.
 *
 * @param {string|undefined} url  VITE_API_URL
 * @param {{ localBuild?: boolean }} [options]
 * @returns {string|null}
 */
export function apiAddressProblem(url, { localBuild = false } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) {
    return "VITE_API_URL is not set to the dashboard API's address.";
  }
  if (LOCAL_HOSTS.has(new URL(url).hostname) && !localBuild) {
    return "VITE_API_URL points at this computer (a local address). Set the production address, or VETRA_LOCAL_BUILD=1 for a build that is only checked locally.";
  }
  return null;
}

/**
 * @param {object} firebaseJson  parsed firebase.json
 * @param {Array<string|undefined>} urls  the API base URLs the build talks to
 * @returns {string[]} origins the CSP does not allow (empty when all are fine)
 */
export function missingConnectOrigins(firebaseJson, urls) {
  const allowed = new Set(connectSources(firebaseJson));
  const missing = [];
  for (const raw of urls) {
    if (!raw || !/^https?:\/\//i.test(raw)) continue; // unset or relative: same origin
    const url = new URL(raw);
    if (LOCAL_HOSTS.has(url.hostname)) continue;
    if (!allowed.has(url.origin) && !missing.includes(url.origin)) missing.push(url.origin);
  }
  return missing;
}

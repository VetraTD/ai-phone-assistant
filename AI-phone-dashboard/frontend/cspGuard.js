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

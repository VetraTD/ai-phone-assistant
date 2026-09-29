// tests/helpers/trustedCa.js
/**
 * `ca` list for a test that needs a REAL, validated TLS handshake against a
 * local self-signed fixture server (tests/ssrfGuard.test.js,
 * tests/connectionsOutbox.test.js).
 *
 * Passing `tlsOptions.ca` to `connectVetted` (lib/net/ssrfGuard.js)
 * REPLACES Node's default trust store for that request rather than adding
 * to it -- so on a machine running a local TLS-intercepting proxy that
 * re-signs every connection (this repo's own sandbox: Norton Web/Mail
 * Shield), a bare `ca: [fixtureCert]` makes the fixture's own cert the
 * ONLY thing trusted, and the interceptor's re-signed leaf -- which is
 * what actually arrives on the wire -- fails to verify.
 *
 * `NODE_EXTRA_CA_CERTS` is the standard Node mechanism for ADDING a root to
 * the default trust store without replacing it; this helper reunites the
 * two for the one case that bypasses the default store entirely (an
 * explicit `ca` array). Nothing machine-specific is committed: with no
 * `NODE_EXTRA_CA_CERTS` set, or no file at that path, this is exactly the
 * fixture cert(s) alone -- unchanged behaviour on a machine with no
 * intercepting proxy.
 *
 * @param {...(Buffer|string)} fixtureCerts
 * @returns {(Buffer|string)[]}
 */
import fs from "node:fs";
import https from "node:https";

export function trustedCa(...fixtureCerts) {
  const extra = [];
  const p = process.env.NODE_EXTRA_CA_CERTS;
  if (p && fs.existsSync(p)) {
    const text = fs.readFileSync(p, "utf8");
    const matches = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (matches) extra.push(...matches);
  }
  return [...fixtureCerts, ...extra];
}

/**
 * Whether a PLAIN, FULLY-VALIDATED connection (no `ca` override -- Node's
 * own default trust store, plus whatever `NODE_EXTRA_CA_CERTS` adds to it;
 * deliberately NOT routed through `connectVetted`, so this can never be
 * sensitive to `lib/net/ssrfGuard.js`'s own pin) to `hostname:port` would
 * already succeed against a local TLS-intercepting proxy's re-signed leaf.
 *
 * This is the precise condition under which a handshake-based "a caller's
 * rejectUnauthorized:false is never honored" test stops being meaningful:
 * not merely "is something intercepting" (an insecure, always-succeeding
 * probe would report that on every machine running such a proxy, matched
 * root or not, which would skip the test even where it is still perfectly
 * capable of catching a real regression -- e.g. this repo's own sandbox
 * with only the WRONG Norton root in `NODE_EXTRA_CA_CERTS`, where a
 * validated connection still correctly fails and the refusal test still
 * holds), but specifically "would validation ALREADY pass anyway", which
 * only true once the SAME root that is actually re-signing connections is
 * also the one trusted globally. When it is, the connection succeeds
 * whether or not the caller's `rejectUnauthorized:false` was honored --
 * the pin cannot be observed via a handshake at all in that state.
 *
 * @param {{hostname: string, port: number}} o
 * @returns {Promise<string|null>} the trusted-and-intercepting issuer's
 *   CN when a validated connection already succeeds, else null
 */
export function detectInterceptingIssuer({ hostname, port }) {
  return new Promise((resolve) => {
    const req = https.request({ hostname, servername: hostname, port, path: "/", method: "GET", rejectUnauthorized: true }, (res) => {
      const peer = res.socket.getPeerCertificate();
      res.resume();
      resolve(peer?.issuer?.CN ?? "unknown issuer");
    });
    req.on("error", () => resolve(null)); // not already trusted -- the refusal test still holds
    req.end();
  });
}

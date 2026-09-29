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

// lib/net/ssrfGuard.js
/**
 * Shared SSRF guard for the results channel (S3-8, Ruling S3-8a). NOT the
 * same code as `integrations/webhook.js`'s own guard (that one is the
 * synchronous tool-call webhook and is left unchanged -- C10, see this
 * task's report for its gaps). This is the new, shared guard for
 * `lib/connections/outbox.js`.
 *
 * ---------------------------------------------------------------------------
 * The two-phase design, and why it is two functions
 * ---------------------------------------------------------------------------
 * `resolveVettedAddress` resolves a hostname to every A/AAAA record it has
 * ONE TIME and refuses the whole hostname if ANY record is private. It is
 * the only place DNS is ever consulted.
 *
 * `connectVetted` then makes the actual HTTPS request, but NEVER resolves
 * the hostname again -- it is handed the single vetted IP address from the
 * step above and connects to exactly that address, with the request's
 * `Host` header and the TLS SNI (`servername`) both still set to the
 * original hostname. That is what closes DNS rebinding (named risk 2): an
 * attacker's resolver cannot swap the answer between the check and the
 * connect, because there is no second lookup for it to win.
 *
 * They are exported separately (and `fetchVetted` below composes them) so
 * that:
 *   - the private-range classification can be tested with an INJECTED
 *     resolver, no real DNS or network (`tests/ssrfGuard.test.js`);
 *   - the "manual redirect" / timeout / body-delivery behaviour can be
 *     tested against a REAL local HTTPS server bound to 127.0.0.1, without
 *     that address itself being refused as private -- `connectVetted` trusts
 *     the address it is given, by construction, because verification
 *     already happened once, upstream. This is the "local servers /
 *     injected resolvers" split the dispatch notes name.
 * ---------------------------------------------------------------------------
 */
import dns from "node:dns";
import net from "node:net";
import https from "node:https";

export const SSRF_TIMEOUT_MS = 6000;

// C1 (fix round 1): the response body is never used by any real caller
// (lib/connections/outbox.js's attemptDelivery reads only `status`). 8 KiB
// is generous for a status/error body while keeping memory bounded no
// matter how large or how long-running the receiver's response is.
export const MAX_BODY_BYTES = 8 * 1024;

export class SsrfRefusedError extends Error {
  constructor(reason) {
    super(`ssrf_refused:${reason}`);
    this.name = "SsrfRefusedError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// IPv4 classification, including the numeric-literal forms (named risk 1):
// http://2130706433/, http://017700000001/, http://0x7f.1/ all resolve, on
// many platforms' getaddrinfo, to 127.0.0.1 -- a hostname string that never
// LOOKS like an IP to a naive parser. Detected and classified directly here,
// bypassing DNS entirely, so this guard does not depend on whatever the
// host OS's resolver happens to do with them.
// ---------------------------------------------------------------------------

const NUMERIC_PART = "(?:0x[0-9a-f]+|0[0-7]+|0|[1-9]\\d*)";
const NUMERIC_IPV4_RE = new RegExp(`^${NUMERIC_PART}(?:\\.${NUMERIC_PART}){0,3}$`, "i");

/** inet_aton-style shortened/decimal/octal/hex IPv4 literal, or null. */
function parseNumericIPv4(host) {
  if (!NUMERIC_IPV4_RE.test(host)) return null;
  const parts = host.split(".");
  const nums = parts.map((p) => {
    if (/^0x/i.test(p)) return parseInt(p, 16);
    if (/^0[0-7]+$/.test(p)) return parseInt(p, 8);
    return parseInt(p, 10);
  });
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  for (let i = 0; i < nums.length - 1; i++) {
    if (nums[i] > 255) return null;
  }
  const last = nums[nums.length - 1];
  const remainingBits = (4 - (nums.length - 1)) * 8;
  if (last < 0 || last >= 2 ** remainingBits) return null;
  let value = 0;
  for (let i = 0; i < nums.length - 1; i++) value = value * 256 + nums[i];
  value = value * 2 ** remainingBits + last;
  if (value > 0xffffffff) return null;
  return [
    Math.floor(value / 2 ** 24) % 256,
    Math.floor(value / 2 ** 16) % 256,
    Math.floor(value / 2 ** 8) % 256,
    value % 256,
  ];
}

/** Strict dotted-decimal, four parts, each 0-255. Used on values already resolved or already matched, never on raw user input (no octal/hex ambiguity to defend against there). */
function parseIPv4Standard(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

/** @param {number[]} b - 4 bytes */
function isPrivateIPv4Bytes(b) {
  if (b[0] === 0) return true; // 0.0.0.0/8
  if (b[0] === 10) return true; // 10.0.0.0/8
  if (b[0] === 127) return true; // 127.0.0.0/8
  if (b[0] === 169 && b[1] === 254) return true; // 169.254.0.0/16
  if (b[0] === 172 && b[1] >= 16 && b[1] <= 31) return true; // 172.16.0.0/12
  if (b[0] === 192 && b[1] === 168) return true; // 192.168.0.0/16
  if (b[0] === 100 && b[1] >= 64 && b[1] <= 127) return true; // 100.64.0.0/10 (CGNAT)
  // D4 (final review, security): reserved ranges the original list left
  // accepted (as "public").
  if (b[0] === 192 && b[1] === 0 && b[2] === 0) return true; // 192.0.0.0/24 (IETF protocol assignments)
  if (b[0] === 198 && (b[1] === 18 || b[1] === 19)) return true; // 198.18.0.0/15 (benchmarking)
  if (b[0] >= 224) return true; // 224.0.0.0/4 (multicast) + 240.0.0.0/4 (reserved) + 255.255.255.255 (broadcast)
  return false;
}

// ---------------------------------------------------------------------------
// IPv6 classification, including IPv4-mapped forms (named risk 1):
// ::ffff:10.0.0.1 (dotted) and ::ffff:7f00:1 (the same address, hex-group
// form -- no dot in sight) must both be caught. Both normalise to the SAME
// 16-byte array through ipv6ToBytes below, so one check covers both spellings.
// ---------------------------------------------------------------------------

/** Parse any valid textual IPv6 address (with optional embedded dotted IPv4 tail and optional %zone) into 16 bytes, or null. */
function ipv6ToBytes(addrIn) {
  let addr = addrIn.split("%")[0];

  const v4Match = addr.match(/(?:^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Match) {
    const v4 = parseIPv4Standard(v4Match[1]);
    if (!v4) return null;
    const hex1 = (((v4[0] << 8) | v4[1]) >>> 0).toString(16);
    const hex2 = (((v4[2] << 8) | v4[3]) >>> 0).toString(16);
    const sep = addr[v4Match.index] === ":" ? ":" : "";
    addr = addr.slice(0, v4Match.index) + sep + `${hex1}:${hex2}`;
  }

  if (addr === "::") return new Array(16).fill(0);

  const doubleColon = addr.includes("::");
  let headPart = addr;
  let tailPart = "";
  if (doubleColon) {
    const idx = addr.indexOf("::");
    headPart = addr.slice(0, idx);
    tailPart = addr.slice(idx + 2);
  }
  const headGroups = headPart ? headPart.split(":") : [];
  const tailGroups = tailPart ? tailPart.split(":") : [];
  const missing = 8 - (headGroups.length + tailGroups.length);
  if (!doubleColon && missing !== 0) return null;
  if (doubleColon && missing < 0) return null;
  const groups = doubleColon ? [...headGroups, ...new Array(missing).fill("0"), ...tailGroups] : headGroups;
  if (groups.length !== 8) return null;

  const bytes = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

/** @param {number[]} b - 16 bytes */
function isPrivateIPv6Bytes(b) {
  if (b.every((x) => x === 0)) return true; // :: (unspecified)
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1 (loopback)
  // ::ffff:0:0/96 -- IPv4-mapped. Classify the embedded IPv4.
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
    return isPrivateIPv4Bytes(b.slice(12, 16));
  }
  // ::/96 -- deprecated IPv4-compatible (subsumes :: and embeds e.g. 127.0.0.1 as ::7f00:1).
  if (b.slice(0, 12).every((x) => x === 0)) {
    return isPrivateIPv4Bytes(b.slice(12, 16));
  }
  // D4 (final review, security): the other two embedded-IPv4 transition
  // forms. Same rule as the two checks above -- classify the EMBEDDED IPv4,
  // not the prefix itself, so a NAT64/6to4 address wrapping a genuinely
  // public IPv4 is not blanket-refused.
  // 64:ff9b::/96 (NAT64, RFC 6052): bytes 0-11 are the fixed prefix, 12-15 the embedded IPv4.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) {
    return isPrivateIPv4Bytes(b.slice(12, 16));
  }
  // 2002::/16 (6to4, RFC 3056): bytes 0-1 are the fixed prefix, 2-5 the embedded IPv4.
  if (b[0] === 0x20 && b[1] === 0x02) {
    return isPrivateIPv4Bytes(b.slice(2, 6));
  }
  if (b[0] === 0xfc || b[0] === 0xfd) return true; // fc00::/7 (unique local)
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 (link local)
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // fec0::/10 (deprecated site-local)
  return false;
}

/**
 * @param {string} address - as returned by dns.lookup or a literal
 * @param {4|6} family
 * @returns {boolean} true if private/reserved, OR if the address could not
 *   be classified at all -- an address this guard cannot parse is refused,
 *   never let through as a default-permissive "not recognized as private".
 */
function isPrivateAddress(address, family) {
  if (family === 4) {
    const b = parseIPv4Standard(address);
    return b ? isPrivateIPv4Bytes(b) : true;
  }
  if (family === 6) {
    const b = ipv6ToBytes(address);
    return b ? isPrivateIPv6Bytes(b) : true;
  }
  return true;
}

/**
 * Strip the `[...]` brackets the WHATWG URL parser keeps around an IPv6
 * literal host.
 */
function unbracket(host) {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * Resolve `hostname` to ITS OWN address(es) exactly once, and refuse the
 * whole hostname if ANY resolved address is private/reserved (Ruling
 * S3-8a: "refuse if ANY record private"). A literal IP host, or a numeric
 * IPv4 literal (2130706433, 017700000001, 0x7f.1, ...), is classified
 * directly without ever calling the resolver.
 *
 * Uses `dns.lookup` (not `dns.resolve4`/`resolve6`), which is the OS
 * resolver path that also consults the hosts file -- the only way
 * "localhost" (named risk 1) is caught, since a plain DNS query for it
 * would NXDOMAIN rather than answer 127.0.0.1/::1.
 *
 * @param {string} hostnameIn
 * @param {{ resolver?: { lookup: Function } }} [opts] - `resolver.lookup`
 *   matches `dns.lookup`'s callback signature `(hostname, options, cb)`;
 *   injectable so tests never perform a real DNS query.
 * @returns {Promise<{ address: string, family: 4|6 }>}
 */
export async function resolveVettedAddress(hostnameIn, { resolver = dns } = {}) {
  const hostname = unbracket(hostnameIn);
  if (!hostname) throw new SsrfRefusedError("empty_host");

  const literalFamily = net.isIP(hostname);
  let candidates;
  if (literalFamily) {
    candidates = [{ address: hostname, family: literalFamily }];
  } else {
    const numeric = parseNumericIPv4(hostname);
    if (numeric) {
      candidates = [{ address: numeric.join("."), family: 4 }];
    } else {
      candidates = await new Promise((resolve, reject) => {
        resolver.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
          if (err) return reject(err);
          resolve(addresses);
        });
      });
      if (!Array.isArray(candidates) || candidates.length === 0) {
        throw new SsrfRefusedError("no_address");
      }
    }
  }

  for (const c of candidates) {
    if (isPrivateAddress(c.address, c.family)) throw new SsrfRefusedError("private_address");
  }
  // "Connect to the vetted IP" (singular): every candidate already passed,
  // so any one of them is safe to use. The first is as good as any other.
  return candidates[0];
}

/**
 * Make the actual HTTPS request against an ALREADY-VETTED address. Never
 * looks the hostname up again (the `lookup` override below hands the
 * pre-vetted address straight back with no I/O) -- that is what closes DNS
 * rebinding (named risk 2). `Host` and the TLS SNI (`servername`) are both
 * the ORIGINAL hostname, never the IP, so certificate validation and
 * virtual-hosting both work exactly as they would for a normal request to
 * that hostname.
 *
 * `redirect: manual` is not a flag here -- it is the DEFAULT of `https.request`
 * itself, which (unlike `fetch`) never follows a Location header on its own.
 * Any 3xx status is treated as a refusal (named risk 3), not merely returned.
 *
 * @param {{ hostname: string, address: string, family: 4|6, port?: number,
 *   path?: string, method?: string, headers?: object, body?: string,
 *   timeoutMs?: number, tlsOptions?: object }} o
 */
export function connectVetted({
  hostname,
  address,
  family,
  port = 443,
  path = "/",
  method = "POST",
  headers = {},
  body,
  timeoutMs = SSRF_TIMEOUT_MS,
  tlsOptions = {},
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    // An explicit timer, not `options.timeout` (Node's socket-inactivity
    // 'timeout' event) -- that event fires but does not itself abort
    // anything, and this codebase already has one measured case
    // (integrations/webhook.js's own AbortController) where the belt is
    // worth having. A plain timer that destroys the request is simpler to
    // reason about and does not depend on socket-level timeout semantics at
    // all.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Reject HERE, directly -- destroy() below is cleanup, not the
      // signal. The request's own 'error' handler also guards on `settled`
      // (so a subsequent error from the destroyed socket is a no-op, not a
      // second rejection), which means it must never be the ONLY thing that
      // calls reject() for a timeout: this WAS that bug (settled set true
      // here, then the 'error' handler's own guard silently swallowed the
      // reject it would have made -- the promise hung forever, caught by
      // `tests/ssrfGuard.test.js`'s "times out rather than hanging forever").
      reject(new Error("timeout"));
      req.destroy();
    }, timeoutMs);

    const req = https.request(
      {
        // D3 (final review, security; residual fix wave-W2W3-rereview.md):
        // `tlsOptions` spreads FIRST, every field this function itself
        // computes is set AFTER -- so a caller-supplied `tlsOptions` (today:
        // none in production; only this module's own tests, to reach a
        // local self-signed fixture via `ca`) can never clobber
        // `hostname`/`servername`/`lookup`/`rejectUnauthorized`, the fields
        // that close the DNS-rebinding window this guard exists for (see
        // the module doc's "named risk 2") and keep TLS validation itself
        // from being silently switched off. A colliding `tlsOptions.lookup`
        // could otherwise re-point the connection at an address
        // `resolveVettedAddress` never vetted at all; a colliding
        // `tlsOptions.rejectUnauthorized:false` could otherwise accept ANY
        // certificate -- including one for an unrelated host -- from the
        // vetted address's own TLS layer, which no caller in this codebase
        // needs (a real receiver's cert must validate; a test fixture's
        // trust is established with `tlsOptions.ca`, never by turning
        // validation off).
        ...tlsOptions,
        hostname,
        servername: hostname,
        port,
        path,
        method,
        headers,
        // No real lookup: hands back the vetted address synchronously, no
        // I/O. Two shapes on purpose -- Node's `autoSelectFamily` (Happy
        // Eyeballs, on by default since Node 18/20) requests `{all:true}`
        // and expects an ARRAY back; older/non-autoSelectFamily callers
        // expect the classic `(err, address, family)` triple. Both answers
        // describe the exact same single, already-vetted address.
        lookup: (_host, opts, cb) => (opts && opts.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
        rejectUnauthorized: true,
      },
      (res) => {
        const status = res.statusCode;
        const chunks = [];
        let bytes = 0;

        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (status >= 300 && status < 400) {
            reject(new SsrfRefusedError("redirect"));
            return;
          }
          resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
        };

        // C1: the body is never used -- attemptDelivery (lib/connections/
        // outbox.js) reads only `status`, and the contract doc says "we do
        // not read your response body". A receiver (hostile, compromised,
        // or just an honest --url pointed at a large file) that returns a
        // multi-hundred-MB body used to be buffered in full: Buffer.concat
        // + .toString("utf8") threw ERR_STRING_TOO_LONG as an UNCAUGHT
        // exception once the body passed Node's string length limit --
        // with no uncaughtException handler in server.js, that killed the
        // voice service, and Cloud Tasks then retried the same delivery
        // into the same crash. Bounded here at MAX_BODY_BYTES: `chunks`
        // never holds more than the cap regardless of how large a single
        // incoming TCP chunk is (a single `data` event is truncated to fit
        // the remaining room, not pushed whole), and once the cap is
        // exceeded the response is settled immediately (status/headers are
        // already known) and the socket is destroyed rather than left to
        // keep streaming into nothing.
        res.on("data", (d) => {
          if (settled) return;
          if (bytes < MAX_BODY_BYTES) {
            const room = MAX_BODY_BYTES - bytes;
            chunks.push(d.length > room ? d.subarray(0, room) : d);
          }
          bytes += d.length;
          if (bytes > MAX_BODY_BYTES) {
            finish();
            res.destroy();
          }
        });
        res.on("end", finish);
        // Minor 3 (same code, bundled into the C1 fix): with NO listener at
        // all, Node suppresses an error on a stream nobody is watching --
        // a receiver that resets the connection mid-body was silently never
        // observed, and the call sat out the full 6 s timeout instead of
        // failing fast. This listener's only job is to exist: `finish()` (or
        // the timeout) is still what actually settles the promise; a
        // destroyed-after-settled stream erroring out here is expected, not
        // a second event to react to.
        res.on("error", () => {});
      }
    );
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * The composed, production entry point: parse the URL, vet the hostname
 * once, then connect to the vetted address. HTTPS only (the caller's own
 * `webhook_endpoints.url CHECK LIKE 'https://%'` already enforces this at
 * the database level; this is the belt to that braces).
 *
 * @param {string} urlString
 * @param {{ method?: string, headers?: object, body?: string,
 *   timeoutMs?: number, resolver?: object, tlsOptions?: object }} [opts]
 */
export async function fetchVetted(urlString, opts = {}) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new SsrfRefusedError("invalid_url");
  }
  if (parsed.protocol !== "https:") throw new SsrfRefusedError("not_https");

  const hostname = unbracket(parsed.hostname);
  const { address, family } = await resolveVettedAddress(hostname, { resolver: opts.resolver });

  return connectVetted({
    hostname,
    address,
    family,
    port: parsed.port ? Number(parsed.port) : 443,
    path: `${parsed.pathname}${parsed.search}`,
    method: opts.method,
    headers: opts.headers,
    body: opts.body,
    timeoutMs: opts.timeoutMs,
    tlsOptions: opts.tlsOptions,
  });
}

// Exported for tests only (the private-range table is easiest to prove
// correct as a pure function over strings, not through a live connection).
export const _internal = { parseNumericIPv4, parseIPv4Standard, isPrivateIPv4Bytes, ipv6ToBytes, isPrivateIPv6Bytes, isPrivateAddress };

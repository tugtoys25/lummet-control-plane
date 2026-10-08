// =====================================================
// OUTBOUND URL SAFETY (security review 2.1)
//
// Customers supply URLs that this Worker later fetches (webhooks).
// This rejects URLs that point at the machine itself, private or
// link-local networks, cloud metadata addresses, or carry embedded
// credentials. checkOutboundUrl() checks the URL TEXT only. A public
// hostname can still RESOLVE to a private address (DNS rebinding), so
// checkOutboundUrlResolved() (v7E) also resolves the name through DoH
// and rejects the URL if ANY address is private, loopback, link-local,
// metadata or reserved. Remaining gap, stated plainly: Workers resolve
// the name again when they fetch, so a resolver that answers differently
// the second time still gets through that check. What closes it in
// practice is that Workers cannot reach private networks at all, redirects
// are refused (see webhooks.js), and the resolved check runs on EVERY
// delivery attempt, not just when the URL is saved.
// =====================================================

function parseIPv4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function isBlockedIPv4([a, b]) {
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||   // carrier-grade NAT
    (a === 169 && b === 254) ||             // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||               // IETF protocol assignments, TEST-NET-1 lives in 192.0.2
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224                                // multicast, reserved, broadcast
  );
}

function isBlockedIPv6(host) {
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return true;
  if (/^f[cd]/.test(h)) return true;                 // unique local fc00::/7
  if (/^fe[89ab]/.test(h)) return true;              // link-local fe80::/10
  const mapped = h.match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (mapped) {
    if (mapped[1]) { const v4 = parseIPv4(mapped[1]); return !v4 || isBlockedIPv4(v4); }
    const hi = parseInt(mapped[2], 16), lo = parseInt(mapped[3], 16);
    return isBlockedIPv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  return false;
}

/**
 * Returns { ok: true, url } for a URL that is safe to fetch on a
 * customer's behalf, or { ok: false, error } otherwise.
 */
export function checkOutboundUrl(input) {
  let url;
  try { url = new URL(input); } catch (_) { return { ok: false, error: "invalid_url" }; }
  if (url.protocol !== "https:") return { ok: false, error: "url_must_be_https" };
  if (url.username || url.password) return { ok: false, error: "url_credentials_not_allowed" };
  if (url.port && url.port !== "443") return { ok: false, error: "url_port_not_allowed" };

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, error: "invalid_url" };

  if (host.startsWith("[")) {
    if (isBlockedIPv6(host.slice(1, -1))) return { ok: false, error: "url_host_not_allowed" };
    return { ok: true, url };
  }
  const v4 = parseIPv4(host);
  if (v4) return isBlockedIPv4(v4) ? { ok: false, error: "url_host_not_allowed" } : { ok: true, url };

  // The URL parser already normalizes hex/octal/decimal IPv4 forms such as
  // 0x7f.1 or 2130706433 into dotted decimal, so they land in the branch above.
  if (!host.includes(".")) return { ok: false, error: "url_host_not_allowed" };   // localhost, intranet names
  if (/\.(local|localhost|internal|intranet|lan|home|corp)$/.test(host)) return { ok: false, error: "url_host_not_allowed" };
  return { ok: true, url };
}


// ---------------------------------------------------------------------------------------------
// v7E: DNS-aware check
// ---------------------------------------------------------------------------------------------

/** True for an IP literal (v4 or v6) that must never be fetched on a customer's behalf. */
export function isBlockedAddress(ip) {
  const text = String(ip).toLowerCase().replace(/^\[|\]$/g, "");
  const v4 = parseIPv4(text);
  if (v4) return isBlockedIPv4(v4);
  if (!text.includes(":")) return true;                       // not an address at all: refuse
  if (isBlockedIPv6(text)) return true;
  if (/^ff/.test(text)) return true;                          // multicast
  if (/^fe[c-f]/.test(text)) return true;                     // site-local (deprecated)
  if (/^2001:0?db8:/.test(text)) return true;                 // documentation range
  const nat64 = text.match(/^64:ff9b::(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);   // NAT64 embeds an IPv4 address
  if (nat64) {
    if (nat64[1]) { const e = parseIPv4(nat64[1]); return !e || isBlockedIPv4(e); }
    const hi = parseInt(nat64[2], 16), lo = parseInt(nat64[3], 16);
    return isBlockedIPv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  return false;
}

const RESOLVE_CACHE = new Map();       // hostname -> { until, result }, per isolate
const RESOLVE_TTL_MS = 60_000;

/** On in production unless OUTBOUND_DNS_CHECK=off; elsewhere only when OUTBOUND_DNS_CHECK=on. */
export function dnsCheckEnabled(env) {
  const flag = String(env?.OUTBOUND_DNS_CHECK || "").toLowerCase();
  if (flag === "off") return false;
  if (flag === "on") return true;
  return env?.ENVIRONMENT === "production";
}

/**
 * checkOutboundUrl() plus a DNS check. Returns { ok: true, url } or { ok: false, error } where the error is one of
 * the text-check errors, host_resolves_to_blocked_address, host_does_not_resolve or host_lookup_failed.
 * IP-literal hosts need no lookup. env.OUTBOUND_DNS_RESOLVER (hostname -> { ok, addresses }) replaces the real
 * DoH lookup in tests.
 */
export async function checkOutboundUrlResolved(input, env) {
  const text = checkOutboundUrl(input);
  if (!text.ok || !dnsCheckEnabled(env)) return text;
  const host = text.url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || parseIPv4(host)) return text;       // already judged as an address

  const now = Date.now();
  let entry = RESOLVE_CACHE.get(host);
  if (!entry || entry.until < now) {
    const resolver = env?.OUTBOUND_DNS_RESOLVER || (await import("./dns-doh.js")).lookupAddresses;
    entry = { until: now + RESOLVE_TTL_MS, result: await resolver(host) };
    if (RESOLVE_CACHE.size > 500) RESOLVE_CACHE.clear();
    RESOLVE_CACHE.set(host, entry);
  }
  const r = entry.result;
  if (!r || !r.ok) { RESOLVE_CACHE.delete(host); return { ok: false, error: "host_lookup_failed" }; }
  if (!r.addresses.length) return { ok: false, error: "host_does_not_resolve" };
  if (r.addresses.some(isBlockedAddress)) return { ok: false, error: "host_resolves_to_blocked_address" };
  return text;
}

/** Test hook: forget cached lookups. */
export function clearResolveCache() { RESOLVE_CACHE.clear(); }

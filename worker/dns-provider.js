// =====================================================
// DNS RESOLVER INTERFACE (master prompt section 20)
//
// domains.js is written against this contract only —
// dns-doh.js is the real implementation (DNS-over-HTTPS, no
// third-party SDK); tests substitute a fake resolver
// (test/support/fake-dns-resolver.js). Kept separate from
// infra-provider.js because DNS-over-HTTPS is an unauthenticated
// public API, not a Cloudflare-account-scoped one — a
// different concern with a different failure mode.
// =====================================================

/**
 * @typedef {Object} DnsResolver
 * @property {(hostname: string) => Promise<string[]>} lookupTXT
 *   Returns the TXT record values found for `hostname` (empty
 *   array if none, or on any resolution failure — domain
 *   verification treats "no records found" and "lookup failed"
 *   identically: not yet verified, safe to retry).
 *
 * @property {(hostname: string) => Promise<{ok: boolean, nameServers?: string[]}>} lookupNS
 *   (v1) The nameservers public DNS currently answers for a domain, lower case without the trailing dot.
 *   { ok: false } when the lookup failed. Progress display only; never proof that a zone is active.
 *
 * @property {(hostname: string) => Promise<{ok: boolean, targets?: string[]}>} lookupCNAME
 *   (v1.1) The CNAME targets public DNS answers for a hostname. Progress display only.
 */
export const CONTRACT_VERSION = 1;

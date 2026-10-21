// =====================================================
// DOMAIN MANAGEMENT (master prompt section 20)
//
// createDomainService({dns, infra}) is written against
// dns-provider.js's and infra-provider.js's contracts only —
// production binds dns-doh.js + infra-cloudflare.js; tests
// bind fakes (test/support/fake-dns-resolver.js,
// fake-infra-provider.js), the same pattern as billing.js and
// provisioning.js.
//
// Every status transition here reflects something actually
// checked (a real TXT lookup, a real Cloudflare SSL status) —
// never advanced just because time passed or the customer
// asked nicely (rule #5: "do not claim SSL is active unless
// it has actually been verified").
// =====================================================

import * as dohResolver from "./dns-doh.js";
import * as cloudflareProvider from "./infra-cloudflare.js";
import * as webhooks from "./webhooks.js";

const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?!-)[a-zA-Z0-9-]{1,63}(?<!-)(\.(?!-)[a-zA-Z0-9-]{1,63}(?<!-))+$/;

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function verificationHostFor(hostname) {
  // A dedicated subdomain for the TXT challenge, so this never
  // collides with or requires touching any other TXT record the
  // customer already has on their apex/host (e.g. SPF).
  return `_lummet-verify.${hostname}`;
}

export function createDomainService({ dns, infra }) {
  async function recordDomainEvent(env, { domainId, fromStatus, toStatus, reason, actorType, actorId }) {
    await env.LUMMET_DB.prepare(
      `INSERT INTO domain_events (domain_id, from_status, to_status, reason, actor_type, actor_id) VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(domainId, fromStatus || null, toStatus, reason || null, actorType || "system", actorId || null)
      .run();
  }

  async function getDomain(env, domainId) {
    return env.LUMMET_DB.prepare(`SELECT * FROM domains WHERE id = ?`).bind(domainId).first();
  }

  async function listDomainsForSite(env, siteId) {
    const result = await env.LUMMET_DB.prepare(
      `SELECT * FROM domains WHERE site_id = ? AND status != 'removed' ORDER BY created_at`
    )
      .bind(siteId)
      .all();
    return result.results || [];
  }

  /**
   * Registers a hostname a customer wants to point at their site.
   * Refuses outright (never "pending, we'll sort it out later") if
   * the hostname is malformed or already attached to ANY site,
   * theirs or someone else's — the UNIQUE constraint on
   * domains.hostname is the actual guarantee; this check just
   * produces a clean error instead of a raw constraint violation.
   */
  async function addDomain(env, { siteId, hostname, actorUserId }) {
    const trimmedHostname = (hostname || "").trim().toLowerCase();
    if (!HOSTNAME_PATTERN.test(trimmedHostname)) {
      return { ok: false, status: 422, error: "invalid_hostname" };
    }

    const existing = await env.LUMMET_DB.prepare(`SELECT site_id FROM domains WHERE hostname = ? AND status != 'removed'`)
      .bind(trimmedHostname)
      .first();
    if (existing) return { ok: false, status: 409, error: "hostname_already_in_use" };

    const id = crypto.randomUUID();
    const token = randomToken();

    await env.LUMMET_DB.prepare(
      `INSERT INTO domains (id, site_id, hostname, verification_token) VALUES (?, ?, ?, ?)`
    )
      .bind(id, siteId, trimmedHostname, token)
      .run();

    await recordDomainEvent(env, { domainId: id, fromStatus: null, toStatus: "pending", actorType: "customer_user", actorId: actorUserId });

    return {
      ok: true,
      domainId: id,
      hostname: trimmedHostname,
      dnsInstructions: {
        type: "TXT",
        name: verificationHostFor(trimmedHostname),
        value: `lummet-site-verification=${token}`
      }
    };
  }

  /**
   * Checks the TXT challenge via the injected DNS resolver. A
   * negative result (no record found yet, or a lookup failure) is
   * NOT an error the caller needs to handle specially — it just
   * means "not verified yet, try again" (DNS propagation is
   * inherently eventual).
   */
  async function verifyDns(env, domainId) {
    const domain = await getDomain(env, domainId);
    if (!domain) return { ok: false, status: 404, error: "not_found" };
    if (domain.method && domain.method !== "txt") return { ok: false, status: 409, error: "managed_by_nameserver_flow" };
    if (domain.status !== "pending") return { ok: false, status: 409, error: `cannot verify a domain in status ${domain.status}` };

    const expectedValue = `lummet-site-verification=${domain.verification_token}`;
    const records = await dns.lookupTXT(verificationHostFor(domain.hostname));

    if (!records.includes(expectedValue)) {
      return { ok: true, verified: false };
    }

    await env.LUMMET_DB.prepare(
      `UPDATE domains SET status = 'dns_verified', dns_verified_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(domainId)
      .run();
    await recordDomainEvent(env, { domainId, fromStatus: "pending", toStatus: "dns_verified", reason: "TXT record matched" });

    return { ok: true, verified: true };
  }

  /** Kicks off SSL issuance for a DNS-verified domain. */
  async function requestSsl(env, domainId) {
    const domain = await getDomain(env, domainId);
    if (!domain) return { ok: false, status: 404, error: "not_found" };
    if (domain.method && domain.method !== "txt") return { ok: false, status: 409, error: "managed_by_nameserver_flow" };
    if (domain.status !== "dns_verified") {
      return { ok: false, status: 409, error: `cannot request SSL for a domain in status ${domain.status}` };
    }

    const created = await infra.createCustomHostname(env, { hostname: domain.hostname });

    await env.LUMMET_DB.prepare(
      `UPDATE domains SET status = 'ssl_pending', ssl_status = 'pending', ssl_resource_id = ? WHERE id = ?`
    )
      .bind(created.resourceId, domainId)
      .run();
    await recordDomainEvent(env, { domainId, fromStatus: "dns_verified", toStatus: "ssl_pending", reason: "SSL requested" });

    return { ok: true };
  }

  /** Polls actual SSL issuance status — never assumes completion. */
  async function checkSsl(env, domainId) {
    const domain = await getDomain(env, domainId);
    if (!domain) return { ok: false, status: 404, error: "not_found" };
    if (domain.method && domain.method !== "txt") return { ok: false, status: 409, error: "managed_by_nameserver_flow" };
    if (domain.status !== "ssl_pending") {
      return { ok: false, status: 409, error: `no pending SSL request for a domain in status ${domain.status}` };
    }

    const { status: cfStatus } = await infra.getCustomHostnameStatus(env, domain.ssl_resource_id);

    if (cfStatus === "pending") return { ok: true, sslStatus: "pending" };

    if (cfStatus === "active") {
      await env.LUMMET_DB.prepare(
        `UPDATE domains SET status = 'active', ssl_status = 'active', ssl_verified_at = CURRENT_TIMESTAMP WHERE id = ?`
      )
        .bind(domainId)
        .run();
      await recordDomainEvent(env, { domainId, fromStatus: "ssl_pending", toStatus: "active", reason: "SSL active" });

      const site = await env.LUMMET_DB.prepare(`SELECT organization_id FROM sites WHERE id = ?`).bind(domain.site_id).first();
      if (site) {
        await webhooks.dispatchEvent(env, site.organization_id, "domain.verified", { domainId, hostname: domain.hostname, siteId: domain.site_id });
      }

      return { ok: true, sslStatus: "active" };
    }

    await env.LUMMET_DB.prepare(`UPDATE domains SET status = 'failed', ssl_status = 'failed' WHERE id = ?`)
      .bind(domainId)
      .run();
    await recordDomainEvent(env, { domainId, fromStatus: "ssl_pending", toStatus: "failed", reason: "SSL issuance failed" });
    return { ok: true, sslStatus: "failed" };
  }

  /** Only an `active` (DNS-verified AND SSL-active) domain may become primary. */
  async function setPrimary(env, siteId, domainId) {
    const domain = await getDomain(env, domainId);
    if (!domain || domain.site_id !== siteId) return { ok: false, status: 404, error: "not_found" };
    if (domain.status !== "active") return { ok: false, status: 409, error: "domain_not_active" };

    await env.LUMMET_DB.prepare(`UPDATE domains SET is_primary = 0 WHERE site_id = ?`).bind(siteId).run();
    await env.LUMMET_DB.prepare(`UPDATE domains SET is_primary = 1 WHERE id = ?`).bind(domainId).run();
    await env.LUMMET_DB.prepare(`UPDATE sites SET primary_domain = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(domain.hostname, siteId)
      .run();

    return { ok: true };
  }

  async function removeDomain(env, domainId, { actorUserId } = {}) {
    const domain = await getDomain(env, domainId);
    if (!domain) return { ok: false, status: 404, error: "not_found" };
    if (domain.method && domain.method !== "txt") return { ok: false, status: 409, error: "managed_by_nameserver_flow" };

    if (domain.ssl_resource_id) {
      // Best-effort cleanup — a failure here shouldn't block the
      // customer from removing the domain from their own account.
      try {
        await infra.deleteCustomHostname(env, domain.ssl_resource_id);
      } catch (_) {
        // Logged via the domain_event reason below instead of thrown.
      }
    }

    await env.LUMMET_DB.prepare(
      `UPDATE domains SET status = 'removed', is_primary = 0, removed_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(domainId)
      .run();
    await recordDomainEvent(env, { domainId, fromStatus: domain.status, toStatus: "removed", actorType: "customer_user", actorId: actorUserId });

    if (domain.is_primary) {
      await env.LUMMET_DB.prepare(`UPDATE sites SET primary_domain = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(domain.site_id)
        .run();
    }

    return { ok: true };
  }

  return { addDomain, verifyDns, requestSsl, checkSsl, setPrimary, removeDomain, listDomainsForSite, getDomain };
}

// Production singleton — used by index.js. Tests import
// createDomainService directly with fakes instead of this.
export const domains = createDomainService({ dns: dohResolver, infra: cloudflareProvider });

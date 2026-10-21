// =====================================================
// SITE DASHBOARD ADMINISTRATOR (v7G)
//
// A newly provisioned site has no administrator, so a customer could not edit any content. This lets an organization
// admin set the password of THEIR OWN login to the site's dashboard from the portal.
//
// How, and why it is safe enough:
//   * The login is the customer's own verified portal email, role admin on that site, nothing else.
//   * The password is hashed here in the tenant's own format (PBKDF2-SHA256, 100k iterations, "salt:hash" in hex) and only the
//     HASH is written, to the site's own D1 through Cloudflare's query API with bound parameters. The password is not stored,
//     logged or audited; the hash is not audited either.
//   * Setting it again replaces the hash and signs that account out everywhere on the site (its sessions are deleted).
//   * Only organization admins and owners of the site's organization may do it, for a site that is live.
// =====================================================
import * as sites from "./sites.js";
import * as cloudflareProvider from "./infra-cloudflare.js";
import * as resourcesRepo from "./repositories/site-resources.js";

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** The tenant's lummet-tenant/en/worker/auth.js hashPassword(), reproduced. A test verifies them against each other. */
export async function hashTenantPassword(password, { salt = crypto.getRandomValues(new Uint8Array(16)) } = {}) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return `${hex(salt)}:${hex(new Uint8Array(bits))}`;
}

export function createTenantAdminService(infra) {
  /**
   * @returns {{ok: true, email: string} | {ok: false, status: number, error: string}}
   */
  async function setDashboardPassword(env, { siteId, organizationId, email, password }) {
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      return { ok: false, status: 422, error: "password_length" };
    }
    if (typeof email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
      return { ok: false, status: 422, error: "invalid_email" };
    }

    const site = await sites.getSite(env, siteId);
    if (!site || site.organization_id !== organizationId) return { ok: false, status: 404, error: "not_found" };
    if (site.status !== "active" || !site.tenant_id) return { ok: false, status: 409, error: "site_not_live" };

    const d1 = await resourcesRepo.findActiveResource(env, siteId, "d1");
    if (!d1) return { ok: false, status: 409, error: "site_has_no_database" };

    const passwordHash = await hashTenantPassword(password);
    const normalized = email.trim().toLowerCase();
    try {
      await infra.runD1Query(env, {
        databaseId: d1.resource_id,
        sql: `INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'admin')
              ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, role = 'admin', updated_at = CURRENT_TIMESTAMP`,
        params: [normalized, passwordHash]
      });
      await infra.runD1Query(env, {
        databaseId: d1.resource_id,
        sql: `DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)`,
        params: [normalized]
      });
    } catch (error) {
      // The provider's message can echo SQL or ids; the customer gets a generic answer, the audit log gets the reason.
      return { ok: false, status: 502, error: "site_database_unavailable", detail: String(error?.message || error).slice(0, 200) };
    }
    return { ok: true, email: normalized };
  }

  return { setDashboardPassword };
}

const bound = createTenantAdminService(cloudflareProvider);
export const setDashboardPassword = bound.setDashboardPassword;

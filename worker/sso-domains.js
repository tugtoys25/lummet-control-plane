// =====================================================
// SSO EMAIL-DOMAIN OWNERSHIP
//
// An organization's identity provider is only trusted for email addresses in
// domains the organization has proven it controls, by publishing
//   _lummet-sso.<domain>  TXT  "lummet-sso-verification=<token>"
// Only one organization can hold a given verified domain. Without this, an
// organization admin running their own IdP could create accounts for any address
// that has no account yet (squatting it before its real owner signs up).
// =====================================================
import { lookupTXT } from "./dns-doh.js";
import * as repo from "./repositories/sso-domains.js";

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const txtHostFor = (domain) => `_lummet-sso.${domain}`;
export const txtValueFor = (token) => `lummet-sso-verification=${token}`;

function randomToken() {
  return [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function normalizeDomain(input) {
  const d = String(input || "").trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
  return DOMAIN_RE.test(d) ? d : null;
}

export async function addSsoDomain(env, organizationId, input) {
  const domain = normalizeDomain(input);
  if (!domain) return { ok: false, status: 422, error: "invalid_domain" };
  if (await repo.find(env, organizationId, domain)) return { ok: false, status: 409, error: "domain_already_added" };
  if (await repo.findVerifiedOwner(env, domain)) return { ok: false, status: 409, error: "domain_claimed_by_another_organization" };
  const id = crypto.randomUUID(), token = randomToken();
  await repo.insert(env, { id, organizationId, domain, token });
  return { ok: true, id, domain, txtHost: txtHostFor(domain), txtValue: txtValueFor(token) };
}

export async function listSsoDomains(env, organizationId) {
  const rows = await repo.listFor(env, organizationId);
  return rows.map((r) => ({ id: r.id, domain: r.domain, status: r.status, verifiedAt: r.verified_at,
    ...(r.status === "pending" ? { txtHost: txtHostFor(r.domain), txtValue: txtValueFor(r.verification_token) } : {}) }));
}

export async function verifySsoDomain(env, organizationId, domainId, { lookup = lookupTXT } = {}) {
  const row = await repo.getForOrganization(env, domainId, organizationId);
  if (!row) return { ok: false, status: 404, error: "not_found" };
  if (row.status === "verified") return { ok: true, verified: true };
  const records = await lookup(txtHostFor(row.domain));
  if (!records.includes(txtValueFor(row.verification_token))) return { ok: true, verified: false };
  try {
    await repo.markVerified(env, row.id);
  } catch (_) {
    return { ok: false, status: 409, error: "domain_claimed_by_another_organization" };      // lost a race for the same domain
  }
  return { ok: true, verified: true };
}

export async function removeSsoDomain(env, organizationId, domainId) {
  return (await repo.remove(env, domainId, organizationId)) ? { ok: true } : { ok: false, status: 404, error: "not_found" };
}

/** True when the email's domain is verified for THIS organization. */
export async function emailDomainAllowed(env, organizationId, email) {
  const domain = String(email || "").split("@").pop().toLowerCase();
  return repo.isVerifiedFor(env, organizationId, domain);
}

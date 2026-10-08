// Verified email domains for organization SSO. (Repository.)

export async function find(env, organizationId, domain) {
  return env.LUMMET_DB.prepare(`SELECT id FROM organization_sso_domains WHERE organization_id = ? AND domain = ?`).bind(organizationId, domain).first();
}
export async function findVerifiedOwner(env, domain) {
  return env.LUMMET_DB.prepare(`SELECT organization_id FROM organization_sso_domains WHERE domain = ? AND status = 'verified'`).bind(domain).first();
}
export async function insert(env, { id, organizationId, domain, token }) {
  await env.LUMMET_DB.prepare(`INSERT INTO organization_sso_domains (id, organization_id, domain, verification_token) VALUES (?, ?, ?, ?)`).bind(id, organizationId, domain, token).run();
}
export async function listFor(env, organizationId) {
  return (await env.LUMMET_DB.prepare(`SELECT id, domain, status, verification_token, verified_at FROM organization_sso_domains WHERE organization_id = ? ORDER BY created_at`).bind(organizationId).all()).results;
}
export async function getForOrganization(env, domainId, organizationId) {
  return env.LUMMET_DB.prepare(`SELECT * FROM organization_sso_domains WHERE id = ? AND organization_id = ?`).bind(domainId, organizationId).first();
}
/** Throws if another organization already holds the verified domain (unique index). */
export async function markVerified(env, domainId) {
  await env.LUMMET_DB.prepare(`UPDATE organization_sso_domains SET status = 'verified', verified_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(domainId).run();
}
export async function remove(env, domainId, organizationId) {
  const r = await env.LUMMET_DB.prepare(`DELETE FROM organization_sso_domains WHERE id = ? AND organization_id = ?`).bind(domainId, organizationId).run();
  return !!r.meta.changes;
}
export async function isVerifiedFor(env, organizationId, domain) {
  return !!(await env.LUMMET_DB.prepare(`SELECT 1 AS ok FROM organization_sso_domains WHERE organization_id = ? AND domain = ? AND status = 'verified'`).bind(organizationId, domain).first());
}

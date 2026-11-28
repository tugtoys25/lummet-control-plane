// Customer-owned Cloudflare hosting (migration 0111): every SQL statement the feature needs.
// Secret values are only ever stored encrypted (custom_hosting_secrets); nothing here returns a decrypted value.

const now = () => new Date().toISOString();

// ---------------------------------------------------------------- accounts

export async function listAccounts(env, organizationId) {
  return (await env.LUMMET_DB.prepare(
    `SELECT a.*, (SELECT COUNT(*) FROM site_custom_hosting h JOIN sites s ON s.id = h.site_id WHERE h.account_ref = a.id AND s.status NOT IN ('deleted')) AS site_count
     FROM customer_cloudflare_accounts a WHERE a.organization_id = ? ORDER BY a.created_at, a.id`
  ).bind(organizationId).all()).results || [];
}

export async function getAccount(env, organizationId, id) {
  return env.LUMMET_DB.prepare(`SELECT * FROM customer_cloudflare_accounts WHERE id = ? AND organization_id = ?`).bind(id, organizationId).first();
}

/** By id only: used by deploy jobs, which already hold the site (and so the organization) the account belongs to. */
export async function getAccountById(env, id) {
  return env.LUMMET_DB.prepare(`SELECT * FROM customer_cloudflare_accounts WHERE id = ?`).bind(id).first();
}

export async function findAccountByCfId(env, organizationId, cfAccountId) {
  return env.LUMMET_DB.prepare(`SELECT * FROM customer_cloudflare_accounts WHERE organization_id = ? AND cf_account_id = ?`).bind(organizationId, cfAccountId).first();
}

export async function countAccounts(env, organizationId) {
  return (await env.LUMMET_DB.prepare(`SELECT COUNT(*) AS n FROM customer_cloudflare_accounts WHERE organization_id = ?`).bind(organizationId).first())?.n || 0;
}

export async function insertAccount(env, row) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO customer_cloudflare_accounts (id, organization_id, label, cf_account_id, token_hint, r2_access_key_id, r2_jurisdiction, email_from, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(row.id, row.organizationId, row.label, row.cfAccountId, row.tokenHint || null, row.r2AccessKeyId || null, row.r2Jurisdiction || "default", row.emailFrom || null, row.createdBy || null).run();
}

const ACCOUNT_COLUMNS = new Set(["label", "token_hint", "r2_access_key_id", "r2_jurisdiction", "email_from", "workers_subdomain", "status", "permissions", "last_verified_at", "last_error", "health_checked_at", "health_alert_state", "health_alerted_at", "cf_account_name"]);
export async function patchAccount(env, id, patch) {
  const keys = Object.keys(patch).filter((k) => ACCOUNT_COLUMNS.has(k));
  if (!keys.length) return;
  await env.LUMMET_DB.prepare(`UPDATE customer_cloudflare_accounts SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .bind(...keys.map((k) => patch[k]), now(), id).run();
}

export async function deleteAccount(env, organizationId, id) {
  await env.LUMMET_DB.batch([
    env.LUMMET_DB.prepare(`DELETE FROM custom_hosting_secrets WHERE owner_type = 'account' AND owner_id = ? AND organization_id = ?`).bind(id, organizationId),
    env.LUMMET_DB.prepare(`DELETE FROM customer_cloudflare_accounts WHERE id = ? AND organization_id = ?`).bind(id, organizationId)
  ]);
}

/** Sites (not deleted) that run on, or are being moved to, this account. */
export async function sitesUsingAccount(env, accountId) {
  const hosted = (await env.LUMMET_DB.prepare(
    `SELECT s.id, s.name, s.status FROM site_custom_hosting h JOIN sites s ON s.id = h.site_id WHERE h.account_ref = ? AND s.status != 'deleted'`
  ).bind(accountId).all()).results || [];
  const moving = (await env.LUMMET_DB.prepare(
    `SELECT s.id, s.name, s.status FROM site_hosting_transfers t JOIN sites s ON s.id = t.site_id WHERE t.account_ref = ? AND t.status IN ('queued', 'running') AND s.status != 'deleted'`
  ).bind(accountId).all()).results || [];
  const seen = new Set();
  return [...hosted, ...moving].filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
}

// ---------------------------------------------------------------- secrets (encrypted values only)

export async function getSecretRow(env, ownerType, ownerId, name) {
  return env.LUMMET_DB.prepare(`SELECT * FROM custom_hosting_secrets WHERE owner_type = ? AND owner_id = ? AND name = ?`).bind(ownerType, ownerId, name).first();
}

export async function listSecretRows(env, ownerType, ownerId) {
  return (await env.LUMMET_DB.prepare(`SELECT * FROM custom_hosting_secrets WHERE owner_type = ? AND owner_id = ? ORDER BY name`).bind(ownerType, ownerId).all()).results || [];
}

/** Writes one encrypted value. The row id is chosen by the caller (it is part of the encryption's associated data). */
export async function upsertSecretRow(env, { id, organizationId, ownerType, ownerId, name, isSecret = true, encryptedSecret, secretIv, hint = null }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO custom_hosting_secrets (id, organization_id, owner_type, owner_id, name, is_secret, encrypted_secret, secret_iv, hint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_type, owner_id, name) DO UPDATE SET is_secret = excluded.is_secret, encrypted_secret = excluded.encrypted_secret,
       secret_iv = excluded.secret_iv, hint = excluded.hint, updated_at = CURRENT_TIMESTAMP`
  ).bind(id, organizationId, ownerType, ownerId, name, isSecret ? 1 : 0, encryptedSecret, secretIv, hint).run();
}

export async function deleteSecretRow(env, ownerType, ownerId, name) {
  await env.LUMMET_DB.prepare(`DELETE FROM custom_hosting_secrets WHERE owner_type = ? AND owner_id = ? AND name = ?`).bind(ownerType, ownerId, name).run();
}

// ---------------------------------------------------------------- site hosting

export async function getSiteHosting(env, siteId) {
  return env.LUMMET_DB.prepare(`SELECT * FROM site_custom_hosting WHERE site_id = ?`).bind(siteId).first();
}

export async function listSiteHostingForOrg(env, organizationId) {
  return (await env.LUMMET_DB.prepare(
    `SELECT h.*, s.name AS site_name, s.status AS site_status, s.primary_domain, a.label AS account_label, a.cf_account_id
     FROM site_custom_hosting h JOIN sites s ON s.id = h.site_id LEFT JOIN customer_cloudflare_accounts a ON a.id = h.account_ref
     WHERE h.organization_id = ? AND s.status != 'deleted' ORDER BY s.created_at`
  ).bind(organizationId).all()).results || [];
}

export async function hostnameTaken(env, hostname, exceptSiteId = null) {
  const row = await env.LUMMET_DB.prepare(
    `SELECT h.site_id FROM site_custom_hosting h JOIN sites s ON s.id = h.site_id WHERE h.hostname = ? AND s.status != 'deleted' AND h.site_id != ?`
  ).bind(hostname, exceptSiteId || "").first();
  return !!row;
}

export async function insertSiteHosting(env, row) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO site_custom_hosting (site_id, organization_id, account_ref, status, landing, hostname, zone_id, zone_name, domain_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(row.siteId, row.organizationId, row.accountRef, row.status || "pending", row.landing, row.hostname || null, row.zoneId || null, row.zoneName || null, row.hostname ? "pending" : "none").run();
}

const HOSTING_COLUMNS = new Set(["status", "landing", "hostname", "zone_id", "zone_name", "domain_status", "domain_error", "turnstile_sitekey", "last_error", "account_ref", "enforced_state", "enforced_at", "enforce_error"]);
export async function patchSiteHosting(env, siteId, patch) {
  const keys = Object.keys(patch).filter((k) => HOSTING_COLUMNS.has(k));
  if (!keys.length) return;
  await env.LUMMET_DB.prepare(`UPDATE site_custom_hosting SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE site_id = ?`)
    .bind(...keys.map((k) => patch[k]), now(), siteId).run();
}

export async function deleteSiteHosting(env, siteId) {
  await env.LUMMET_DB.prepare(`DELETE FROM site_custom_hosting WHERE site_id = ?`).bind(siteId).run();
}

/** Removes a site row that was written moments ago, when its hosting record could not be (the create is then refused as a whole). */
export async function deletePendingSite(env, siteId) {
  await env.LUMMET_DB.prepare(`DELETE FROM sites WHERE id = ? AND status = 'pending' AND tenant_id IS NULL`).bind(siteId).run();
}

/** The site's slug-based resource names come from sites.slug; this only writes the site's public address. */
export async function setSitePrimaryDomain(env, siteId, host) {
  await env.LUMMET_DB.prepare(`UPDATE sites SET primary_domain = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(host, siteId).run();
}

/** A moved site answers on a new address: the registry's host and API base follow it (same shape createTenant writes). */
export async function setTenantHost(env, tenantId, host) {
  await env.LUMMET_DB.prepare(`UPDATE tenants SET host = ?, api_base_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(host, `https://${host}`, tenantId).run();
}

export async function tenantHostTaken(env, host, exceptTenantId) {
  return !!(await env.LUMMET_DB.prepare(`SELECT id FROM tenants WHERE host = ? AND id != ?`).bind(host, exceptTenantId || "").first());
}

/** A site's active provider resources of one type, newest first (route, worker, d1, kv, r2, worker_domain). */
export async function activeResourceRow(env, siteId, type) {
  return env.LUMMET_DB.prepare(`SELECT * FROM site_resources WHERE site_id = ? AND resource_type = ? AND status = 'active'`).bind(siteId, type).first();
}

export async function listActiveResources(env, siteId) {
  return (await env.LUMMET_DB.prepare(`SELECT * FROM site_resources WHERE site_id = ? AND status = 'active'`).bind(siteId).all()).results || [];
}

/** Records (or re-activates) one resource of a site. Same upsert as provisioning uses. */
export async function saveResource(env, { siteId, provider = "cloudflare", type, resourceId, resourceName, metadata = null }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO site_resources (site_id, provider, resource_type, resource_id, resource_name, metadata)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(site_id, resource_type) DO UPDATE SET resource_id = excluded.resource_id, resource_name = excluded.resource_name,
       metadata = excluded.metadata, status = 'active', deleted_at = NULL`
  ).bind(siteId, provider, type, resourceId, resourceName, metadata ? JSON.stringify(metadata) : null).run();
}

export async function markResourceDeleted(env, siteId, type) {
  await env.LUMMET_DB.prepare(`UPDATE site_resources SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE site_id = ? AND resource_type = ? AND status = 'active'`).bind(siteId, type).run();
}

// ---------------------------------------------------------------- staff access

export async function getOrgAccess(env, organizationId) {
  return env.LUMMET_DB.prepare(`SELECT * FROM custom_hosting_org_access WHERE organization_id = ?`).bind(organizationId).first();
}

export async function setOrgAccess(env, { organizationId, mode, note, updatedBy }) {
  if (mode === "default") {
    await env.LUMMET_DB.prepare(`DELETE FROM custom_hosting_org_access WHERE organization_id = ?`).bind(organizationId).run();
    return;
  }
  await env.LUMMET_DB.prepare(
    `INSERT INTO custom_hosting_org_access (organization_id, mode, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(organization_id) DO UPDATE SET mode = excluded.mode, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).bind(organizationId, mode, note || null, updatedBy || null, now()).run();
}

export async function listOrgAccess(env) {
  return (await env.LUMMET_DB.prepare(
    `SELECT x.*, o.name AS organization_name FROM custom_hosting_org_access x LEFT JOIN organizations o ON o.id = x.organization_id ORDER BY x.updated_at DESC`
  ).all()).results || [];
}

export async function findOrganization(env, idOrName) {
  return env.LUMMET_DB.prepare(`SELECT id, name, status FROM organizations WHERE id = ? OR lower(name) = lower(?) LIMIT 1`).bind(idOrName, idOrName).first();
}

/** Staff overview: every custom-hosted site with its account and organization (no secrets). */
export async function listAllHostedSites(env, { limit = 200 } = {}) {
  return (await env.LUMMET_DB.prepare(
    `SELECT h.site_id, h.status, h.landing, h.hostname, h.domain_status, h.last_error, h.updated_at, s.name AS site_name, s.status AS site_status,
            s.primary_domain, s.app_version, o.id AS organization_id, o.name AS organization_name, a.label AS account_label, a.cf_account_id, a.status AS account_status
     FROM site_custom_hosting h JOIN sites s ON s.id = h.site_id LEFT JOIN organizations o ON o.id = h.organization_id
     LEFT JOIN customer_cloudflare_accounts a ON a.id = h.account_ref WHERE s.status != 'deleted' ORDER BY h.updated_at DESC LIMIT ?`
  ).bind(limit).all()).results || [];
}

export async function countAllAccounts(env) {
  return (await env.LUMMET_DB.prepare(`SELECT status, COUNT(*) AS n FROM customer_cloudflare_accounts GROUP BY status`).all()).results || [];
}

export async function listRecentTransfers(env, { limit = 50, organizationId = null } = {}) {
  const where = organizationId ? `WHERE t.organization_id = ?` : ``;
  const stmt = env.LUMMET_DB.prepare(
    `SELECT t.id, t.site_id, t.organization_id, t.status, t.landing, t.hostname, t.source_host, t.old_copy_status, t.error_message, t.created_at, t.updated_at,
            t.completed_at, t.job_id, s.name AS site_name, o.name AS organization_name
     FROM site_hosting_transfers t LEFT JOIN sites s ON s.id = t.site_id LEFT JOIN organizations o ON o.id = t.organization_id ${where}
     ORDER BY t.created_at DESC LIMIT ?`
  );
  return (await (organizationId ? stmt.bind(organizationId, limit) : stmt.bind(limit)).all()).results || [];
}

// ---------------------------------------------------------------- transfers

export async function insertTransfer(env, row) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO site_hosting_transfers (id, site_id, organization_id, account_ref, job_id, status, landing, hostname, zone_id, zone_name, source_host, requested_by, progress)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, '{}')`
  ).bind(row.id, row.siteId, row.organizationId, row.accountRef, row.jobId || null, row.landing, row.hostname || null, row.zoneId || null, row.zoneName || null, row.sourceHost || null, row.requestedBy || null).run();
}

export async function getTransfer(env, id) {
  return env.LUMMET_DB.prepare(`SELECT * FROM site_hosting_transfers WHERE id = ?`).bind(id).first();
}

export async function getTransferByJob(env, jobId) {
  return env.LUMMET_DB.prepare(`SELECT * FROM site_hosting_transfers WHERE job_id = ?`).bind(jobId).first();
}

export async function openTransferForSite(env, siteId) {
  return env.LUMMET_DB.prepare(`SELECT * FROM site_hosting_transfers WHERE site_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`).bind(siteId).first();
}

export async function latestTransferForSite(env, siteId) {
  return env.LUMMET_DB.prepare(`SELECT * FROM site_hosting_transfers WHERE site_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(siteId).first();
}

const TRANSFER_COLUMNS = new Set(["job_id", "status", "target_resources", "source_resources", "progress", "lease_until", "old_copy_status", "error_message", "completed_at", "confirm_skipped", "frozen_at"]);
export async function patchTransfer(env, id, patch) {
  const keys = Object.keys(patch).filter((k) => TRANSFER_COLUMNS.has(k));
  if (!keys.length) return;
  await env.LUMMET_DB.prepare(`UPDATE site_hosting_transfers SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .bind(...keys.map((k) => (patch[k] !== null && typeof patch[k] === "object" ? JSON.stringify(patch[k]) : patch[k])), now(), id).run();
}

/** Compare-and-swap lease so two runners never copy the same data at once. True when this caller holds it now. */
export async function claimTransferLease(env, id, nowMs, leaseMs) {
  const r = await env.LUMMET_DB.prepare(
    `UPDATE site_hosting_transfers SET lease_until = ? WHERE id = ? AND (lease_until IS NULL OR lease_until < ?)`
  ).bind(nowMs + leaseMs, id, nowMs).run();
  return (r?.meta?.changes || 0) > 0;
}

export async function releaseTransferLease(env, id) {
  await env.LUMMET_DB.prepare(`UPDATE site_hosting_transfers SET lease_until = NULL WHERE id = ?`).bind(id).run();
}

/** Points a site's provider resources at the copies in the customer's account (one statement per type, in one batch). */
export async function switchSiteResources(env, siteId, rows) {
  const stmts = rows.map((r) => env.LUMMET_DB.prepare(
    `INSERT INTO site_resources (site_id, provider, resource_type, resource_id, resource_name, metadata)
     VALUES (?, 'cloudflare', ?, ?, ?, ?)
     ON CONFLICT(site_id, resource_type) DO UPDATE SET resource_id = excluded.resource_id, resource_name = excluded.resource_name,
       metadata = excluded.metadata, status = 'active', deleted_at = NULL`
  ).bind(siteId, r.type, r.resourceId, r.resourceName, r.metadata ? JSON.stringify(r.metadata) : null));
  if (stmts.length) await env.LUMMET_DB.batch(stmts);
}

/** Custom domains the site has on LUMMET's side (SSL-for-SaaS hostnames and delegated zones). A move needs them removed first. */
export async function countLummetDomains(env, siteId) {
  const a = (await env.LUMMET_DB.prepare(`SELECT COUNT(*) AS n FROM domains WHERE site_id = ? AND status != 'removed'`).bind(siteId).first())?.n || 0;
  const b = (await env.LUMMET_DB.prepare(`SELECT COUNT(*) AS n FROM domain_zones WHERE site_id = ? AND status NOT IN ('removed', 'expired', 'failed')`).bind(siteId).first())?.n || 0;
  return a + b;
}

export async function inflightDeploymentFor(env, siteId) {
  return env.LUMMET_DB.prepare(
    `SELECT id FROM deployments WHERE site_id = ? AND status IN ('queued','building','migrating','deploying','checking') ORDER BY created_at DESC LIMIT 1`
  ).bind(siteId).first();
}

/**
 * A move that paused on its time budget goes back to 'queued' so the next dispatch (queue, the customer's status poll or the
 * sweep's never-started pass) continues it. Pausing is progress, not a failure: the automatic-attempt counter is reset.
 */
export async function requeueJob(env, jobId) {
  await env.LUMMET_DB.prepare(`UPDATE jobs SET status = 'queued', auto_retries = 0 WHERE id = ? AND status IN ('running', 'queued')`).bind(jobId).run();
}

export async function cancelJob(env, jobId) {
  await env.LUMMET_DB.prepare(`UPDATE jobs SET status = 'cancelled', canceled_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued','running','failed')`).bind(jobId).run();
}

/** After a move the site no longer uses its platform address: the label is released for others (the site row stays as it is otherwise). */
export async function releasePlatformLabel(env, siteId) {
  await env.LUMMET_DB.prepare(`UPDATE sites SET host_label = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(siteId).run();
}

// ---------------------------------------------------------------- hardening (migration 0112)

/** Accounts whose token is due a re-check: never checked first, then least recently checked. Accounts that sites use come first. */
export async function listAccountsDueForHealth(env, { olderThanIso, limit }) {
  return (await env.LUMMET_DB.prepare(
    `SELECT a.*, (SELECT COUNT(*) FROM site_custom_hosting h WHERE h.account_ref = a.id) AS in_use
     FROM customer_cloudflare_accounts a
     WHERE a.status != 'disabled' AND (a.health_checked_at IS NULL OR a.health_checked_at < ?)
     ORDER BY (in_use > 0) DESC, COALESCE(a.health_checked_at, '') ASC, a.id LIMIT ?`
  ).bind(olderThanIso, limit).all()).results || [];
}

/** Active custom-hosted sites whose edge state differs from what their status asks for (suspended site or organization = blocked). */
export async function listEnforcementWork(env, limit) {
  return (await env.LUMMET_DB.prepare(
    `SELECT h.site_id, h.enforced_state, s.status AS site_status, o.status AS organization_status
     FROM site_custom_hosting h JOIN sites s ON s.id = h.site_id JOIN organizations o ON o.id = s.organization_id
     WHERE h.status = 'active' AND s.status IN ('active', 'suspended') AND (
       ((s.status = 'suspended' OR o.status IN ('suspended', 'closed')) AND COALESCE(h.enforced_state, 'serving') != 'blocked')
       OR (s.status = 'active' AND o.status NOT IN ('suspended', 'closed') AND h.enforced_state = 'blocked'))
     ORDER BY COALESCE(h.enforced_at, '') ASC LIMIT ?`
  ).bind(limit).all()).results || [];
}

/** Every organization member who may manage the account is told by the announcements service; this finds the organization of a site. */
export async function organizationOfSite(env, siteId) {
  return (await env.LUMMET_DB.prepare(`SELECT organization_id FROM site_custom_hosting WHERE site_id = ?`).bind(siteId).first())?.organization_id || null;
}

/** An old-address redirect row (shared with platform-domain moves: site_host_redirects) written when a site leaves Lummet. */
export async function saveHostRedirect(env, { oldHost, newHost, siteId, moveId, routeId, zoneId, expiresAt }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO site_host_redirects (old_host, new_host, site_id, move_id, route_id, zone_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(old_host) DO UPDATE SET new_host = excluded.new_host, site_id = excluded.site_id, move_id = excluded.move_id, route_id = excluded.route_id, zone_id = excluded.zone_id, expires_at = excluded.expires_at`
  ).bind(oldHost, newHost, siteId, moveId, routeId || null, zoneId || null, expiresAt).run();
}

/** Outcome of one signed access-state push (used to confirm a site really entered maintenance). */
export async function accessPushStatus(env, siteId, generation) {
  return env.LUMMET_DB.prepare(`SELECT status, last_error FROM site_access_push_jobs WHERE site_id = ? AND generation = ?`).bind(siteId, generation).first();
}

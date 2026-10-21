// =====================================================
// ERASURE  (roadmap 1.3)
//
// Executes the rules in retention-policy.js:
//   - eraseOrganization / purgeDueOrganizations: removes an organization's data once
//     its grace period ends. External resources (Cloudflare databases, storage, Worker,
//     custom hostnames, stored backups) are deleted FIRST; if any of that fails nothing
//     in the database is touched, the attempt is logged as "partial", and the next run
//     retries with the ids still available.
//   - eraseUser / requestUserErasure: removes a person. Organizations they solely own
//     must be dealt with first.
//   - exportUserData: the person's own data, for access/portability requests.
//   - sweepExpiredFinancialRecords: removes retained billing records after the policy period.
// Nothing here is legal advice; see retention-policy.js.
// =====================================================
import { createZoneDomainService } from "./zone-domains.js";
import * as dohResolver from "./dns-doh.js";
import * as policy from "./retention-policy.js";
import { verifyPassword, hashPassword } from "./auth.js";
import * as cloudflareProvider from "./infra-cloudflare.js";

const NOT_FOUND = /not\s*found|does\s*not\s*exist|no\s*such|could\s*not\s*find/i;

async function logErasure(env, kind, subjectId, status, summary) {
  await env.LUMMET_DB.prepare(`INSERT INTO erasure_log (id, kind, subject_id, status, summary) VALUES (?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), kind, subjectId, status, JSON.stringify(summary)).run();
}

async function deleteWhere(env, table, condition, ...params) {
  const r = await env.LUMMET_DB.prepare(`DELETE FROM ${table} WHERE ${condition}`).bind(...params).run();
  return r.meta.changes || 0;
}

async function scrubAudit(env, where, ...params) {
  await env.LUMMET_DB.prepare(
    `UPDATE ${policy.AUDIT_TABLE} SET ip_hash = NULL, error_message = CASE WHEN error_message LIKE '%@%' THEN '[redacted]' ELSE error_message END WHERE ${where}`
  ).bind(...params).run();
}

// ------------------------------------------------------------------ people

export async function eraseUser(env, userId) {
  const user = await env.LUMMET_DB.prepare(`SELECT id, email, status FROM customer_users WHERE id = ?`).bind(userId).first();
  if (!user) return { ok: false, status: 404, error: "not_found" };
  if (user.status === "deleted") return { ok: true, alreadyErased: true };

  const counts = {};
  for (const [table, condition] of policy.USER_DELETE) counts[table] = await deleteWhere(env, table, condition, userId);
  counts.invitations = await deleteWhere(env, "organization_invitations", "email = ? OR invited_by = ?", user.email, userId);
  counts.queued_email = await deleteWhere(env, "email_outbox", "to_email = ? AND status IN ('queued','failed')", user.email);
  // Public contact/demo submissions are not linked to an account, so they are matched by the address the person used.
  counts.inquiries = await deleteWhere(env, "lummet_inquiries", "lower(email) = lower(?)", user.email);
  await env.LUMMET_DB.prepare(`UPDATE email_outbox SET to_email = '[erased]', subject = '[erased]', body_encrypted = NULL, body_iv = NULL WHERE to_email = ?`).bind(user.email).run();
  await scrubAudit(env, "customer_user_id = ?", userId);

  // Tombstone: the id stays (so references in invoices, audit rows and "created by" columns remain
  // valid) but nothing about the person does. The email address becomes available again.
  await env.LUMMET_DB.prepare(
    `UPDATE customer_users SET email = ?, full_name = NULL, password_hash = ?, status = 'deleted', sso_organization_id = NULL,
       email_verified_at = NULL, deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(`deleted-${userId}@deleted.invalid`, await hashPassword(crypto.randomUUID() + crypto.randomUUID()), userId).run();

  await logErasure(env, "user", userId, "complete", counts);
  return { ok: true };
}

/** Self-service: re-authenticates, refuses while the person is the only owner of an organization. */
export async function requestUserErasure(env, userId, { password, confirmEmail } = {}) {
  const user = await env.LUMMET_DB.prepare(`SELECT id, email, password_hash, status, sso_organization_id FROM customer_users WHERE id = ?`).bind(userId).first();
  if (!user || user.status === "deleted") return { ok: false, status: 404, error: "not_found" };
  if (String(confirmEmail || "").trim().toLowerCase() !== user.email.toLowerCase()) return { ok: false, status: 422, error: "confirmation_email_mismatch" };
  if (!user.sso_organization_id) {
    if (!password || !(await verifyPassword(password, user.password_hash))) return { ok: false, status: 403, error: "incorrect_password" };
  }
  const blocking = (await env.LUMMET_DB.prepare(
    `SELECT o.id, o.name FROM organization_users ou JOIN organizations o ON o.id = ou.organization_id
     WHERE ou.user_id = ? AND ou.role = 'owner' AND o.erased_at IS NULL AND o.scheduled_deletion_at IS NULL
       AND (SELECT COUNT(*) FROM organization_users x WHERE x.organization_id = o.id AND x.role = 'owner') = 1`
  ).bind(userId).all()).results;
  if (blocking.length) return { ok: false, status: 409, error: "sole_owner_of_organizations", organizations: blocking };
  return eraseUser(env, userId);
}

export async function exportUserData(env, userId) {
  const user = await env.LUMMET_DB.prepare(`SELECT id, email, full_name, status, created_at, email_verified_at FROM customer_users WHERE id = ?`).bind(userId).first();
  if (!user) return null;
  const all = (sql, ...p) => env.LUMMET_DB.prepare(sql).bind(...p).all().then((r) => r.results);
  return {
    exportedAt: new Date().toISOString(),
    profile: user,
    organizations: await all(`SELECT o.name, ou.role, ou.created_at AS joined_at FROM organization_users ou JOIN organizations o ON o.id = ou.organization_id WHERE ou.user_id = ?`, userId),
    authenticationMethods: {
      authenticatorApp: !!(await env.LUMMET_DB.prepare(`SELECT 1 AS x FROM customer_totp WHERE user_id = ?`).bind(userId).first()),
      passkeys: await all(`SELECT nickname, created_at, last_used_at FROM customer_webauthn_credentials WHERE user_id = ?`, userId)
    },
    apiKeysCreated: await all(`SELECT name, key_prefix, status, created_at FROM customer_api_keys WHERE created_by = ?`, userId),
    invitationsSent: await all(`SELECT email, role, status, created_at FROM organization_invitations WHERE invited_by = ?`, userId),
    activity: await all(`SELECT created_at, action, resource, endpoint, success FROM ${policy.AUDIT_TABLE} WHERE customer_user_id = ? ORDER BY created_at DESC LIMIT 500`, userId),
    note: "Secrets (password hash, API key values, authenticator and passkey secrets) are never included."
  };
}

// ----------------------------------------------------------- organizations

async function deleteExternalResources(env, org, infra) {
  const failures = [];
  const attempt = async (what, fn) => {
    try { await fn(); return true; } catch (e) {
      if (NOT_FOUND.test(String(e.message))) return true;           // already gone
      failures.push({ step: what, error: String(e.message || e).slice(0, 160) });
      return false;
    }
  };
  const sites = (await env.LUMMET_DB.prepare(`SELECT id, tenant_id FROM sites WHERE organization_id = ?`).bind(org.id).all()).results;
  for (const site of sites) {
    const domains = (await env.LUMMET_DB.prepare(`SELECT id, ssl_resource_id FROM domains WHERE site_id = ? AND ssl_resource_id IS NOT NULL AND status != 'removed'`).bind(site.id).all()).results;
    for (const d of domains) {
      if (await attempt(`custom_hostname:${d.id}`, () => infra.deleteCustomHostname(env, d.ssl_resource_id))) {
        await env.LUMMET_DB.prepare(`UPDATE domains SET status = 'removed', ssl_resource_id = NULL, removed_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(d.id).run();
      }
    }
    // Delegated custom domains (v1): detach hostnames from the Worker and delete the Cloudflare zones.
    failures.push(...(await createZoneDomainService({ infra, dns: dohResolver }).cleanupForSite(env, site.id)));
    const resources = (await env.LUMMET_DB.prepare(`SELECT id, resource_type, resource_id, resource_name FROM site_resources WHERE site_id = ? AND status = 'active'`).bind(site.id).all()).results;
    const order = { route: 0, worker: 1, d1: 2, kv: 3, r2: 4 };      // stop routing, then the Worker, so nothing is serving while its data goes
    for (const r of resources.sort((a, b) => (order[a.resource_type] ?? 9) - (order[b.resource_type] ?? 9))) {
      const fn = { route: () => infra.deleteWorkerRoute(env, r.resource_id), worker: () => infra.deleteWorkerScript(env, r.resource_name), d1: () => infra.deleteDatabase(env, r.resource_id),
        kv: () => infra.deleteKVNamespace(env, r.resource_id), r2: () => infra.deleteR2Bucket(env, r.resource_id) }[r.resource_type];
      if (!fn) continue;
      if (await attempt(`${r.resource_type}:${r.resource_id}`, fn)) {
        await env.LUMMET_DB.prepare(`UPDATE site_resources SET status = 'deleted' WHERE id = ?`).bind(r.id).run();
      }
    }
  }
  const backups = (await env.LUMMET_DB.prepare(`SELECT id, storage_key FROM site_backups WHERE organization_id = ? AND storage_key IS NOT NULL`).bind(org.id).all()).results;
  for (const b of backups) {
    if (!env.BACKUPS) { failures.push({ step: `backup_object:${b.id}`, error: "backup_storage_not_configured" }); continue; }
    if (await attempt(`backup_object:${b.id}`, () => env.BACKUPS.delete(b.storage_key))) {
      await env.LUMMET_DB.prepare(`UPDATE site_backups SET storage_key = NULL WHERE id = ?`).bind(b.id).run();
    }
  }
  return failures;
}

export async function eraseOrganization(env, organizationId, { infra = cloudflareProvider, now = Date.now() } = {}) {
  const org = await env.LUMMET_DB.prepare(`SELECT * FROM organizations WHERE id = ?`).bind(organizationId).first();
  if (!org) return { ok: false, status: 404, error: "not_found" };
  if (org.erased_at) return { ok: true, alreadyErased: true };
  if (!org.scheduled_deletion_at || org.scheduled_deletion_at > new Date(now).toISOString()) return { ok: false, status: 409, error: "grace_period_not_over" };

  // 1. External resources first. Any failure stops here and is retried next run.
  const failures = await deleteExternalResources(env, org, infra);
  if (failures.length) {
    await logErasure(env, "organization", organizationId, "partial", { externalFailures: failures });
    return { ok: false, status: 502, partial: true, error: "external_cleanup_incomplete", failures };
  }

  // 2. People who only ever existed through this organization's SSO.
  const ssoUsers = (await env.LUMMET_DB.prepare(`SELECT id FROM customer_users WHERE sso_organization_id = ? AND status != 'deleted'`).bind(organizationId).all()).results;

  // 3. Database rows.
  const counts = {};
  const sites = (await env.LUMMET_DB.prepare(`SELECT id, tenant_id FROM sites WHERE organization_id = ?`).bind(organizationId).all()).results;
  for (const site of sites) {
    for (const [table, condition] of policy.SITE_DELETE) counts[table] = (counts[table] || 0) + await deleteWhere(env, table, condition, site.id);
  }
  for (const [table, condition] of policy.ORG_DELETE) {
    if (table === "email_outbox") {
      counts[table] = await deleteWhere(env, table, "organization_id = ? AND status IN ('queued','failed')", organizationId);
      await env.LUMMET_DB.prepare(`UPDATE email_outbox SET to_email = '[erased]', subject = '[erased]', body_encrypted = NULL, body_iv = NULL WHERE organization_id = ?`).bind(organizationId).run();
    } else counts[table] = await deleteWhere(env, table, condition, organizationId);
  }
  for (const site of sites) {
    if (site.tenant_id) {
      const shared = await env.LUMMET_DB.prepare(`SELECT 1 AS x FROM sites WHERE tenant_id = ? AND id != ?`).bind(site.tenant_id, site.id).first();
      if (!shared) await deleteWhere(env, "tenants", "id = ?", site.tenant_id);        // credentials, health and capabilities cascade
    }
  }
  await env.LUMMET_DB.prepare(
    `UPDATE sites SET name = 'Erased site', slug = 'erased-' || id, primary_domain = NULL, suspension_reason = NULL, tenant_id = NULL, status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE organization_id = ?`
  ).bind(organizationId).run();
  await scrubAudit(env, "organization_id = ?", organizationId);
  if (org.billing_email) await deleteWhere(env, "lummet_inquiries", "lower(email) = lower(?)", org.billing_email);
  await env.LUMMET_DB.prepare(
    `UPDATE organizations SET name = 'Erased organization', slug = 'erased-' || id, billing_email = NULL, status = 'closed',
       scheduled_deletion_at = NULL, deletion_requested_by = NULL, erased_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(organizationId).run();

  for (const u of ssoUsers) await eraseUser(env, u.id);

  await logErasure(env, "organization", organizationId, "complete", { ...counts, sites: sites.length, ssoUsersErased: ssoUsers.length });
  return { ok: true, counts };
}

/** Erases every organization whose grace period has ended. Safe to call as often as you like. */
export async function purgeDueOrganizations(env, { infra = cloudflareProvider, now = Date.now(), limit = 3 } = {}) {
  const due = (await env.LUMMET_DB.prepare(
    `SELECT id FROM organizations WHERE scheduled_deletion_at IS NOT NULL AND scheduled_deletion_at <= ? AND erased_at IS NULL ORDER BY scheduled_deletion_at LIMIT ?`
  ).bind(new Date(now).toISOString(), limit).all()).results;
  const results = [];
  for (const o of due) {
    try { results.push({ organizationId: o.id, ...(await eraseOrganization(env, o.id, { infra, now })) }); }
    catch (e) {
      await logErasure(env, "organization", o.id, "failed", { error: String(e.message || e).slice(0, 160) });
      results.push({ organizationId: o.id, ok: false, error: "unexpected_error" });
    }
  }
  return { processed: results.length, results };
}

/** Removes billing records of organizations erased more than FINANCIAL_RETENTION_YEARS ago. */
export async function sweepExpiredFinancialRecords(env, { now = Date.now(), years = policy.FINANCIAL_RETENTION_YEARS } = {}) {
  const cutoff = new Date(now - years * 365.25 * 86400000).toISOString().replace("T", " ").slice(0, 19);
  const orgs = (await env.LUMMET_DB.prepare(`SELECT id FROM organizations WHERE erased_at IS NOT NULL AND erased_at < ?`).bind(cutoff).all()).results;
  for (const o of orgs) {
    await deleteWhere(env, "subscription_status_events", "subscription_id IN (SELECT id FROM subscriptions WHERE organization_id = ?)", o.id);
    for (const table of policy.FINANCIAL_RETAINED) {
      if (table !== "subscription_status_events") await deleteWhere(env, table, "organization_id = ?", o.id);
    }
    await deleteWhere(env, "sites", "organization_id = ?", o.id);
    await deleteWhere(env, "organizations", "id = ?", o.id);
    await logErasure(env, "retention_sweep", o.id, "complete", { years });
  }
  return { swept: orgs.length };
}

export async function listErasureLog(env, limit = 50) {
  return (await env.LUMMET_DB.prepare(`SELECT id, kind, subject_id, status, summary, created_at FROM erasure_log ORDER BY created_at DESC, rowid DESC LIMIT ?`).bind(limit).all()).results;
}

// =====================================================
// TENANT BACKUPS (master prompt sections 23-24)
//
// Backs up a site's CONTENT by reading each resource through the
// tenant Super API (never the tenant DB directly) and writing one
// JSON object to an object store (env.BACKUPS, an R2 bucket binding).
// No binding => backups fail closed with a clear error; nothing is
// stored in D1 and nothing claims success.
//
// Restore never overwrites: it replays a backup into a DIFFERENT
// site owned by the same organization. Restore replays rows through
// the Super API create endpoints and reports per-row failures;
// it is best-effort and has only been tested against a fake tenant.
//
// Excluded on purpose: `users` (tenant end-user accounts, credentials)
// and any field named like a secret. Tenant configuration outside the
// Super API resource list (e.g. wrangler bindings) is NOT backed up.
// =====================================================
import { RESOURCES } from "./resources.js";
import * as realClient from "./client.js";

const BASE = "/en/api/super";
const EXCLUDED = new Set(["users"]);
const SECRET_FIELD = /(password|secret|token|api_?key|hash)/i;
const DEFAULT_RETENTION_DAYS = 30;
const MAX_BACKUP_BYTES = 20 * 1024 * 1024;

export function backupResourceKeys() {
  return Object.keys(RESOURCES).filter((k) => !EXCLUDED.has(k));
}

function scrub(row) {
  if (!row || typeof row !== "object") return row;
  return Object.fromEntries(Object.entries(row).filter(([k]) => !SECRET_FIELD.test(k)));
}

async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function createBackupService(client = realClient) {
  async function getSiteFor(env, organizationId, siteId) {
    const site = await env.LUMMET_DB.prepare(`SELECT * FROM sites WHERE id = ? AND organization_id = ?`).bind(siteId, organizationId).first();
    return site || null;
  }

  async function createBackup(env, { organizationId, siteId, createdBy = null, kind = "manual", retentionDays = DEFAULT_RETENTION_DAYS, now = new Date() }) {
    if (!env.BACKUPS) return { ok: false, status: 501, error: "backup_storage_not_configured" };
    const site = await getSiteFor(env, organizationId, siteId);
    if (!site) return { ok: false, status: 404, error: "site_not_found" };
    if (!site.tenant_id) return { ok: false, status: 409, error: "site_not_deployed" };

    const id = crypto.randomUUID();
    await env.LUMMET_DB.prepare(
      `INSERT INTO site_backups (id, organization_id, site_id, kind, created_by) VALUES (?, ?, ?, ?, ?)`
    ).bind(id, organizationId, siteId, kind, createdBy).run();

    const summary = {}, data = {};
    let okCount = 0, failCount = 0;
    for (const key of backupResourceKeys()) {
      const res = await client.getFromTenant(env, site.tenant_id, `${BASE}/${key}`);
      if (res.ok) {
        const rows = (res.data && res.data.data) || [];
        data[key] = Array.isArray(rows) ? rows.map(scrub) : rows;
        summary[key] = { ok: true, count: Array.isArray(rows) ? rows.length : 0 };
        okCount++;
      } else {
        // A missing/disabled resource is recorded, never silently treated as "empty".
        summary[key] = { ok: false, error: String(res.reason || res.status || "error").slice(0, 80) };
        failCount++;
      }
    }

    if (okCount === 0) {
      await env.LUMMET_DB.prepare(`UPDATE site_backups SET status='failed', error_message=?, resource_summary=?, completed_at=CURRENT_TIMESTAMP WHERE id=?`)
        .bind("no_resource_could_be_read", JSON.stringify(summary), id).run();
      return { ok: false, status: 502, error: "tenant_unreachable", backupId: id };
    }

    const payload = JSON.stringify({ format: "lummet-backup-v1", siteId, organizationId, createdAt: now.toISOString(), resources: data });
    if (payload.length > MAX_BACKUP_BYTES) {
      await env.LUMMET_DB.prepare(`UPDATE site_backups SET status='failed', error_message='backup_too_large', completed_at=CURRENT_TIMESTAMP WHERE id=?`).bind(id).run();
      return { ok: false, status: 413, error: "backup_too_large", backupId: id };
    }
    const storageKey = `backups/${organizationId}/${siteId}/${id}.json`;
    const sha = await sha256Hex(payload);
    await env.BACKUPS.put(storageKey, payload, { customMetadata: { sha256: sha } });
    const retention = new Date(now.getTime() + retentionDays * 86400000).toISOString();
    const status = failCount ? "partial" : "complete";
    await env.LUMMET_DB.prepare(
      `UPDATE site_backups SET status=?, storage_key=?, size_bytes=?, sha256=?, resource_summary=?, retention_until=?, completed_at=CURRENT_TIMESTAMP WHERE id=?`
    ).bind(status, storageKey, payload.length, sha, JSON.stringify(summary), retention, id).run();
    return { ok: true, backupId: id, status, sizeBytes: payload.length, resources: summary };
  }

  async function getBackup(env, organizationId, backupId) {
    return env.LUMMET_DB.prepare(`SELECT * FROM site_backups WHERE id = ? AND organization_id = ?`).bind(backupId, organizationId).first();
  }

  async function listBackups(env, organizationId, siteId = null) {
    const r = await env.LUMMET_DB.prepare(
      `SELECT id, site_id, kind, scope, status, size_bytes, sha256, resource_summary, verified_at, verification_status, retention_until, created_at
       FROM site_backups WHERE organization_id = ? AND (? IS NULL OR site_id = ?) ORDER BY created_at DESC LIMIT 100`
    ).bind(organizationId, siteId, siteId).all();
    return r.results.map((b) => ({ ...b, resource_summary: b.resource_summary ? JSON.parse(b.resource_summary) : null }));
  }

  async function verifyBackup(env, organizationId, backupId) {
    const b = await getBackup(env, organizationId, backupId);
    if (!b || !b.storage_key) return { ok: false, status: 404, error: "backup_not_found" };
    const obj = env.BACKUPS ? await env.BACKUPS.get(b.storage_key) : null;
    const set = (st) => env.LUMMET_DB.prepare(`UPDATE site_backups SET verified_at=CURRENT_TIMESTAMP, verification_status=? WHERE id=?`).bind(st, backupId).run();
    if (!obj) { await set("missing"); return { ok: false, status: 410, error: "backup_object_missing" }; }
    const text = await obj.text();
    const ok = (await sha256Hex(text)) === b.sha256;
    await set(ok ? "ok" : "mismatch");
    return ok ? { ok: true } : { ok: false, status: 500, error: "checksum_mismatch" };
  }

  async function downloadBackup(env, organizationId, backupId) {
    const b = await getBackup(env, organizationId, backupId);
    if (!b || !b.storage_key || b.status === "expired") return { ok: false, status: 404, error: "backup_not_found" };
    const obj = env.BACKUPS ? await env.BACKUPS.get(b.storage_key) : null;
    if (!obj) return { ok: false, status: 410, error: "backup_object_missing" };
    return { ok: true, body: await obj.text(), filename: `backup-${b.site_id}-${b.created_at.slice(0, 10)}.json` };
  }

  /** Delete backups past retention (call from the scheduled handler). */
  async function purgeExpired(env, now = new Date()) {
    const due = await env.LUMMET_DB.prepare(
      `SELECT id, storage_key FROM site_backups WHERE status IN ('complete','partial') AND retention_until < ? LIMIT 50`
    ).bind(now.toISOString()).all();
    let purged = 0;
    for (const b of due.results) {
      if (env.BACKUPS && b.storage_key) await env.BACKUPS.delete(b.storage_key);
      await env.LUMMET_DB.prepare(`UPDATE site_backups SET status='expired', storage_key=NULL WHERE id=?`).bind(b.id).run();
      purged++;
    }
    return { purged };
  }

  async function restoreBackup(env, { organizationId, backupId, targetSiteId, requestedBy = null }) {
    const b = await getBackup(env, organizationId, backupId);
    if (!b || !b.storage_key || !["complete", "partial"].includes(b.status)) return { ok: false, status: 404, error: "backup_not_found" };
    if (targetSiteId === b.site_id) return { ok: false, status: 409, error: "restore_into_source_refused" };
    const target = await getSiteFor(env, organizationId, targetSiteId);
    if (!target) return { ok: false, status: 404, error: "target_site_not_found" };
    if (target.status !== "active" || !target.tenant_id) return { ok: false, status: 409, error: "target_site_not_ready" };
    const v = await verifyBackup(env, organizationId, backupId);
    if (!v.ok) return v; // never restore from a backup that fails its checksum
    const obj = await env.BACKUPS.get(b.storage_key);
    const doc = JSON.parse(await obj.text());

    const restoreId = crypto.randomUUID();
    await env.LUMMET_DB.prepare(
      `INSERT INTO backup_restores (id, backup_id, organization_id, source_site_id, target_site_id, requested_by) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(restoreId, backupId, organizationId, b.site_id, targetSiteId, requestedBy).run();

    const result = {}; let failed = 0;
    for (const [key, rows] of Object.entries(doc.resources || {})) {
      const cfg = RESOURCES[key];
      if (!cfg || !cfg.supportsCreate || !Array.isArray(rows)) { result[key] = { skipped: true }; continue; }
      let created = 0, errors = 0;
      for (const row of rows) {
        const res = await client.postToTenant(env, target.tenant_id, `${BASE}/${key}`, row);
        if (res.ok) created++; else errors++;
      }
      failed += errors; result[key] = { created, errors };
    }
    const status = failed ? "partial" : "complete";
    await env.LUMMET_DB.prepare(`UPDATE backup_restores SET status=?, result_summary=?, completed_at=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(status, JSON.stringify(result), restoreId).run();
    return { ok: true, restoreId, status, result };
  }

  return { createBackup, getBackup, listBackups, verifyBackup, downloadBackup, purgeExpired, restoreBackup };
}

export const backups = createBackupService();

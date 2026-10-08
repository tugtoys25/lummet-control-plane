// =====================================================
// TENANT TEMPLATE RELEASES (roadmap 0.1)
//
// Closes the gap documented in provisioning.js's header comment:
// nothing previously built or supplied the tenant Worker's bundled
// script automatically. This module is the "shared build artifact"
// half of that fix — see scripts/build-tenant-worker.mjs for how a
// release's scriptContent is actually produced from the lummet-tenant
// source, and provisioning.js's attemptAutoDeploy for how a new site
// consumes whatever release is currently 'active'.
//
// Fails closed exactly like backups.js: no env.TENANT_TEMPLATES R2
// binding => "template_storage_not_configured", never a fake success.
//
// STATIC ASSETS: a release may carry an assets manifest
// ({ "/static/app.css": { hash, size } }). The files themselves are
// stored content-addressed in the same bucket (assets/<hash>), uploaded
// one by one through putAsset() BEFORE the release is published, and
// publishRelease() refuses a manifest naming a file that isn't there.
// At deploy time the files are handed to Cloudflare's Workers Assets
// upload flow (infra-cloudflare.js). That flow has not been verified
// against a live Cloudflare account.
// =====================================================

import { assetHash, validateAssetPath, validateAssetManifest, MAX_ASSET_BYTES } from "./asset-hash.js";

const MAX_RELEASE_BYTES = 25 * 1024 * 1024;

async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function validateMigrations(migrations) {
  if (!Array.isArray(migrations)) return "migrations_must_be_array";
  for (const m of migrations) {
    if (!m || typeof m.name !== "string" || !m.name.trim() || typeof m.sql !== "string" || !m.sql.trim()) {
      return "each_migration_needs_name_and_sql";
    }
  }
  const names = migrations.map((m) => m.name);
  if (new Set(names).size !== names.length) return "duplicate_migration_names";
  return null;
}

/**
 * Publish a new release. Staff-only (enforced by the route layer, not
 * here) — this is a super-admin action with platform-wide effect on
 * every future site provisioned.
 */
async function objectExists(bucket, key) {
  return !!(typeof bucket.head === "function" ? await bucket.head(key) : await bucket.get(key));
}

/**
 * Stores one static asset, content-addressed. The hash is recomputed
 * server-side from the bytes and path, so a caller can't register a
 * file under a hash that doesn't match its content.
 */
export async function putAsset(env, { path, bytes }) {
  if (!env.TENANT_TEMPLATES) return { ok: false, status: 501, error: "template_storage_not_configured" };
  const pathErr = validateAssetPath(path);
  if (pathErr) return { ok: false, status: 422, error: pathErr };
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_ASSET_BYTES) return { ok: false, status: 413, error: "asset_too_large" };
  const hash = await assetHash(bytes, path);
  await env.TENANT_TEMPLATES.put(`assets/${hash}`, bytes);
  return { ok: true, hash, size: bytes.length };
}

export async function readAsset(env, hash) {
  if (!/^[0-9a-f]{32}$/.test(String(hash))) return null;
  const obj = await env.TENANT_TEMPLATES.get(`assets/${hash}`);
  return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
}

export async function publishRelease(env, { version, scriptContent, migrations, assets = null, notes = null, createdBy = null }) {
  if (!env.TENANT_TEMPLATES) return { ok: false, status: 501, error: "template_storage_not_configured" };
  if (!version || !/^[a-zA-Z0-9._-]{1,64}$/.test(version)) return { ok: false, status: 422, error: "invalid_version" };
  if (!scriptContent || typeof scriptContent !== "string" || !scriptContent.trim()) {
    return { ok: false, status: 422, error: "script_content_required" };
  }
  const migErr = validateMigrations(migrations || []);
  if (migErr) return { ok: false, status: 422, error: migErr };

  if (assets !== null && assets !== undefined) {
    const assetErr = validateAssetManifest(assets);
    if (assetErr) return { ok: false, status: 422, error: assetErr };
    const missing = [];
    for (const [path, meta] of Object.entries(assets)) {
      if (!(await objectExists(env.TENANT_TEMPLATES, `assets/${meta.hash}`))) missing.push(path);
    }
    if (missing.length) return { ok: false, status: 422, error: "asset_files_missing", missing: missing.slice(0, 10), missingCount: missing.length };
  }

  const existing = await env.LUMMET_DB.prepare(`SELECT id FROM tenant_template_releases WHERE version = ?`).bind(version).first();
  if (existing) return { ok: false, status: 409, error: "version_already_exists" };

  const payload = JSON.stringify({ format: "lummet-tenant-release-v1", version, scriptContent, migrations: migrations || [], assetsManifest: assets || null });
  if (payload.length > MAX_RELEASE_BYTES) return { ok: false, status: 413, error: "release_too_large" };

  const id = crypto.randomUUID();
  const storageKey = `templates/${version}.json`;
  const sha = await sha256Hex(payload);
  await env.TENANT_TEMPLATES.put(storageKey, payload, { customMetadata: { sha256: sha } });

  // Exactly one release is 'active' at a time — the one every new
  // site's auto-deploy will use. Superseding is a metadata flip only;
  // the older release's artifact stays in R2 (rollback target).
  await env.LUMMET_DB.prepare(`UPDATE tenant_template_releases SET status = 'superseded' WHERE status = 'active'`).run();
  await env.LUMMET_DB.prepare(
    `INSERT INTO tenant_template_releases (id, version, storage_key, migration_count, size_bytes, sha256, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, version, storageKey, (migrations || []).length, payload.length, sha, notes, createdBy).run();

  return { ok: true, releaseId: id, version, sizeBytes: payload.length, assetCount: assets ? Object.keys(assets).length : 0 };
}

async function loadRelease(env, row) {
  if (!row) return null;
  if (!env.TENANT_TEMPLATES) return { ok: false, status: 501, error: "template_storage_not_configured" };
  const obj = await env.TENANT_TEMPLATES.get(row.storage_key);
  if (!obj) return { ok: false, status: 410, error: "release_object_missing" };
  const text = await obj.text();
  if ((await sha256Hex(text)) !== row.sha256) return { ok: false, status: 500, error: "checksum_mismatch" };
  const doc = JSON.parse(text);
  return { ok: true, version: row.version, scriptContent: doc.scriptContent, migrations: doc.migrations || [], assets: doc.assetsManifest || null };
}

/** The release every newly-provisioned site's auto-deploy should use. */
export async function getCurrentRelease(env) {
  const row = await env.LUMMET_DB.prepare(`SELECT * FROM tenant_template_releases WHERE status = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1`).first();
  if (!row) return { ok: false, status: 404, error: "no_release_published" };
  return loadRelease(env, row);
}

export async function getReleaseByVersion(env, version) {
  const row = await env.LUMMET_DB.prepare(`SELECT * FROM tenant_template_releases WHERE version = ?`).bind(version).first();
  if (!row) return { ok: false, status: 404, error: "release_not_found" };
  return loadRelease(env, row);
}

export async function listReleases(env) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT id, version, migration_count, size_bytes, sha256, notes, status, created_by, created_at FROM tenant_template_releases ORDER BY created_at DESC, rowid DESC LIMIT 50`
  ).all();
  return r.results;
}

/** Roll back to a previous release by making it 'active' again. Does not delete the currently-active one. */
export async function activateRelease(env, version) {
  const row = await env.LUMMET_DB.prepare(`SELECT id FROM tenant_template_releases WHERE version = ?`).bind(version).first();
  if (!row) return { ok: false, status: 404, error: "release_not_found" };
  await env.LUMMET_DB.prepare(`UPDATE tenant_template_releases SET status = 'superseded' WHERE status = 'active'`).run();
  await env.LUMMET_DB.prepare(`UPDATE tenant_template_releases SET status = 'active' WHERE id = ?`).bind(row.id).run();
  return { ok: true };
}

// =====================================================
// CONTROL-PLANE DATABASE BACKUP (roadmap 2.3)
//
// Exports the control plane's own D1 database (organizations,
// subscriptions, billing history, audit logs, entitlements ...) to the
// BACKUPS R2 bucket as AES-GCM encrypted parts, with a manifest of
// hashes and row counts. tenant backups live in backups.js; this is the
// platform's own state.
//
// HONEST LIMITS
// - Not a point-in-time snapshot: tables are read one after another, so
//   rows written during the export may be missing or appear in some
//   tables and not others. Use D1 Time Travel as the primary recovery
//   tool; this export is the independent second copy (and the way out
//   of a D1 problem or a bad migration).
// - Encrypted with CREDENTIAL_KEK. Lose that key and these backups can
//   no longer be read. Store a copy of the key somewhere separate.
// - Short-lived/sensitive tables (sessions, login attempts, one-time
//   tokens, auth challenges) are deliberately not exported.
// =====================================================
import { encryptSecret, decryptSecret } from "./crypto.js";

export const EXCLUDED_TABLES = new Set([
  "lummet_sessions", "customer_sessions", "lummet_auth_attempts", "customer_mfa_challenges",
  "webauthn_challenges", "sso_login_states", "customer_password_resets", "customer_email_verifications",
  "schema_migrations", "d1_migrations"
]);
export const KEEP_COMPLETE_BACKUPS = 14;
export const BACKUP_INTERVAL_HOURS = 20;
const PAGE_ROWS = 2000;
const PART_MAX_CHARS = 1_500_000;

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;

function bytesToHex(buf) { return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
async function sha256Hex(text) { return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))); }

/** Tables to export, parents before children so a restore never violates a foreign key. */
export async function listExportTables(env) {
  const all = (await env.LUMMET_DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`).all()).results
    .map((r) => r.name).filter((n) => !EXCLUDED_TABLES.has(n));
  const parents = new Map();
  for (const t of all) {
    const fks = (await env.LUMMET_DB.prepare(`PRAGMA foreign_key_list(${q(t)})`).all()).results || [];
    parents.set(t, new Set(fks.map((f) => f.table).filter((p) => p !== t && all.includes(p))));
  }
  const ordered = [], done = new Set();
  let progress = true;
  while (ordered.length < all.length && progress) {
    progress = false;
    for (const t of all) {
      if (done.has(t)) continue;
      if ([...parents.get(t)].every((p) => done.has(p))) { ordered.push(t); done.add(t); progress = true; }
    }
  }
  for (const t of all) if (!done.has(t)) ordered.push(t);      // cycles: append, restore handles via REPLACE
  return ordered;
}

async function putPart(env, prefix, index, lines) {
  const plain = lines.join("\n");
  const enc = await encryptSecret(env, plain);
  const body = JSON.stringify({ v: 1, iv: enc.secretIv, data: enc.encryptedSecret });
  const key = `${prefix}/part-${String(index).padStart(4, "0")}.json`;
  await env.BACKUPS.put(key, body);
  return { key, sha256: await sha256Hex(body), rows: lines.length, bytes: body.length };
}

export async function createControlPlaneBackup(env, { now = Date.now() } = {}) {
  if (!env.BACKUPS) return { ok: false, status: 501, error: "backup_storage_not_configured" };
  const id = crypto.randomUUID();
  const prefix = `control-plane/${new Date(now).toISOString().slice(0, 10)}/${id}`;
  await env.LUMMET_DB.prepare(`INSERT INTO control_plane_backups (id, status, storage_prefix) VALUES (?, 'running', ?)`).bind(id, prefix).run();

  try {
    const tables = await listExportTables(env);
    const parts = [], rowCounts = {};
    let lines = [], chars = 0, totalBytes = 0;
    const flush = async () => {
      if (!lines.length) return;
      const p = await putPart(env, prefix, parts.length + 1, lines);
      parts.push(p); totalBytes += p.bytes; lines = []; chars = 0;
    };
    for (const table of tables) {
      rowCounts[table] = 0;
      let last = -1;
      for (;;) {
        const page = (await env.LUMMET_DB.prepare(`SELECT rowid AS __rowid, * FROM ${q(table)} WHERE rowid > ? ORDER BY rowid LIMIT ?`).bind(last, PAGE_ROWS).all()).results;
        if (!page.length) break;
        for (const row of page) {
          last = row.__rowid; delete row.__rowid;
          const line = JSON.stringify({ t: table, r: row });
          lines.push(line); chars += line.length; rowCounts[table] += 1;
          if (chars >= PART_MAX_CHARS) await flush();
        }
        if (page.length < PAGE_ROWS) break;
      }
    }
    await flush();

    const manifest = { version: 1, backupId: id, createdAt: new Date(now).toISOString(), tables, rowCounts, parts };
    await env.BACKUPS.put(`${prefix}/manifest.json`, JSON.stringify(manifest));
    await env.LUMMET_DB.prepare(
      `UPDATE control_plane_backups SET status = 'complete', part_count = ?, row_counts = ?, size_bytes = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(parts.length, JSON.stringify(rowCounts), totalBytes, id).run();
    return { ok: true, backupId: id, parts: parts.length, rowCounts };
  } catch (e) {
    await env.LUMMET_DB.prepare(`UPDATE control_plane_backups SET status = 'failed', error_message = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(String(e.message || e).slice(0, 300), id).run();
    return { ok: false, status: 500, error: "backup_failed", backupId: id };
  }
}

async function readManifest(env, backup) {
  const obj = await env.BACKUPS.get(`${backup.storage_prefix}/manifest.json`);
  if (!obj) return null;
  try { return JSON.parse(await obj.text()); } catch (_) { return null; }
}

/** Re-reads every stored part: hash matches the manifest, decrypts, and the row counts add up. */
export async function verifyControlPlaneBackup(env, backupId) {
  const b = await env.LUMMET_DB.prepare(`SELECT * FROM control_plane_backups WHERE id = ?`).bind(backupId).first();
  if (!b) return { ok: false, status: 404, error: "not_found" };
  if (b.status !== "complete") return { ok: false, status: 409, error: "backup_not_complete" };
  const mark = (st) => env.LUMMET_DB.prepare(`UPDATE control_plane_backups SET verified_at = CURRENT_TIMESTAMP, verification_status = ? WHERE id = ?`).bind(st, backupId).run();
  const fail = async (code) => { await mark(code); return { ok: false, status: 422, error: code }; };

  const manifest = env.BACKUPS ? await readManifest(env, b) : null;
  if (!manifest) return fail("manifest_missing");
  const counted = {};
  for (const p of manifest.parts) {
    const obj = await env.BACKUPS.get(p.key);
    if (!obj) return fail("part_missing");
    const body = await obj.text();
    if ((await sha256Hex(body)) !== p.sha256) return fail("part_hash_mismatch");
    let plain;
    try { plain = await decryptPartWithEnv(env, JSON.parse(body)); } catch (_) { return fail("part_not_decryptable"); }
    for (const line of plain.split("\n")) { const t = JSON.parse(line).t; counted[t] = (counted[t] || 0) + 1; }
  }
  for (const t of manifest.tables) {
    if ((counted[t] || 0) !== manifest.rowCounts[t]) return fail("row_count_mismatch");
  }
  await mark("ok");
  return { ok: true };
}

async function decryptPartWithEnv(env, part) { return decryptSecret(env, part.data, part.iv); }

/** Reads a stored backup back into rows grouped by table (used by tests and by an in-Worker restore tool). */
export async function* readBackupRows(env, backupId) {
  const b = await env.LUMMET_DB.prepare(`SELECT * FROM control_plane_backups WHERE id = ?`).bind(backupId).first();
  const manifest = b && (await readManifest(env, b));
  if (!manifest) throw new Error("manifest_missing");
  for (const p of manifest.parts) {
    const obj = await env.BACKUPS.get(p.key);
    const plain = await decryptPartWithEnv(env, JSON.parse(await obj.text()));
    for (const line of plain.split("\n")) yield JSON.parse(line);
  }
}

const sqlValue = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

/** One INSERT OR REPLACE statement for a row. Used to build a restore .sql file. */
export function rowToSql(table, row) {
  const cols = Object.keys(row);
  return `INSERT OR REPLACE INTO ${q(table)} (${cols.map(q).join(", ")}) VALUES (${cols.map((c) => sqlValue(row[c])).join(", ")});`;
}

export async function purgeOldControlPlaneBackups(env, { keep = KEEP_COMPLETE_BACKUPS } = {}) {
  const old = (await env.LUMMET_DB.prepare(
    `SELECT id, storage_prefix FROM control_plane_backups WHERE status = 'complete' ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?`
  ).bind(keep).all()).results;
  let purged = 0;
  for (const b of old) {
    const manifest = env.BACKUPS ? await readManifest(env, b) : null;
    if (manifest) for (const p of manifest.parts) await env.BACKUPS.delete(p.key);
    if (env.BACKUPS) await env.BACKUPS.delete(`${b.storage_prefix}/manifest.json`);
    await env.LUMMET_DB.prepare(`UPDATE control_plane_backups SET status = 'expired' WHERE id = ?`).bind(b.id).run();
    purged += 1;
  }
  return { purged };
}

/**
 * Safe to call as often as you like (every pinger tick, every cron run): it
 * only does work when no complete backup exists in the last
 * BACKUP_INTERVAL_HOURS and none is already running.
 */
export async function runControlPlaneBackupIfDue(env, { now = Date.now() } = {}) {
  if (!env.BACKUPS) return { ran: false, reason: "backup_storage_not_configured" };
  const recent = await env.LUMMET_DB.prepare(
    `SELECT id FROM control_plane_backups WHERE (status = 'complete' AND created_at > datetime(?, '-${BACKUP_INTERVAL_HOURS} hours'))
        OR (status = 'running' AND created_at > datetime(?, '-30 minutes')) LIMIT 1`
  ).bind(new Date(now).toISOString().replace("T", " ").slice(0, 19), new Date(now).toISOString().replace("T", " ").slice(0, 19)).first();
  if (recent) return { ran: false, reason: "not_due" };
  const r = await createControlPlaneBackup(env, { now });
  if (r.ok) await purgeOldControlPlaneBackups(env);
  return { ran: true, ...r };
}

export async function listControlPlaneBackups(env, limit = 30) {
  return (await env.LUMMET_DB.prepare(
    `SELECT id, status, part_count, size_bytes, error_message, verified_at, verification_status, created_at, completed_at FROM control_plane_backups ORDER BY created_at DESC, rowid DESC LIMIT ?`
  ).bind(limit).all()).results;
}

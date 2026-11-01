// =====================================================
// ENCRYPTION KEY ROTATION (roadmap 2.4)
//
// Rotating CREDENTIAL_KEK safely takes three steps (full runbook in
// docs/KEY_ROTATION.md):
//   1. Set CREDENTIAL_KEK_PREVIOUS = the old key and CREDENTIAL_KEK = a new
//      key, and deploy. New writes use the new key; old data stays readable.
//   2. Run reencryptAll() (staff console: SaaS > Key rotation) until nothing
//      remains under an older key.
//   3. Only when rotationStatus().safeToRemovePrevious is true, delete
//      CREDENTIAL_KEK_PREVIOUS.
// Messages and results contain table names, row counts and key ids only.
// =====================================================
import { encryptSecret, decryptSecret, activeKeyId, previousKeyId, keyIdOf, aadFor, writesV2, formatOf } from "./crypto.js";

// Every place the platform stores something encrypted with CREDENTIAL_KEK in D1.
// If a new encrypted column is added anywhere, add it here (a test checks this
// list against the schema).
// `bind` is the column whose value goes into a v2 value's authenticated data
// (see aadFor in crypto.js). It defaults to `pk`; tenant_api_credentials binds
// to its UUID credential_id because that is known before the row is inserted.
export const ENCRYPTED_TARGETS = [
  { table: "tenant_api_credentials", pk: "id", bind: "credential_id", enc: "encrypted_secret", iv: "secret_iv" },
  { table: "webhooks", pk: "id", enc: "encrypted_secret", iv: "secret_iv" },
  { table: "customer_totp", pk: "user_id", enc: "encrypted_secret", iv: "secret_iv" },
  { table: "lummet_admin_totp", pk: "admin_id", enc: "encrypted_secret", iv: "secret_iv" },
  { table: "organization_sso_settings", pk: "organization_id", enc: "encrypted_client_secret", iv: "client_secret_iv" },
  { table: "email_outbox", pk: "id", enc: "body_encrypted", iv: "body_iv" }
];
const bindColumn = (t) => t.bind || t.pk;

export const DEFAULT_BATCH = 200;

async function backupsUnderOtherKeys(env, activeId) {
  if (!env.BACKUPS) return { count: 0, checked: 0 };
  const rows = (await env.LUMMET_DB.prepare(`SELECT storage_prefix FROM control_plane_backups WHERE status = 'complete'`).all()).results;
  let count = 0, checked = 0;
  for (const b of rows) {
    const man = await env.BACKUPS.get(`${b.storage_prefix}/manifest.json`);
    if (!man) continue;
    const first = JSON.parse(await man.text()).parts[0];
    const part = first && (await env.BACKUPS.get(first.key));
    if (!part) continue;
    checked += 1;
    if (keyIdOf(JSON.parse(await part.text()).data) !== activeId) count += 1;
  }
  return { count, checked };
}

export async function rotationStatus(env) {
  const activeId = await activeKeyId(env);
  const prevId = await previousKeyId(env);
  const tables = [];
  let remaining = 0;
  let v1Rows = 0;
  for (const t of ENCRYPTED_TARGETS) {
    const row = await env.LUMMET_DB.prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN ${t.enc} LIKE ? THEN 1 ELSE 0 END), 0) AS current, COALESCE(SUM(CASE WHEN ${t.enc} LIKE ? THEN 1 ELSE 0 END), 0) AS v2 FROM ${t.table} WHERE ${t.enc} IS NOT NULL`
    ).bind(`${activeId}:%`, `${activeId}:v2:%`).first();
    tables.push({ table: t.table, total: row.total, underActiveKey: row.current, underOtherKey: row.total - row.current, v2: row.v2, v1: row.total - row.v2 });
    remaining += row.total - row.current;
    v1Rows += row.total - row.v2;
  }
  const backups = await backupsUnderOtherKeys(env, activeId);
  return {
    activeKeyId: activeId,
    previousKeyId: prevId,
    tables,
    rowsUnderOtherKeys: remaining,
    writesV2: writesV2(env),
    // Rows (under any key) not yet in the bound v2 format. Informational: the
    // rotation safety check above depends on keys only.
    rowsNotV2: v1Rows,
    backupsUnderOtherKeys: backups.count,
    backupsChecked: backups.checked,
    safeToRemovePrevious: !!prevId && remaining === 0 && backups.count === 0
  };
}

/**
 * Re-encrypts up to `limit` rows (across all tables) that are not under the
 * active key, and, when CREDENTIAL_ENCRYPTION_FORMAT=v2, rows not yet in the
 * v2 format (which binds each value to its table, row and column). Safe to run repeatedly and concurrently with normal traffic: each
 * update only applies if the row has not changed since it was read.
 */
export async function reencryptAll(env, { limit = DEFAULT_BATCH } = {}) {
  const activeId = await activeKeyId(env);
  // v1 target: anything under the active key is done. v2 target: only active-key v2 values are done.
  const donePattern = writesV2(env) ? `${activeId}:v2:%` : `${activeId}:%`;
  let budget = Math.min(Math.max(Number(limit) || DEFAULT_BATCH, 1), 1000);
  const result = { rotated: 0, skippedChanged: 0, failed: [], byTable: {} };

  for (const t of ENCRYPTED_TARGETS) {
    if (budget <= 0) break;
    const rows = (await env.LUMMET_DB.prepare(
      `SELECT ${t.pk} AS pk, ${bindColumn(t)} AS bind, ${t.enc} AS enc, ${t.iv} AS iv FROM ${t.table} WHERE ${t.enc} IS NOT NULL AND ${t.enc} NOT LIKE ? LIMIT ?`
    ).bind(donePattern, budget).all()).results;
    result.byTable[t.table] = 0;
    for (const r of rows) {
      budget -= 1;
      try {
        const aad = aadFor(t.table, r.bind, t.enc);
        const plain = await decryptSecret(env, r.enc, r.iv, aad);
        const fresh = await encryptSecret(env, plain, aad, { format: formatOf(r.enc) });
        const upd = await env.LUMMET_DB.prepare(
          `UPDATE ${t.table} SET ${t.enc} = ?, ${t.iv} = ? WHERE ${t.pk} = ? AND ${t.enc} = ?`
        ).bind(fresh.encryptedSecret, fresh.secretIv, r.pk, r.enc).run();
        if (upd.meta.changes) { result.rotated += 1; result.byTable[t.table] += 1; } else result.skippedChanged += 1;
      } catch (_) {
        if (result.failed.length < 20) result.failed.push({ table: t.table, id: String(r.pk) });
      }
    }
  }
  return { ok: true, ...result };
}

// Roadmap 2.4: CREDENTIAL_KEK rotation (dual-key decrypt, re-encryption, safety verdict)
// plus Stripe webhook secret rollover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { encryptSecret, decryptSecret, activeKeyId, previousKeyId, keyIdOf } from '../worker/crypto.js';
import * as rot from '../worker/key-rotation.js';
import * as cp from '../worker/cp-backup.js';
import { verifyAndParseWebhook } from '../worker/billing-stripe.js';
import worker from '../worker/index.js';

const OLD = btoa('o'.repeat(32)), NEW = btoa('n'.repeat(32));
function fakeR2() { const m = new Map(); return { m, async put(k, v) { m.set(k, v); }, async get(k) { return m.has(k) ? { async text() { return m.get(k); } } : null; }, async delete(k) { m.delete(k); } }; }
function env(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: OLD, ...extra }; }
const rotated = (e) => ({ ...e, CREDENTIAL_KEK: NEW, CREDENTIAL_KEK_PREVIOUS: OLD });

// Writes ciphertext exactly the way the code did BEFORE key ids existed: no tag.
async function legacyEncrypt(kekB64, plaintext) {
  const raw = Uint8Array.from(atob(kekB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)));
  return { enc: btoa(String.fromCharCode(...ct)), iv: btoa(String.fromCharCode(...iv)) };
}

test('new ciphertext is tagged with the active key id, and the id is stable and key-specific', async () => {
  const a = { CREDENTIAL_KEK: OLD }, b = { CREDENTIAL_KEK: NEW };
  const enc = await encryptSecret(a, 'secret');
  assert.equal(keyIdOf(enc.encryptedSecret), await activeKeyId(a));
  assert.notEqual(await activeKeyId(a), await activeKeyId(b));
  assert.equal(await activeKeyId(a), await activeKeyId({ CREDENTIAL_KEK: OLD }));
  assert.match(await activeKeyId(a), /^[0-9a-f]{8}$/);
  assert.equal(await decryptSecret(a, enc.encryptedSecret, enc.secretIv), 'secret');
  assert.equal(keyIdOf('AAAA=='), null, 'untagged base64 is legacy');
});

test('legacy (untagged) values written before this change still decrypt, with the current key or the previous one', async () => {
  const legacy = await legacyEncrypt(OLD, 'old-secret');
  assert.equal(await decryptSecret({ CREDENTIAL_KEK: OLD }, legacy.enc, legacy.iv), 'old-secret');
  assert.equal(await decryptSecret(rotated({}), legacy.enc, legacy.iv), 'old-secret', 'found via CREDENTIAL_KEK_PREVIOUS');
  await assert.rejects(() => decryptSecret({ CREDENTIAL_KEK: NEW }, legacy.enc, legacy.iv), 'unreadable once the old key is gone');
});

test('during rotation old-key values stay readable, new values use the new key, and retiring the old key breaks only un-rotated values', async () => {
  const oldEnc = await encryptSecret({ CREDENTIAL_KEK: OLD }, 'v1');
  const r = rotated({});
  assert.equal(await decryptSecret(r, oldEnc.encryptedSecret, oldEnc.secretIv), 'v1');
  const fresh = await encryptSecret(r, 'v2');
  assert.equal(keyIdOf(fresh.encryptedSecret), await activeKeyId({ CREDENTIAL_KEK: NEW }));
  assert.equal(await previousKeyId(r), await activeKeyId({ CREDENTIAL_KEK: OLD }));
  assert.equal(await previousKeyId({ CREDENTIAL_KEK: NEW }), null);
  assert.equal(await previousKeyId({ CREDENTIAL_KEK: OLD, CREDENTIAL_KEK_PREVIOUS: OLD }), null, 'same key as previous is ignored');
  const newOnly = { CREDENTIAL_KEK: NEW };
  assert.equal(await decryptSecret(newOnly, fresh.encryptedSecret, fresh.secretIv), 'v2');
  await assert.rejects(() => decryptSecret(newOnly, oldEnc.encryptedSecret, oldEnc.secretIv), /no_key_for_ciphertext/);
  await assert.rejects(() => encryptSecret({}, 'x'), /CREDENTIAL_KEK/);
});

async function seedAll(e) {
  const db = e.LUMMET_DB;
  const enc = (p) => encryptSecret({ CREDENTIAL_KEK: OLD }, p);
  await db.prepare(`INSERT INTO tenants (id, name, host, api_base_url) VALUES ('t1','T','t1.example.com','https://t1.example.com')`).run();
  let x = await enc('tenant-hmac-secret');
  await db.prepare(`INSERT INTO tenant_api_credentials (tenant_id, credential_id, encrypted_secret, secret_iv) VALUES ('t1','cred1',?,?)`).bind(x.encryptedSecret, x.secretIv).run();
  await db.prepare(`INSERT INTO organizations (id, name, slug) VALUES ('o1','Org','org')`).run();
  x = await enc('webhook-secret');
  await db.prepare(`INSERT INTO webhooks (id, organization_id, url, encrypted_secret, secret_iv, event_types) VALUES ('w1','o1','https://h.example.com/x',?,?,'[]')`).bind(x.encryptedSecret, x.secretIv).run();
  await db.prepare(`INSERT INTO customer_users (id, email, password_hash) VALUES ('u1','a@example.com','h')`).run();
  const l = await legacyEncrypt(OLD, 'totp-secret');   // an untagged legacy row
  await db.prepare(`INSERT INTO customer_totp (user_id, encrypted_secret, secret_iv) VALUES ('u1',?,?)`).bind(l.enc, l.iv).run();
  x = await enc('sso-client-secret');
  await db.prepare(`INSERT INTO organization_sso_settings (organization_id, issuer, client_id, encrypted_client_secret, client_secret_iv, authorization_endpoint, token_endpoint, jwks_uri) VALUES ('o1','https://i','c',?,?,'https://a','https://t','https://j')`).bind(x.encryptedSecret, x.secretIv).run();
  x = await enc('{"text":"hello"}');
  await db.prepare(`INSERT INTO email_outbox (id, to_email, template, subject, body_encrypted, body_iv, status) VALUES ('m1','a@example.com','notification','s',?,?,'queued')`).bind(x.encryptedSecret, x.secretIv).run();
  await db.prepare(`INSERT INTO email_outbox (id, to_email, template, subject, body_encrypted, body_iv, status) VALUES ('m2','a@example.com','notification','s',NULL,NULL,'sent')`).run();
}
async function readAll(e) {
  const db = e.LUMMET_DB; const out = {};
  for (const t of rot.ENCRYPTED_TARGETS) {
    const rows = (await db.prepare(`SELECT ${t.pk} pk, ${t.enc} enc, ${t.iv} iv FROM ${t.table} WHERE ${t.enc} IS NOT NULL`).all()).results;
    for (const r of rows) out[`${t.table}:${r.pk}`] = await decryptSecret(e, r.enc, r.iv);
  }
  return out;
}

test('re-encryption moves every encrypted table to the new key and preserves every plaintext', async () => {
  const e = env(); await seedAll(e);
  const before = await readAll(e);
  assert.equal(Object.keys(before).length, 5, 'five encrypted values, the NULL email body is skipped');

  const r = rotated(e);
  let st = await rot.rotationStatus(r);
  assert.equal(st.rowsUnderOtherKeys, 5);
  assert.equal(st.safeToRemovePrevious, false);

  const run = await rot.reencryptAll(r);
  assert.equal(run.rotated, 5); assert.deepEqual(run.failed, []);
  st = await rot.rotationStatus(r);
  assert.equal(st.rowsUnderOtherKeys, 0);
  assert.equal(st.safeToRemovePrevious, true);

  assert.deepEqual(await readAll(r), before, 'plaintexts unchanged');
  assert.deepEqual(await readAll({ ...r, CREDENTIAL_KEK_PREVIOUS: undefined }), before, 'readable with ONLY the new key');

  const again = await rot.reencryptAll(r);
  assert.equal(again.rotated, 0, 'idempotent');
});

test('batch limit is honored and repeated runs finish the job', async () => {
  const e = env(); await seedAll(e); const r = rotated(e);
  assert.equal((await rot.reencryptAll(r, { limit: 2 })).rotated, 2);
  assert.equal((await rot.rotationStatus(r)).rowsUnderOtherKeys, 3);
  for (let i = 0; i < 3; i++) await rot.reencryptAll(r, { limit: 2 });
  assert.equal((await rot.rotationStatus(r)).rowsUnderOtherKeys, 0);
});

test('a value no configured key can read is reported (table and id only) and left untouched', async () => {
  const e = env(); await seedAll(e);
  const stranger = await encryptSecret({ CREDENTIAL_KEK: btoa('z'.repeat(32)) }, 'lost');
  await e.LUMMET_DB.prepare(`UPDATE webhooks SET encrypted_secret = ?, secret_iv = ? WHERE id = 'w1'`).bind(stranger.encryptedSecret, stranger.secretIv).run();
  const r = rotated(e);
  const run = await rot.reencryptAll(r);
  assert.deepEqual(run.failed, [{ table: 'webhooks', id: 'w1' }]);
  assert.equal(run.rotated, 4);
  const row = await e.LUMMET_DB.prepare(`SELECT encrypted_secret FROM webhooks WHERE id='w1'`).first();
  assert.equal(row.encrypted_secret, stranger.encryptedSecret);
  assert.equal((await rot.rotationStatus(r)).safeToRemovePrevious, false, 'never declared safe while something is unreadable');
});

test('retained control-plane backups under the old key block "safe to remove" until replaced', async () => {
  const e = env({ BACKUPS: fakeR2() }); await seedAll(e);
  const oldBackup = await cp.createControlPlaneBackup(e);
  assert.equal(oldBackup.ok, true);

  const r = rotated(e);
  await rot.reencryptAll(r);
  let st = await rot.rotationStatus(r);
  assert.equal(st.rowsUnderOtherKeys, 0);
  assert.equal(st.backupsUnderOtherKeys, 1);
  assert.equal(st.safeToRemovePrevious, false);

  assert.equal((await cp.verifyControlPlaneBackup(r, oldBackup.backupId)).ok, true, 'old backups remain readable while the previous key is set');

  const fresh = await cp.createControlPlaneBackup(r);
  assert.equal(fresh.ok, true);
  await r.LUMMET_DB.prepare(`UPDATE control_plane_backups SET status = 'expired' WHERE id = ?`).bind(oldBackup.backupId).run();   // what retention does
  st = await rot.rotationStatus(r);
  assert.equal(st.backupsUnderOtherKeys, 0);
  assert.equal(st.safeToRemovePrevious, true);
  assert.equal((await cp.verifyControlPlaneBackup({ ...r, CREDENTIAL_KEK_PREVIOUS: undefined }, fresh.backupId)).ok, true);
});

test('every encrypted column in the schema is covered by the rotation list', async () => {
  const e = env(); const db = e.LUMMET_DB;
  const tables = (await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all()).results.map((t) => t.name);
  const found = [];
  for (const t of tables) {
    const cols = (await db.prepare(`PRAGMA table_info("${t}")`).all()).results.map((c) => c.name);
    for (const c of cols) if (/^(encrypted_|body_encrypted)/.test(c)) found.push(`${t}.${c}`);
  }
  const listed = rot.ENCRYPTED_TARGETS.map((t) => `${t.table}.${t.enc}`);
  assert.deepEqual(found.sort(), listed.sort(), 'a new encrypted column must be added to ENCRYPTED_TARGETS');
});

test('Stripe: accepts a signature from the current OR previous secret, including during Stripe\'s two-signature rollover; rejects strangers', async () => {
  const hmac = async (secret, ts, body) => {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${ts}.${body}`)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  const reqOf = (body, header) => ({ headers: { get: (n) => (n === 'Stripe-Signature' ? header : null) }, async text() { return body; } });
  const body = JSON.stringify({ id: 'evt_1', type: 'x' }); const ts = Math.floor(Date.now() / 1000);
  const sNew = await hmac('whsec_new', ts, body), sOld = await hmac('whsec_old', ts, body), sBad = await hmac('whsec_other', ts, body);
  const both = { STRIPE_WEBHOOK_SECRET: 'whsec_new', STRIPE_WEBHOOK_SECRET_PREVIOUS: 'whsec_old' };

  assert.equal((await verifyAndParseWebhook(reqOf(body, `t=${ts},v1=${sNew}`), both)).valid, true);
  assert.equal((await verifyAndParseWebhook(reqOf(body, `t=${ts},v1=${sOld}`), both)).valid, true, 'old-secret signature accepted while previous is set');
  assert.equal((await verifyAndParseWebhook(reqOf(body, `t=${ts},v1=${sOld},v1=${sNew}`), { STRIPE_WEBHOOK_SECRET: 'whsec_new' })).valid, true, 'either order of the two signatures');
  assert.equal((await verifyAndParseWebhook(reqOf(body, `t=${ts},v1=${sNew},v1=${sOld}`), { STRIPE_WEBHOOK_SECRET: 'whsec_new' })).valid, true);
  assert.equal((await verifyAndParseWebhook(reqOf(body, `t=${ts},v1=${sOld}`), { STRIPE_WEBHOOK_SECRET: 'whsec_new' })).reason, 'signature_mismatch', 'old secret rejected once previous is removed');
  assert.equal((await verifyAndParseWebhook(reqOf(body, `t=${ts},v1=${sBad}`), both)).reason, 'signature_mismatch');
  assert.equal((await verifyAndParseWebhook(reqOf(body, `t=${ts}`), both)).reason, 'malformed_signature');
});

async function call(e, method, path, body, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.44' }); if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, { waitUntil() {} });
  const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, text: t, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}

test('staff screen shows key ids and progress (never key material); the run endpoint needs a staff session and is audited', async () => {
  const e = env({ ENVIRONMENT: 'production' }); await seedAll(e);
  const r = { ...rotated(e), ENVIRONMENT: 'production' };
  assert.equal((await call(r, 'POST', '/api/platform/saas/key-rotation/run', {})).status, 401);
  assert.ok([301, 302, 303].includes((await call(r, 'GET', '/platform/saas/key-rotation')).status));

  await call(r, 'POST', '/api/auth/bootstrap', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' });
  const cookie = (await call(r, 'POST', '/api/auth/login', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' })).cookie;

  let page = await call(r, 'GET', '/platform/saas/key-rotation', null, cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Rotation in progress/);
  assert.match(page.text, new RegExp(await activeKeyId(r)));
  assert.equal(page.text.includes(NEW), false); assert.equal(page.text.includes(OLD), false);

  assert.equal((await call(r, 'POST', '/api/platform/saas/key-rotation/run', {}, cookie)).status, 200);
  page = await call(r, 'GET', '/platform/saas/key-rotation', null, cookie);
  assert.match(page.text, /can be removed now/);
  const audit = await r.LUMMET_DB.prepare(`SELECT action, success FROM lummet_audit_logs WHERE resource = 'encryption_key_rotation'`).first();
  assert.equal(audit.action, 'reencrypt'); assert.equal(audit.success, 1);
});

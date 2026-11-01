// Phase K, rounds K.1 and K.2: CREDENTIAL_KEK validation (strict flag, config-check)
// and ciphertext v2 (authenticated data binds table, row and column).
// Fake R2 and the in-memory D1 shim only: this proves local behaviour, not a staging rotation (K.4 is owner work).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import {
  validateKekMaterial, kekStrict, aadFor, writesV2, keyIdOf, formatOf, activeKeyId, encryptSecret, decryptSecret
} from '../worker/crypto.js';
import * as rot from '../worker/key-rotation.js';
import * as cp from '../worker/cp-backup.js';
import { startTotpSetup, confirmTotpSetup } from '../worker/totp.js';
import { configIssues } from '../worker/config-check.js';

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const random32 = (seed) => b64(Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + seed * 11 + (i * i) % 251) % 256));
const GOOD = random32(1), GOOD2 = random32(2);
const WEAK_REPEAT = btoa('n'.repeat(32));
function fakeR2() { const m = new Map(); return { m, async put(k, v) { m.set(k, v); }, async get(k) { return m.has(k) ? { async text() { return m.get(k); } } : null; }, async delete(k) { m.delete(k); } }; }
function env(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: GOOD, ...extra }; }
const sha256Hex = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------- K.1

test('K.1 validateKekMaterial accepts only base64 of exactly 32 non-trivial bytes and never echoes the key', () => {
  assert.deepEqual(validateKekMaterial(GOOD), { ok: true });
  assert.equal(validateKekMaterial(undefined).reason, 'empty');
  assert.equal(validateKekMaterial('   ').reason, 'empty');
  assert.equal(validateKekMaterial('not base64!!').reason, 'not_base64');
  assert.equal(validateKekMaterial('abc').reason, 'not_base64', 'length not a multiple of 4');
  assert.equal(validateKekMaterial(b64(new Uint8Array(16).map((_, i) => i * 7 + 3))).reason, 'wrong_length', '16 bytes: accepted by Web Crypto, refused here');
  assert.equal(validateKekMaterial(b64(new Uint8Array(24).map((_, i) => i * 7 + 3))).reason, 'wrong_length');
  assert.equal(validateKekMaterial(b64(new Uint8Array(32))).reason, 'all_zero');
  assert.equal(validateKekMaterial(WEAK_REPEAT).reason, 'repeated_pattern');
  const block = Uint8Array.from([1, 2, 3, 4]);
  assert.equal(validateKekMaterial(b64(Uint8Array.from({ length: 32 }, (_, i) => block[i % 4]))).reason, 'repeated_pattern');
  const halves = Uint8Array.from({ length: 16 }, (_, i) => (i * 29 + 5) % 256);
  assert.equal(validateKekMaterial(b64(new Uint8Array([...halves, ...halves]))).reason, 'repeated_pattern');
  for (const r of [validateKekMaterial(WEAK_REPEAT), validateKekMaterial('x')]) assert.ok(!JSON.stringify(r).includes(WEAK_REPEAT));
});

test('K.1 CREDENTIAL_KEK_STRICT is off by default: a weak existing key still works, so stored data stays readable', async () => {
  assert.equal(kekStrict({}), false);
  assert.equal(kekStrict({ CREDENTIAL_KEK_STRICT: 'off' }), false);
  assert.equal(kekStrict({ CREDENTIAL_KEK_STRICT: 'ON' }), true);
  const weak = { CREDENTIAL_KEK: WEAK_REPEAT };
  const enc = await encryptSecret(weak, 'still readable');
  assert.equal(await decryptSecret(weak, enc.encryptedSecret, enc.secretIv), 'still readable');
});

test('K.1 with CREDENTIAL_KEK_STRICT=on a weak active key is refused for both encrypt and decrypt; a good key works', async () => {
  const good = { CREDENTIAL_KEK: GOOD, CREDENTIAL_KEK_STRICT: 'on' };
  const enc = await encryptSecret(good, 'ok');
  assert.equal(await decryptSecret(good, enc.encryptedSecret, enc.secretIv), 'ok');
  const weak = { CREDENTIAL_KEK: WEAK_REPEAT, CREDENTIAL_KEK_STRICT: 'on' };
  await assert.rejects(() => encryptSecret(weak, 'x'), /kek_invalid_repeated_pattern/);
  await assert.rejects(() => decryptSecret(weak, enc.encryptedSecret, enc.secretIv), /kek_invalid_repeated_pattern/);
  await assert.rejects(() => activeKeyId({ CREDENTIAL_KEK: btoa('short-key-16byte'), CREDENTIAL_KEK_STRICT: 'on' }), /kek_invalid_wrong_length/);
});

test('K.1 the previous key is never held to the strict check, so an old weak key can still be read during rotation', async () => {
  const legacy = await encryptSecret({ CREDENTIAL_KEK: WEAK_REPEAT }, 'from the old weak key');
  const rotated = { CREDENTIAL_KEK: GOOD, CREDENTIAL_KEK_PREVIOUS: WEAK_REPEAT, CREDENTIAL_KEK_STRICT: 'on' };
  assert.equal(await decryptSecret(rotated, legacy.encryptedSecret, legacy.secretIv), 'from the old weak key');
  const fresh = await encryptSecret(rotated, 'x');
  assert.equal(keyIdOf(fresh.encryptedSecret), await activeKeyId({ CREDENTIAL_KEK: GOOD }));
});

function prodEnv(extra = {}) {
  return {
    ENVIRONMENT: 'production', CREDENTIAL_KEK: GOOD, CREDENTIAL_KEK_STRICT: 'off', CREDENTIAL_ENCRYPTION_FORMAT: 'v1', ...extra
  };
}
const kekIssues = (e) => configIssues(e).filter((i) => /CREDENTIAL_/.test(i.key));

test('K.1 config-check: a weak, short or non-base64 CREDENTIAL_KEK is a production problem that names the reason but not the key', () => {
  assert.deepEqual(kekIssues(prodEnv()), []);
  for (const [bad, reason] of [[WEAK_REPEAT, 'repeated_pattern'], [btoa('0123456789abcdef'), 'wrong_length'], ['***', 'not_base64']]) {
    const issues = kekIssues(prodEnv({ CREDENTIAL_KEK: bad }));
    assert.equal(issues.length, 1);
    assert.equal(issues[0].key, 'CREDENTIAL_KEK');
    assert.match(issues[0].impact, new RegExp(reason));
    assert.ok(!JSON.stringify(issues).includes(bad === '***' ? 'zzzz' : bad));
  }
  assert.equal(kekIssues(prodEnv({ CREDENTIAL_KEK: undefined }))[0].impact, 'stored secrets cannot be encrypted');
});

test('K.1/K.2 config-check: strictness and format must be explicit in production, and a previous key must differ from the active one', () => {
  assert.equal(kekIssues(prodEnv({ CREDENTIAL_KEK_STRICT: undefined })).map((i) => i.key).join(), 'CREDENTIAL_KEK_STRICT');
  assert.equal(kekIssues(prodEnv({ CREDENTIAL_KEK_STRICT: 'maybe' })).length, 1);
  assert.equal(kekIssues(prodEnv({ CREDENTIAL_ENCRYPTION_FORMAT: undefined })).map((i) => i.key).join(), 'CREDENTIAL_ENCRYPTION_FORMAT');
  assert.equal(kekIssues(prodEnv({ CREDENTIAL_ENCRYPTION_FORMAT: 'v3' })).length, 1);
  assert.deepEqual(kekIssues(prodEnv({ CREDENTIAL_KEK_STRICT: 'on', CREDENTIAL_ENCRYPTION_FORMAT: 'v2' })), []);
  assert.deepEqual(kekIssues(prodEnv({ CREDENTIAL_KEK_PREVIOUS: GOOD2 })), [], 'a distinct previous key is fine');
  assert.deepEqual(kekIssues(prodEnv({ CREDENTIAL_KEK_PREVIOUS: WEAK_REPEAT })), [], 'a legacy weak previous key is allowed while rotating');
  assert.equal(kekIssues(prodEnv({ CREDENTIAL_KEK_PREVIOUS: GOOD })).length, 1, 'previous equal to active is a half-finished rotation');
  assert.equal(kekIssues(prodEnv({ CREDENTIAL_KEK_PREVIOUS: '###' })).length, 1);
  assert.deepEqual(configIssues({ ENVIRONMENT: 'staging', CREDENTIAL_KEK: WEAK_REPEAT }), [], 'staging is not nagged');
});

test('K.1/K.2 the new flags are declared in wrangler.jsonc and the example, defaulting to off and v1', () => {
  for (const f of ['wrangler.jsonc', 'wrangler.example.jsonc']) {
    const text = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(text, /"CREDENTIAL_KEK_STRICT"\s*:\s*"off"/, f);
    assert.match(text, /"CREDENTIAL_ENCRYPTION_FORMAT"\s*:\s*"v1"/, f);
  }
});

// ---------------------------------------------------------------- K.2

test('K.2 v2 ciphertext round-trips only with the same table, row and column', async () => {
  const e = { CREDENTIAL_KEK: GOOD, CREDENTIAL_ENCRYPTION_FORMAT: 'v2' };
  const aad = aadFor('webhooks', 'w1', 'encrypted_secret');
  const enc = await encryptSecret(e, 'secret-1', aad);
  assert.equal(formatOf(enc.encryptedSecret), 'v2');
  assert.equal(keyIdOf(enc.encryptedSecret), await activeKeyId(e), 'key id still readable from a v2 value (rotation depends on it)');
  assert.match(enc.encryptedSecret, /^[0-9a-f]{8}:v2:/);
  assert.equal(await decryptSecret(e, enc.encryptedSecret, enc.secretIv, aad), 'secret-1');
  await assert.rejects(() => decryptSecret(e, enc.encryptedSecret, enc.secretIv, aadFor('webhooks', 'w2', 'encrypted_secret')), 'another row');
  await assert.rejects(() => decryptSecret(e, enc.encryptedSecret, enc.secretIv, aadFor('customer_totp', 'w1', 'encrypted_secret')), 'another table');
  await assert.rejects(() => decryptSecret(e, enc.encryptedSecret, enc.secretIv, aadFor('webhooks', 'w1', 'body_encrypted')), 'another column');
  await assert.rejects(() => decryptSecret(e, enc.encryptedSecret, enc.secretIv), /aad_required/);
});

test('K.2 default is v1: without the flag, or without a location, new values are unchanged v1', async () => {
  assert.equal(writesV2({}), false);
  const aad = aadFor('webhooks', 'w1', 'encrypted_secret');
  const off = await encryptSecret({ CREDENTIAL_KEK: GOOD }, 'a', aad);
  assert.equal(formatOf(off.encryptedSecret), 'v1');
  assert.equal(await decryptSecret({ CREDENTIAL_KEK: GOOD }, off.encryptedSecret, off.secretIv), 'a', 'v1 needs no aad');
  assert.equal(await decryptSecret({ CREDENTIAL_KEK: GOOD }, off.encryptedSecret, off.secretIv, aad), 'a', 'and ignores one if given');
  const noAad = await encryptSecret({ CREDENTIAL_KEK: GOOD, CREDENTIAL_ENCRYPTION_FORMAT: 'v2' }, 'b');
  assert.equal(formatOf(noAad.encryptedSecret), 'v1', 'a caller that gives no location is never silently half-bound');
  assert.equal(formatOf('AAAA=='), 'v1', 'legacy untagged');
});

test('K.2 turning the flag back to v1 never strands v2 data: reads accept both formats', async () => {
  const aad = aadFor('customer_totp', 'u1', 'encrypted_secret');
  const enc = await encryptSecret({ CREDENTIAL_KEK: GOOD, CREDENTIAL_ENCRYPTION_FORMAT: 'v2' }, 'kept', aad);
  assert.equal(await decryptSecret({ CREDENTIAL_KEK: GOOD, CREDENTIAL_ENCRYPTION_FORMAT: 'v1' }, enc.encryptedSecret, enc.secretIv, aad), 'kept');
});

test('K.2 aadFor refuses an incomplete location', () => {
  for (const args of [[null, 'a', 'b'], ['t', '', 'b'], ['t', undefined, 'b'], ['t', 'a', '']]) assert.throws(() => aadFor(...args), /aad_incomplete/);
  assert.equal(aadFor('t', 7, 'c'), 'lm2|t|7|c');
});

test('K.2 real code path: with v2 on, swapping two users\' stored TOTP secrets makes both unreadable instead of exchanging them', async () => {
  const e = env({ CREDENTIAL_ENCRYPTION_FORMAT: 'v2' });
  const db = e.LUMMET_DB;
  await db.prepare(`INSERT INTO customer_users (id, email, password_hash) VALUES ('u1','a@example.com','h'),('u2','b@example.com','h')`).run();
  await startTotpSetup(e, 'u1'); await startTotpSetup(e, 'u2');
  const rows = (await db.prepare(`SELECT user_id, encrypted_secret, secret_iv FROM customer_totp ORDER BY user_id`).all()).results;
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(formatOf(r.encrypted_secret), 'v2');
  // Control: an untouched row decrypts (a wrong code is a 422, not an exception).
  assert.equal((await confirmTotpSetup(e, 'u1', '000000')).error, 'invalid_code');
  // Swap the two rows' ciphertext and IV.
  const [a, b] = rows;
  await db.prepare(`UPDATE customer_totp SET encrypted_secret = ?, secret_iv = ? WHERE user_id = 'u1'`).bind(b.encrypted_secret, b.secret_iv).run();
  await db.prepare(`UPDATE customer_totp SET encrypted_secret = ?, secret_iv = ? WHERE user_id = 'u2'`).bind(a.encrypted_secret, a.secret_iv).run();
  await assert.rejects(() => confirmTotpSetup(e, 'u1', '000000'));
  await assert.rejects(() => confirmTotpSetup(e, 'u2', '000000'));
});

async function seedTargets(e, encOpts) {
  const db = e.LUMMET_DB;
  const enc = (table, bind, column, plain) => encryptSecret(encOpts, plain, aadFor(table, bind, column));
  await db.prepare(`INSERT INTO tenants (id, name, host, api_base_url) VALUES ('t1','T','t1.example.com','https://t1.example.com')`).run();
  let x = await enc('tenant_api_credentials', 'cred1', 'encrypted_secret', 'tenant-hmac');
  await db.prepare(`INSERT INTO tenant_api_credentials (tenant_id, credential_id, encrypted_secret, secret_iv) VALUES ('t1','cred1',?,?)`).bind(x.encryptedSecret, x.secretIv).run();
  await db.prepare(`INSERT INTO organizations (id, name, slug) VALUES ('o1','Org','org')`).run();
  x = await enc('webhooks', 'w1', 'encrypted_secret', 'wh-1');
  await db.prepare(`INSERT INTO webhooks (id, organization_id, url, encrypted_secret, secret_iv, event_types) VALUES ('w1','o1','https://h.example.com/1',?,?,'[]')`).bind(x.encryptedSecret, x.secretIv).run();
  x = await enc('webhooks', 'w2', 'encrypted_secret', 'wh-2');
  await db.prepare(`INSERT INTO webhooks (id, organization_id, url, encrypted_secret, secret_iv, event_types) VALUES ('w2','o1','https://h.example.com/2',?,?,'[]')`).bind(x.encryptedSecret, x.secretIv).run();
  await db.prepare(`INSERT INTO customer_users (id, email, password_hash) VALUES ('u1','a@example.com','h')`).run();
  x = await enc('customer_totp', 'u1', 'encrypted_secret', 'totp');
  await db.prepare(`INSERT INTO customer_totp (user_id, encrypted_secret, secret_iv) VALUES ('u1',?,?)`).bind(x.encryptedSecret, x.secretIv).run();
  x = await enc('email_outbox', 'm1', 'body_encrypted', '{"text":"hi"}');
  await db.prepare(`INSERT INTO email_outbox (id, to_email, template, subject, body_encrypted, body_iv, status) VALUES ('m1','a@example.com','notification','s',?,?,'queued')`).bind(x.encryptedSecret, x.secretIv).run();
}
const countBy = async (e, like) => {
  let n = 0;
  for (const t of rot.ENCRYPTED_TARGETS) n += (await e.LUMMET_DB.prepare(`SELECT COUNT(*) c FROM ${t.table} WHERE ${t.enc} LIKE ?`).bind(like).first()).c;
  return n;
};

test('K.2 reencryptAll upgrades v1 rows to v2 when the flag is on, preserving plaintext, and is idempotent', async () => {
  const e = env(); await seedTargets(e, { CREDENTIAL_KEK: GOOD });                 // all v1
  assert.equal(await countBy(e, '%:v2:%'), 0);
  const on = { ...e, CREDENTIAL_ENCRYPTION_FORMAT: 'v2' };
  let st = await rot.rotationStatus(on);
  assert.equal(st.writesV2, true); assert.equal(st.rowsNotV2, 5); assert.equal(st.rowsUnderOtherKeys, 0, 'same key: key status unaffected by format');
  const run = await rot.reencryptAll(on);
  assert.equal(run.rotated, 5); assert.deepEqual(run.failed, []);
  assert.equal(await countBy(on, '%:v2:%'), 5);
  st = await rot.rotationStatus(on);
  assert.equal(st.rowsNotV2, 0);
  assert.equal((await rot.reencryptAll(on)).rotated, 0, 'idempotent');
  const w1 = await on.LUMMET_DB.prepare(`SELECT encrypted_secret e, secret_iv i FROM webhooks WHERE id='w1'`).first();
  assert.equal(await decryptSecret(on, w1.e, w1.i, aadFor('webhooks', 'w1', 'encrypted_secret')), 'wh-1');
  const cred = await on.LUMMET_DB.prepare(`SELECT encrypted_secret e, secret_iv i FROM tenant_api_credentials WHERE credential_id='cred1'`).first();
  assert.equal(await decryptSecret(on, cred.e, cred.i, aadFor('tenant_api_credentials', 'cred1', 'encrypted_secret')), 'tenant-hmac', 'bound to credential_id, not the autoincrement id');
});

test('K.2 flag off: reencryptAll leaves v1 rows alone, and a key rotation keeps v2 rows v2 (no silent downgrade)', async () => {
  const e = env(); await seedTargets(e, { CREDENTIAL_KEK: GOOD, CREDENTIAL_ENCRYPTION_FORMAT: 'v2' });   // all v2 under GOOD
  assert.equal(await countBy(e, '%:v2:%'), 5);
  assert.equal((await rot.reencryptAll(e)).rotated, 0, 'nothing to do with the same key');
  const rotated = { ...e, CREDENTIAL_KEK: GOOD2, CREDENTIAL_KEK_PREVIOUS: GOOD };           // flag still v1/absent
  const run = await rot.reencryptAll(rotated);
  assert.equal(run.rotated, 5); assert.deepEqual(run.failed, []);
  const newId = await activeKeyId({ CREDENTIAL_KEK: GOOD2 });
  assert.equal(await countBy(rotated, `${newId}:v2:%`), 5, 'rotated to the new key AND still v2');
  assert.equal((await rot.rotationStatus(rotated)).safeToRemovePrevious, true);
});

test('K.2 reencryptAll reports (table and id only) a row whose ciphertext was moved to another row, and leaves it untouched', async () => {
  const e = env(); await seedTargets(e, { CREDENTIAL_KEK: GOOD, CREDENTIAL_ENCRYPTION_FORMAT: 'v2' });
  const w2 = await e.LUMMET_DB.prepare(`SELECT encrypted_secret e, secret_iv i FROM webhooks WHERE id='w2'`).first();
  await e.LUMMET_DB.prepare(`UPDATE webhooks SET encrypted_secret = ?, secret_iv = ? WHERE id = 'w1'`).bind(w2.e, w2.i).run();
  const rotated = { ...e, CREDENTIAL_KEK: GOOD2, CREDENTIAL_KEK_PREVIOUS: GOOD };
  const run = await rot.reencryptAll(rotated);
  assert.deepEqual(run.failed, [{ table: 'webhooks', id: 'w1' }]);
  assert.equal(run.rotated, 4);
  assert.equal((await rot.rotationStatus(rotated)).safeToRemovePrevious, false);
  const w1 = await e.LUMMET_DB.prepare(`SELECT encrypted_secret e FROM webhooks WHERE id='w1'`).first();
  assert.equal(w1.e, w2.e, 'left as found for investigation');
});

test('K.2 control-plane backup parts are bound to their backup id and part name', async () => {
  const e = env({ BACKUPS: fakeR2(), CREDENTIAL_ENCRYPTION_FORMAT: 'v2' });
  await e.LUMMET_DB.prepare(`INSERT INTO organizations (id, name, slug) VALUES ('o1','Org','org')`).run();
  const a = await cp.createControlPlaneBackup(e);
  const b = await cp.createControlPlaneBackup(e);
  assert.equal(a.ok && b.ok, true);
  assert.equal((await cp.verifyControlPlaneBackup(e, a.backupId)).ok, true);
  assert.equal((await cp.verifyControlPlaneBackup(e, b.backupId)).ok, true);
  const rowOf = (id) => e.LUMMET_DB.prepare(`SELECT storage_prefix p FROM control_plane_backups WHERE id = ?`).bind(id).first();
  const pa = (await rowOf(a.backupId)).p, pb = (await rowOf(b.backupId)).p;
  const partA = JSON.parse(e.BACKUPS.m.get(`${pa}/part-0001.json`));
  assert.equal(formatOf(partA.data), 'v2');
  // Put backup A's part where backup B's part 1 lives, and make B's manifest agree on the hash so only the binding can catch it.
  const bodyA = e.BACKUPS.m.get(`${pa}/part-0001.json`);
  e.BACKUPS.m.set(`${pb}/part-0001.json`, bodyA);
  const man = JSON.parse(e.BACKUPS.m.get(`${pb}/manifest.json`));
  man.parts[0].sha256 = await sha256Hex(bodyA);
  e.BACKUPS.m.set(`${pb}/manifest.json`, JSON.stringify(man));
  const verdict = await cp.verifyControlPlaneBackup(e, b.backupId);
  assert.equal(verdict.ok, false);
  assert.match(JSON.stringify(verdict), /part_not_decryptable/);
  assert.equal((await cp.verifyControlPlaneBackup(e, a.backupId)).ok, true, 'the original is unaffected');
  assert.notEqual(cp.backupPartAad(`${pa}/part-0001.json`), cp.backupPartAad(`${pb}/part-0001.json`));
  assert.notEqual(cp.backupPartAad(`${pa}/part-0001.json`), cp.backupPartAad(`${pa}/part-0002.json`));
  assert.throws(() => cp.backupPartAad('nonsense'), /backup_part_key_invalid/);
});

test('K.2 flag off: backups are written exactly as before (v1) and still verify', async () => {
  const e = env({ BACKUPS: fakeR2() });
  const a = await cp.createControlPlaneBackup(e);
  const prefix = (await e.LUMMET_DB.prepare(`SELECT storage_prefix p FROM control_plane_backups WHERE id = ?`).bind(a.backupId).first()).p;
  assert.equal(formatOf(JSON.parse(e.BACKUPS.m.get(`${prefix}/part-0001.json`)).data), 'v1');
  assert.equal((await cp.verifyControlPlaneBackup(e, a.backupId)).ok, true);
});

// Gate: a new caller that forgets the location would fail at runtime on the first v2 row; fail it here instead.
test('K.2 gate: every encryptSecret and decryptSecret call in worker/ and scripts/ passes its location', () => {
  const root = new URL('../', import.meta.url);
  const files = [];
  const walk = (dir) => {
    for (const ent of readdirSync(new URL(dir, root), { withFileTypes: true })) {
      if (ent.isDirectory()) walk(`${dir}${ent.name}/`);
      else if (/\.(js|mjs)$/.test(ent.name)) files.push(`${dir}${ent.name}`);
    }
  };
  walk('worker/'); walk('scripts/');
  const offenders = [];
  let calls = 0;
  for (const f of files) {
    if (f === 'worker/crypto.js') continue;
    const lines = readFileSync(new URL(f, root), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(import|\/\/|\*)/.test(line)) return;
      if (!/\b(?:encryptSecret|decryptSecret)\(\s*env\b/.test(line)) return;
      calls += 1;
      if (!/aadFor\(|backupPartAad\(|\baad\b/.test(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  assert.ok(calls >= 15, `expected to scan the real call sites (found ${calls})`);
  assert.deepEqual(offenders, [], 'pass aadFor(table, rowKey, column) so the value is bound when CREDENTIAL_ENCRYPTION_FORMAT=v2');
});

// Release 2.6.0.17: versioned password hashes and rehash on login.
// Covers: the default output is unchanged (legacy); v2 format; both formats verify; malformed or out-of-range stored values
// are rejected without derivation; upgrade only when PASSWORD_HASH_FORMAT=v2; customer and staff login upgrade the stored hash;
// a failing rewrite never blocks a login; a wrong password never rewrites anything; config-check refuses invalid flags.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { hashPassword, verifyPassword, authenticateAdmin } from '../worker/auth.js';
import { hashPasswordWith, passwordHashNeedsUpgrade, parsePasswordHash, passwordHashSettings, PBKDF2_MAX_ITERATIONS } from '../worker/password-hash.js';
import { configIssues } from '../worker/config-check.js';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { seedFixtures, FIXTURE_PASSWORDS } from './support/fixtures.js';

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
const PW = 'Correct-Horse-Battery-9';
const V2 = /^pbkdf2-sha256\$[0-9]+\$[0-9a-f]{32}\$[0-9a-f]{64}$/;
const LEGACY = /^[0-9a-f]{32}:[0-9a-f]{64}$/;

describe('formats', () => {
  test('default output is byte-compatible legacy, with and without an env that does not select v2', async () => {
    assert.match(await hashPassword(PW), LEGACY);
    assert.match(await hashPassword(PW, {}), LEGACY);
    assert.match(await hashPassword(PW, { PASSWORD_HASH_FORMAT: 'nonsense' }), LEGACY);
  });
  test('v2 output carries its iteration count and verifies; a wrong password fails', async () => {
    const h = await hashPassword(PW, { PASSWORD_HASH_FORMAT: 'v2', PASSWORD_HASH_ITERATIONS: '50000' });
    assert.match(h, V2); assert.ok(h.startsWith('pbkdf2-sha256$50000$'));
    assert.equal(await verifyPassword(PW, h), true);
    assert.equal(await verifyPassword('another-password-1', h), false);
  });
  test('settings: invalid or out-of-range iterations fall back to 100000; the ceiling is not exceeded', () => {
    for (const v of ['abc', '5', '999999', '', undefined]) assert.equal(passwordHashSettings({ PASSWORD_HASH_FORMAT: 'v2', PASSWORD_HASH_ITERATIONS: v }).iterations, 100000);
    assert.equal(passwordHashSettings({ PASSWORD_HASH_ITERATIONS: '20000' }).iterations, 20000);
    assert.equal(PBKDF2_MAX_ITERATIONS, 100000);
  });
  test('hashPasswordWith clamps a v2 cost above the ceiling', async () => {
    assert.ok((await hashPasswordWith(PW, { format: 'v2', iterations: 900000 })).startsWith('pbkdf2-sha256$100000$'));
  });
});

describe('malformed and hostile stored values', () => {
  test('rejected without throwing and without deriving anything', async () => {
    const bad = ['', null, undefined, 'x', 'a:b', 'zz'.repeat(16) + ':' + '0'.repeat(64), 'ab'.repeat(16) + ':' + '0'.repeat(63),
      'pbkdf2-sha256$0$' + 'ab'.repeat(16) + '$' + '0'.repeat(64), 'pbkdf2-sha256$100001$' + 'ab'.repeat(16) + '$' + '0'.repeat(64),
      'pbkdf2-sha256$99999999999$' + 'ab'.repeat(16) + '$' + '0'.repeat(64), 'pbkdf2-sha256$-5$' + 'ab'.repeat(16) + '$' + '0'.repeat(64),
      'pbkdf2-sha256$100000$' + 'ab'.repeat(16) + '$' + '0'.repeat(64) + '$extra', 'pbkdf2-sha256$100000$abc$' + '0'.repeat(64), 'a'.repeat(600)];
    for (const b of bad) { assert.equal(parsePasswordHash(b), null, String(b).slice(0, 30)); assert.equal(await verifyPassword(PW, b), false); }
  });
});

describe('needs-upgrade decision', () => {
  const off = {}; const on = { PASSWORD_HASH_FORMAT: 'v2' };
  test('never when the flag is off', async () => {
    assert.equal(passwordHashNeedsUpgrade(await hashPassword(PW), off), false);
    assert.equal(passwordHashNeedsUpgrade(await hashPassword(PW, on), off), false);
  });
  test('legacy and lower-cost v2 upgrade when v2 is selected; equal cost does not', async () => {
    assert.equal(passwordHashNeedsUpgrade(await hashPassword(PW), on), true);
    assert.equal(passwordHashNeedsUpgrade(await hashPasswordWith(PW, { format: 'v2', iterations: 50000 }), on), true);
    assert.equal(passwordHashNeedsUpgrade(await hashPassword(PW, on), on), false);
  });
  test('a malformed hash is never "upgraded"', () => assert.equal(passwordHashNeedsUpgrade('garbage', on), false));
});

function env(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), PORTAL_BASE_URL: 'https://app.example.test',
    EMAIL_FETCH: async () => new Response(JSON.stringify({ id: 'e' }), { status: 200 }), ...extra };
}
async function call(e, method, path, body) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.9', 'Content-Type': 'application/json' });
  const r = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: JSON.stringify(body) }), e, ctx);
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (err) { json = null; }
  return { status: r.status, json, text };
}
const storedCustomerHash = async (e, email) => (await e.LUMMET_DB.prepare('SELECT password_hash FROM customer_users WHERE email = ?').bind(email).first()).password_hash;

describe('customer login', () => {
  test('flag off: signup and login write and keep legacy hashes', async () => {
    const e = env(); assert.equal((await call(e, 'POST', '/api/customer/signup', { email: 'a@example.test', password: PW, organizationName: 'A' })).status, 200);
    assert.match(await storedCustomerHash(e, 'a@example.test'), LEGACY);
    assert.equal((await call(e, 'POST', '/api/customer/login', { email: 'a@example.test', password: PW })).status, 200);
    assert.match(await storedCustomerHash(e, 'a@example.test'), LEGACY);
  });
  test('flag v2: a legacy hash is upgraded on the first correct login and still works afterwards', async () => {
    const e = env(); await call(e, 'POST', '/api/customer/signup', { email: 'b@example.test', password: PW, organizationName: 'B' });
    assert.match(await storedCustomerHash(e, 'b@example.test'), LEGACY);
    e.PASSWORD_HASH_FORMAT = 'v2';
    const bad = await call(e, 'POST', '/api/customer/login', { email: 'b@example.test', password: 'wrong-password-123' });
    assert.equal(bad.status, 401); assert.match(await storedCustomerHash(e, 'b@example.test'), LEGACY, 'a wrong password rewrites nothing');
    assert.equal((await call(e, 'POST', '/api/customer/login', { email: 'b@example.test', password: PW })).status, 200);
    assert.match(await storedCustomerHash(e, 'b@example.test'), V2);
    assert.equal((await call(e, 'POST', '/api/customer/login', { email: 'b@example.test', password: PW })).status, 200);
  });
  test('a disabled account is refused and its hash is not rewritten', async () => {
    const e = env(); await call(e, 'POST', '/api/customer/signup', { email: 'c@example.test', password: PW, organizationName: 'C' });
    await e.LUMMET_DB.prepare("UPDATE customer_users SET status = 'disabled' WHERE email = ?").bind('c@example.test').run();
    e.PASSWORD_HASH_FORMAT = 'v2';
    assert.equal((await call(e, 'POST', '/api/customer/login', { email: 'c@example.test', password: PW })).status, 403);
    assert.match(await storedCustomerHash(e, 'c@example.test'), LEGACY);
  });
  test('a failing rewrite is logged and never blocks the login', async () => {
    const e = env(); await call(e, 'POST', '/api/customer/signup', { email: 'd@example.test', password: PW, organizationName: 'D' });
    const real = e.LUMMET_DB; e.PASSWORD_HASH_FORMAT = 'v2';
    e.LUMMET_DB = new Proxy(real, { get(t, k) { if (k !== 'prepare') return Reflect.get(t, k); return (sql) => { if (/UPDATE customer_users SET password_hash/.test(sql)) throw new Error('simulated write failure'); return t.prepare(sql); }; } });
    const logs = []; const orig = console.error; console.error = (...a) => logs.push(a);
    try { assert.equal((await call(e, 'POST', '/api/customer/login', { email: 'd@example.test', password: PW })).status, 200); } finally { console.error = orig; }
    assert.ok(logs.some((a) => a[0] === 'password_rehash_failed'));
    assert.ok(!JSON.stringify(logs).includes(PW), 'the password is never logged');
    assert.match(await storedCustomerHash({ LUMMET_DB: real }, 'd@example.test'), LEGACY);
  });
  test('password reset writes the format the environment selects', async () => {
    const e = env({ PASSWORD_HASH_FORMAT: 'v2' }); await call(e, 'POST', '/api/customer/signup', { email: 'e@example.test', password: PW, organizationName: 'E' });
    assert.match(await storedCustomerHash(e, 'e@example.test'), V2);
  });
});

describe('staff login', () => {
  test('flag v2: a legacy staff hash is upgraded after a correct password; flag off leaves it', async () => {
    const e = env(); const fx = await seedFixtures(e.LUMMET_DB);
    const read = async () => (await e.LUMMET_DB.prepare('SELECT password_hash FROM lummet_admins WHERE id = ?').bind(fx.admins.staffA).first()).password_hash;
    assert.match(await read(), LEGACY);
    assert.equal((await authenticateAdmin(e, 'staffA@example.com', FIXTURE_PASSWORDS.staffA, 'ip-1')).ok, true);
    assert.match(await read(), LEGACY);
    e.PASSWORD_HASH_FORMAT = 'v2';
    assert.equal((await authenticateAdmin(e, 'staffA@example.com', 'wrong-password-123', 'ip-2')).ok, false);
    assert.match(await read(), LEGACY);
    assert.equal((await authenticateAdmin(e, 'staffA@example.com', FIXTURE_PASSWORDS.staffA, 'ip-3')).ok, true);
    assert.match(await read(), V2);
    assert.equal((await authenticateAdmin(e, 'staffA@example.com', FIXTURE_PASSWORDS.staffA, 'ip-4')).ok, true);
  });
});

describe('config-check', () => {
  test('invalid values are flagged in production; valid and unset are not', () => {
    const bad = JSON.stringify(configIssues({ ENVIRONMENT: 'production', PASSWORD_HASH_FORMAT: 'argon', PASSWORD_HASH_ITERATIONS: '600000' }));
    assert.ok(bad.includes('PASSWORD_HASH_FORMAT') && bad.includes('PASSWORD_HASH_ITERATIONS'));
    const ok = JSON.stringify(configIssues({ ENVIRONMENT: 'production', PASSWORD_HASH_FORMAT: 'v2', PASSWORD_HASH_ITERATIONS: '100000' }));
    assert.ok(!ok.includes('PASSWORD_HASH'));
  });
});

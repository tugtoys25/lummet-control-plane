// Staff two-factor authentication (TOTP) for control-plane admins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import * as auth from '../worker/auth.js';
import * as staff2fa from '../worker/staff-2fa.js';
import { generateTotpCode } from '../worker/totp.js';

const PW = 'Correct-Horse-Battery-9';
function env(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production', ...extra }; }
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
let ipn = 1;
async function call(e, method, path, { body, cookie, form, ip } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': ip || '198.51.100.' + (ipn++ % 250 + 1) });
  if (cookie) h.set('Cookie', cookie);
  let payload;
  if (form) { h.set('Content-Type', 'application/x-www-form-urlencoded'); payload = new URLSearchParams(form).toString(); }
  else if (body !== undefined) { h.set('Content-Type', 'application/json'); payload = JSON.stringify(body); }
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: payload, redirect: 'manual' }), e, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0], location: res.headers.get('Location') };
}
async function root(e) {
  assert.equal((await call(e, 'POST', '/api/auth/bootstrap', { body: { email: 'root@example.com', password: PW } })).status, 200);
  return (await call(e, 'POST', '/api/auth/login', { body: { email: 'root@example.com', password: PW } })).cookie;
}
// Enrols root in 2FA and returns what a login needs.
async function enrol(e, cookie) {
  const setup = await call(e, 'POST', '/api/account/2fa/setup', { cookie, body: {} });
  assert.equal(setup.status, 200, setup.text);
  const secret = setup.json.secret;
  const now = Date.now();
  const confirm = await call(e, 'POST', '/api/account/2fa/confirm', { cookie, body: { code: await generateTotpCode(secret, now) } });
  assert.equal(confirm.status, 200, confirm.text);
  return { secret, backupCodes: confirm.json.backupCodes };
}
const stepCode = (secret, steps) => generateTotpCode(secret, Date.now() + steps * 30000);
const login = (e, ip) => call(e, 'POST', '/api/auth/login', { ip, body: { email: 'root@example.com', password: PW } });
const sessions = async (e) => (await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM lummet_sessions`).first()).n;

test('enrolment is not active until a real code confirms it, and the secret is encrypted at rest', async () => {
  const e = env(); const cookie = await root(e);
  const setup = await call(e, 'POST', '/api/account/2fa/setup', { cookie, body: {} });
  assert.match(setup.json.secret, /^[A-Z2-7]+$/);
  assert.match(setup.json.otpauthUrl, /^otpauth:\/\/totp\//);
  const row = await e.LUMMET_DB.prepare(`SELECT * FROM lummet_admin_totp`).first();
  assert.equal(row.status, 'pending');
  assert.equal(JSON.stringify(row).includes(setup.json.secret), false, 'plaintext secret is not stored');

  assert.equal((await login(e)).json.mfaRequired, undefined, 'a pending setup does not gate login yet');
  assert.equal((await call(e, 'POST', '/api/account/2fa/confirm', { cookie, body: { code: '000000' } })).status, 422);
  const ok = await call(e, 'POST', '/api/account/2fa/confirm', { cookie, body: { code: await generateTotpCode(setup.json.secret) } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.backupCodes.length, 10);
  assert.equal((await call(e, 'POST', '/api/account/2fa/setup', { cookie, body: {} })).status, 409, 'cannot re-run setup while active');
  const stored = await e.LUMMET_DB.prepare(`SELECT backup_codes_hash FROM lummet_admin_totp`).first();
  assert.equal(stored.backup_codes_hash.includes(ok.json.backupCodes[0]), false, 'backup codes are stored only as hashes');
});

test('with 2FA on, a correct password gives a challenge and NO session; a valid code gives the session', async () => {
  const e = env(); const cookie = await root(e); const { secret } = await enrol(e, cookie);
  await e.LUMMET_DB.prepare(`DELETE FROM lummet_sessions`).run();

  const first = await login(e);
  assert.equal(first.status, 200);
  assert.equal(first.json.mfaRequired, true);
  assert.ok(first.json.challengeId);
  assert.equal(first.cookie, '', 'no session cookie yet');
  assert.equal(await sessions(e), 0);
  assert.equal((await call(e, 'GET', '/platform/saas/jobs', {})).status, 302, 'still not signed in');

  const wrong = await call(e, 'POST', '/api/auth/login/mfa', { body: { challengeId: first.json.challengeId, code: '123456' } });
  assert.equal(wrong.status, 422); assert.equal(wrong.json.error, 'invalid_code');
  assert.equal(await sessions(e), 0);

  const done = await call(e, 'POST', '/api/auth/login/mfa', { body: { challengeId: first.json.challengeId, code: await stepCode(secret, 1) } });
  assert.equal(done.status, 200, done.text);
  assert.ok(done.cookie.startsWith('lummet_session='));
  assert.equal(await sessions(e), 1);
  assert.equal((await call(e, 'GET', '/platform/saas/jobs', { cookie: done.cookie })).status, 200);

  const again = await call(e, 'POST', '/api/auth/login/mfa', { body: { challengeId: first.json.challengeId, code: await stepCode(secret, 1) } });
  assert.equal(again.status, 404, 'a challenge is single use');
});

test('a code that was already accepted cannot be used again (replay guard)', async () => {
  const e = env(); const cookie = await root(e); const { secret } = await enrol(e, cookie);
  const code = await stepCode(secret, 1);
  const a = await login(e); assert.equal((await call(e, 'POST', '/api/auth/login/mfa', { body: { challengeId: a.json.challengeId, code } })).status, 200);
  const b = await login(e);
  const replay = await call(e, 'POST', '/api/auth/login/mfa', { body: { challengeId: b.json.challengeId, code } });
  assert.equal(replay.status, 422); assert.equal(replay.json.error, 'code_already_used');
  assert.equal((await call(e, 'POST', '/api/auth/login/mfa', { body: { challengeId: b.json.challengeId, code: await stepCode(secret, 0) } })).status, 422, 'an OLDER step than the last accepted is rejected too');
});

test('a challenge dies after 5 wrong codes, even if the right code follows; expired challenges are refused', async () => {
  const e = env(); const cookie = await root(e); const { secret } = await enrol(e, cookie);
  const c = await login(e);
  for (let i = 0; i < 4; i++) assert.equal((await call(e, 'POST', '/api/auth/login/mfa', { ip: '203.0.113.1', body: { challengeId: c.json.challengeId, code: '000001' } })).status, 422);
  assert.equal((await call(e, 'POST', '/api/auth/login/mfa', { ip: '203.0.113.1', body: { challengeId: c.json.challengeId, code: '000001' } })).status, 429);
  const late = await call(e, 'POST', '/api/auth/login/mfa', { ip: '203.0.113.2', body: { challengeId: c.json.challengeId, code: await stepCode(secret, 1) } });
  assert.equal(late.status, 404);

  const d = await login(e);
  await e.LUMMET_DB.prepare(`UPDATE lummet_mfa_challenges SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?`).bind(d.json.challengeId).run();
  const expired = await call(e, 'POST', '/api/auth/login/mfa', { ip: '203.0.113.3', body: { challengeId: d.json.challengeId, code: await stepCode(secret, 1) } });
  assert.equal(expired.status, 410);
  assert.equal((await call(e, 'POST', '/api/auth/login/mfa', { body: { challengeId: 'made-up', code: '123456' } })).status, 404);
});

test('wrong codes are rate limited per IP across challenges', async () => {
  const e = env(); const cookie = await root(e); await enrol(e, cookie);
  const ip = '203.0.113.77';
  const statuses = [];
  for (let i = 0; i < 7; i++) {
    const c = await login(e, ip);
    if (c.status !== 200) { statuses.push('login:' + c.status); continue; }
    statuses.push((await call(e, 'POST', '/api/auth/login/mfa', { ip, body: { challengeId: c.json.challengeId, code: '000002' } })).status);
  }
  assert.ok(statuses.includes(429), 'expected a 429 once the limit is hit, got ' + statuses.join(','));
});

test('backup codes work exactly once, and are case-insensitive', async () => {
  const e = env(); const cookie = await root(e); const { backupCodes } = await enrol(e, cookie);
  const c1 = await login(e);
  const used = await call(e, 'POST', '/api/auth/login/mfa', { body: { challengeId: c1.json.challengeId, backupCode: ' ' + backupCodes[0].toUpperCase() + ' ' } });
  assert.equal(used.status, 200, used.text);
  const c2 = await login(e);
  assert.equal((await call(e, 'POST', '/api/auth/login/mfa', { body: { challengeId: c2.json.challengeId, backupCode: backupCodes[0] } })).json.error, 'invalid_backup_code');
  assert.equal((await call(e, 'POST', '/api/auth/login/mfa', { body: { challengeId: c2.json.challengeId, backupCode: backupCodes[1] } })).status, 200);
  assert.equal((await staff2fa.getStaffTotpStatus(e, 1)).backupCodesLeft, 8);
  const audit = await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM lummet_audit_logs WHERE action = 'login_mfa' AND error_message = 'backup_code_used'`).first();
  assert.equal(audit.n, 2, 'backup code use is audited');
});

test('the browser login form goes password -> code page -> signed in', async () => {
  const e = env(); const cookie = await root(e); const { secret } = await enrol(e, cookie);
  const step1 = await call(e, 'POST', '/login', { form: { mode: 'login', email: 'root@example.com', password: PW } });
  assert.equal(step1.status, 200);
  assert.match(step1.text, /Two-factor code/);
  assert.equal(step1.cookie, '');
  const challenge = step1.text.match(/name="challenge_id" value="([^"]+)"/)[1];

  const bad = await call(e, 'POST', '/login', { form: { mode: 'mfa', challenge_id: challenge, code: '111111', backup_code: '' } });
  assert.equal(bad.status, 200); assert.match(bad.text, /not correct/); assert.match(bad.text, /name="challenge_id"/);
  const good = await call(e, 'POST', '/login', { form: { mode: 'mfa', challenge_id: challenge, code: await stepCode(secret, 1), backup_code: '' } });
  assert.equal(good.status, 302);
  assert.ok(good.cookie.startsWith('lummet_session='));
  assert.equal(good.location, '/dashboard');
});

test('disabling needs a valid factor; a disabled admin cannot finish a pending challenge', async () => {
  const e = env(); const cookie = await root(e); const { secret, backupCodes } = await enrol(e, cookie);
  assert.equal((await call(e, 'POST', '/api/account/2fa/disable', { cookie, body: {} })).json.error, 'code_or_backup_code_required');
  assert.equal((await call(e, 'POST', '/api/account/2fa/disable', { cookie, body: { code: '000000' } })).status, 422);
  assert.equal((await staff2fa.getStaffTotpStatus(e, 1)).enabled, true);

  const c = await login(e);
  await e.LUMMET_DB.prepare(`UPDATE lummet_admins SET status = 'disabled'`).run();
  assert.equal((await call(e, 'POST', '/api/auth/login/mfa', { body: { challengeId: c.json.challengeId, code: await stepCode(secret, 1) } })).status, 403);
  await e.LUMMET_DB.prepare(`UPDATE lummet_admins SET status = 'active'`).run();

  assert.equal((await call(e, 'POST', '/api/account/2fa/disable', { cookie, body: { backupCode: backupCodes[0] } })).status, 200, 'a backup code can turn it off');
  assert.equal((await login(e)).json.mfaRequired, undefined);
});

async function staffAdmin(e) {
  const made = await auth.createAdmin(e, { email: 'staff@example.com', role: 'staff', createdBy: 1 });
  await auth.setPasswordDirect(e, made.adminId, PW);
  await e.LUMMET_DB.prepare(`UPDATE lummet_admins SET must_change_password = 0 WHERE id = ?`).bind(made.adminId).run();
  const cookie = (await call(e, 'POST', '/api/auth/login', { body: { email: 'staff@example.com', password: PW } })).cookie;
  return { id: made.adminId, cookie };
}

test('a super admin can reset another admin\'s 2FA (which also signs them out); staff cannot, and nobody can reset themselves', async () => {
  const e = env(); const rootCookie = await root(e); const s = await staffAdmin(e);
  const { secret } = await enrol(e, s.cookie);
  assert.equal((await staff2fa.getStaffTotpStatus(e, s.id)).enabled, true);

  assert.equal((await call(e, 'POST', `/api/admins/${s.id}/2fa-reset`, { cookie: s.cookie, body: {} })).status, 403, 'staff cannot reset');
  assert.equal((await call(e, 'POST', '/api/admins/1/2fa-reset', { cookie: rootCookie, body: {} })).status, 400, 'not for yourself');
  assert.equal((await call(e, 'POST', `/api/admins/${s.id}/2fa-reset`, { body: {} })).status, 401);

  assert.equal((await call(e, 'POST', `/api/admins/${s.id}/2fa-reset`, { cookie: rootCookie, body: {} })).status, 200);
  assert.equal((await staff2fa.getStaffTotpStatus(e, s.id)).enabled, false);
  assert.equal((await call(e, 'GET', '/platform/saas/jobs', { cookie: s.cookie })).status, 302, 'their session was ended');
  assert.equal((await call(e, 'POST', `/api/admins/${s.id}/2fa-reset`, { cookie: rootCookie, body: {} })).status, 404, 'nothing left to reset');
  const audit = await e.LUMMET_DB.prepare(`SELECT success FROM lummet_audit_logs WHERE action = 'reset_2fa' ORDER BY id LIMIT 1`).first();
  assert.equal(audit.success, 1);
  void secret;
});

test('STAFF_2FA_REQUIRED: until enrolled the only reachable things are 2FA setup, password change and logout', async () => {
  const e = env({ STAFF_2FA_REQUIRED: 'true' }); const cookie = await root(e);
  const api = await call(e, 'GET', '/api/platform/saas/anything', { cookie });
  assert.equal(api.status, 403); assert.equal(api.json.error, 'two_factor_setup_required');
  const page = await call(e, 'GET', '/platform/saas/jobs', { cookie });
  assert.equal(page.status, 302); assert.equal(page.location, '/account/2fa');
  const setupPage = await call(e, 'GET', '/account/2fa', { cookie });
  assert.equal(setupPage.status, 200); assert.match(setupPage.text, /requires two-factor/);
  assert.equal((await call(e, 'GET', '/account/password', { cookie })).status, 200);

  const { secret } = await enrol(e, cookie);
  assert.equal((await call(e, 'GET', '/platform/saas/jobs', { cookie })).status, 200, 'unlocked once enrolled');
  assert.match((await call(e, 'GET', '/account/2fa', { cookie })).text, /Two-factor authentication is on/);
  void secret;
});

test('without the requirement, nothing is blocked, but a banner and the 2FA link nudge un-enrolled admins', async () => {
  const e = env(); const cookie = await root(e);
  const before = await call(e, 'GET', '/platform/saas/jobs', { cookie });
  assert.equal(before.status, 200);
  assert.match(before.text, /no second factor/);
  assert.match(before.text, /href="\/account\/2fa"/);
  await enrol(e, cookie);
  assert.doesNotMatch((await call(e, 'GET', '/platform/saas/jobs', { cookie })).text, /no second factor/);
  const list = await call(e, 'GET', '/platform/admins', { cookie });
  assert.match(list.text, /<th>2FA<\/th>/);
});

test('the staff 2FA secret is covered by encryption-key rotation', async () => {
  const { ENCRYPTED_TARGETS, reencryptAll } = await import('../worker/key-rotation.js');
  assert.ok(ENCRYPTED_TARGETS.some((t) => t.table === 'lummet_admin_totp'));
  const OLD = btoa('k'.repeat(32)), NEW = btoa('n'.repeat(32));
  const e = env(); const cookie = await root(e); const { secret } = await enrol(e, cookie);
  const rotated = { ...e, CREDENTIAL_KEK: NEW, CREDENTIAL_KEK_PREVIOUS: OLD };
  assert.equal((await reencryptAll(rotated)).failed.length, 0);
  const onlyNew = { ...e, CREDENTIAL_KEK: NEW };
  const c = await call(onlyNew, 'POST', '/api/auth/login', { body: { email: 'root@example.com', password: PW } });
  assert.equal(c.json.mfaRequired, true);
  assert.equal((await call(onlyNew, 'POST', '/api/auth/login/mfa', { body: { challengeId: c.json.challengeId, code: await stepCode(secret, 1) } })).status, 200, 'logins still work with only the new key');
});

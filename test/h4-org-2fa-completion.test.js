// Release 2.6.1.6, round H.4: organization 2FA completion. The QR code on the enrollment page, the passkey rule (ORG_2FA_PASSKEY_COUNTS) and
// the multi-organization rule (ORG_2FA_SCOPE). Real Worker entry point, migrated in-memory database, real signed WebAuthn assertions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as totp from '../worker/totp.js';
import * as webauthn from '../worker/webauthn.js';
import { qrModules, qrPath, qrForText, MAX_VERSION } from '../worker/qr.js';
import * as repo from '../worker/repositories/org-security-policy.js';
import { evaluateSessionUse, orgRouteDenied, passkeyCountsFor2fa, orgPolicyScope } from '../worker/org-security-policy.js';
import { configIssues } from '../worker/config-check.js';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { buildRegistrationCredential, buildAuthenticationAssertion, RP_ID, ORIGIN } from './support/webauthn-fixtures.js';

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
const PW = 'Correct-Horse-Battery-9';
let ip = 0;

// ------------------------------------------------------------------ QR code

// Independent checks on the matrix. The encoder was also verified by decoding rendered images with OpenCV (see the golden vectors below).
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i += 1) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]; })();
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const syndromesAllZero = (codeword, ecc) => {
  for (let i = 0; i < ecc; i += 1) { let acc = 0; for (const c of codeword) acc = mul(acc, EXP[i]) ^ c; if (acc !== 0) return false; }
  return true;
};
const M_TABLE = { 1: [16, 1, 0, 0, 10], 2: [28, 1, 0, 0, 16], 3: [44, 1, 0, 0, 26], 4: [32, 2, 0, 0, 18], 5: [43, 2, 0, 0, 24], 6: [27, 4, 0, 0, 16], 7: [31, 4, 0, 0, 18], 8: [38, 2, 39, 2, 22], 9: [36, 3, 37, 2, 22], 10: [43, 4, 44, 1, 26] };
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
const MASK_FN = [(r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0, (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0];

function functionMap(version, size) {
  const f = Array.from({ length: size }, () => new Array(size).fill(false));
  const box = (r0, c0, h, w) => { for (let r = r0; r < r0 + h; r += 1) for (let c = c0; c < c0 + w; c += 1) if (r >= 0 && c >= 0 && r < size && c < size) f[r][c] = true; };
  box(0, 0, 9, 9); box(0, size - 8, 9, 8); box(size - 8, 0, 8, 9);
  for (let i = 0; i < size; i += 1) { f[6][i] = true; f[i][6] = true; }
  const cs = ALIGN[version];
  for (const r of cs) for (const c of cs) { if ((r === 6 && c === 6) || (r === 6 && c === cs.at(-1)) || (c === 6 && r === cs.at(-1))) continue; box(r - 2, c - 2, 5, 5); }
  if (version >= 7) { box(0, size - 11, 6, 3); box(size - 11, 0, 3, 6); }
  return f;
}
function readBack(qr) {
  const { size, version, modules } = qr;
  // mask from the first copy of the format information, found by trying all 8 (BCH computed here, not taken from the encoder)
  let fmt = 0;
  for (let i = 0; i <= 5; i += 1) fmt |= (modules[i][8] ? 1 : 0) << i;
  fmt |= (modules[7][8] ? 1 : 0) << 6; fmt |= (modules[8][8] ? 1 : 0) << 7; fmt |= (modules[8][7] ? 1 : 0) << 8;
  for (let i = 9; i < 15; i += 1) fmt |= (modules[8][14 - i] ? 1 : 0) << i;
  let mask = -1;
  for (let m = 0; m < 8; m += 1) {
    let v = m << 10; for (let i = 14; i >= 10; i -= 1) if ((v >>> i) & 1) v ^= 0x537 << (i - 10);
    if ((((0 << 13) | (m << 10) | v) ^ 0x5412) === fmt) mask = m;
  }
  assert.ok(mask >= 0, 'format information is a valid level-M codeword');
  const f = functionMap(version, size);
  const bits = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let n = 0; n < size; n += 1) {
      const row = upward ? size - 1 - n : n;
      for (let k = 0; k < 2; k += 1) { const c = col - k; if (!f[row][c]) bits.push((modules[row][c] ? 1 : 0) ^ (MASK_FN[mask](row, c) ? 1 : 0)); }
    }
    upward = !upward;
  }
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  const [d1, n1, d2, n2, ecc] = M_TABLE[version];
  const lens = [...Array(n1).fill(d1), ...Array(n2).fill(d2)];
  const totalData = lens.reduce((a, b) => a + b, 0);
  const blocks = lens.map(() => []); const eccs = lens.map(() => []);
  let at = 0;
  for (let i = 0; i < Math.max(d1, d2); i += 1) lens.forEach((len, b) => { if (i < len) blocks[b].push(bytes[at++]); });
  for (let i = 0; i < ecc; i += 1) lens.forEach((_, b) => { eccs[b].push(bytes[at++]); });
  blocks.forEach((data, b) => assert.ok(syndromesAllZero([...data, ...eccs[b]], ecc), `block ${b}: Reed-Solomon syndromes are zero`));
  const stream = blocks.flat(); assert.equal(stream.length, totalData);
  const bitStr = stream.map((b) => b.toString(2).padStart(8, '0')).join('');
  assert.equal(bitStr.slice(0, 4), '0100', 'byte mode');
  const lenBits = version <= 9 ? 8 : 16;
  const count = parseInt(bitStr.slice(4, 4 + lenBits), 2);
  const out = []; for (let i = 0; i < count; i += 1) out.push(parseInt(bitStr.slice(4 + lenBits + i * 8, 4 + lenBits + i * 8 + 8), 2));
  return new TextDecoder().decode(new Uint8Array(out));
}

test('H.4 QR: every version from 1 to 10 reads back to the exact text, with zero Reed-Solomon syndromes in every block', () => {
  const seen = new Set();
  for (const len of [1, 10, 14, 20, 26, 32, 42, 53, 62, 78, 84, 106, 122, 130, 152, 154, 180, 213]) {
    const text = Array.from({ length: len }, (_, i) => String.fromCharCode(33 + ((i * 7 + len * 13) % 90))).join('');
    const qr = qrModules(text); seen.add(qr.version);
    assert.equal(qr.size, 17 + 4 * qr.version);
    assert.equal(readBack(qr), text, `len ${len}`);
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(readBack(qrModules('héllo wörld ✓ 日本語')), 'héllo wörld ✓ 日本語', 'UTF-8');
});

test('H.4 QR: fixed structure is right (finders, timing, dark module, alignment, version info) and the encoder refuses too-long input', () => {
  for (const text of ['a', 'x'.repeat(60), 'y'.repeat(150)]) {
    const q = qrModules(text), m = q.modules, n = q.size;
    for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      for (let r = 0; r < 7; r += 1) for (let c = 0; c < 7; c += 1) {
        const want = r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        assert.equal(m[r0 + r][c0 + c], want, `finder ${r0},${c0} at ${r},${c}`);
      }
    }
    for (let i = 8; i < n - 8; i += 1) { assert.equal(m[6][i], i % 2 === 0); assert.equal(m[i][6], i % 2 === 0); }
    assert.equal(m[n - 8][8], true, 'always-dark module');
    if (q.version >= 2) { const c = ALIGN[q.version].at(-1); assert.equal(m[c][c], true); assert.equal(m[c - 1][c - 1], false); assert.equal(m[c - 2][c - 2], true); }
  }
  assert.throws(() => qrModules('z'.repeat(214)), /qr_too_long/);
  assert.equal(qrModules('z'.repeat(213)).version, 10, '213 bytes is the largest that fits');
  assert.equal(MAX_VERSION, 10);
  assert.deepEqual(qrModules('same input'), qrModules('same input'), 'deterministic');
});

// These four matrices were rendered to images and decoded with OpenCV's QR decoder (an independent implementation) when this test was written,
// and each decoded to exactly its input. Any change to the encoder that alters them has to be re-verified the same way.
const GOLDEN = {
  'hello': null, 'otpauth://totp/Lummet:user%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Lummet&algorithm=SHA1&digits=6&period=30': null, '0123456789': null, 'héllo wörld ✓ 日本語': null
};
test('H.4 QR: golden vectors (decoded by an independent decoder when created) do not change', () => {
  const fp = (t) => createHash('sha256').update(qrModules(t).modules.map((r) => r.map((v) => (v ? 1 : 0)).join('')).join('/')).digest('hex').slice(0, 16);
  const golden = JSON.parse(readFileSync(new URL('./support/qr-golden.json', import.meta.url), 'utf8'));
  for (const text of Object.keys(GOLDEN)) assert.equal(fp(text), golden[text], text.slice(0, 30));
});

test('H.4 QR: qrPath is exactly the dark modules, and qrForText carries size and path only', () => {
  const text = 'otpauth://totp/Lummet:a%40b.test?secret=ABCDEFGHIJKLMNOP&issuer=Lummet';
  const qr = qrModules(text);
  const rebuilt = Array.from({ length: qr.size }, () => new Array(qr.size).fill(false));
  for (const m of qrPath(qr).matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) for (let k = 0; k < Number(m[3]); k += 1) rebuilt[Number(m[2])][Number(m[1]) + k] = true;
  assert.deepEqual(rebuilt, qr.modules);
  assert.deepEqual(Object.keys(qrForText(text)).sort(), ['path', 'size']);
});

// ------------------------------------------------------------------ the world for the 2FA rules

function newEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, ORG_SECURITY_POLICY: 'enforce', CUSTOMER_2FA_ENROLL_PAGE: 'on', WEBAUTHN_RP_ID: RP_ID, WEBAUTHN_ORIGIN: ORIGIN, PORTAL_BASE_URL: ORIGIN,
    CREDENTIAL_KEK: btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 37 + 11 + (i * i) % 251) % 256))),
    EMAIL_FETCH: async () => new Response(JSON.stringify({ id: 'fake-email' }), { status: 200 }), ...extra };
}
async function call(e, method, path, body, cookie) {
  ip += 1;
  const h = new Headers({ 'CF-Connecting-IP': `10.4.${(ip >> 8) & 255}.${ip & 255}` });
  if (cookie) h.set('Cookie', cookie);
  const hasBody = method !== 'GET' && method !== 'DELETE';
  if (hasBody) h.set('Content-Type', 'application/json');
  const response = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: hasBody ? JSON.stringify(body ?? {}) : undefined, redirect: 'manual' }), e, ctx);
  const text = await response.text(); let json = null; try { json = JSON.parse(text); } catch (_) { json = null; }
  return { status: response.status, text, json };
}
async function signup(e, email, orgName) {
  const r = await call(e, 'POST', '/api/customer/signup', { email, password: PW, organizationName: orgName });
  assert.equal(r.status, 200, r.text);
  const userId = (await e.LUMMET_DB.prepare('SELECT id FROM customer_users WHERE email = ?').bind(email).first()).id;
  const s = await customerAuth.createSession(e, userId, r.json.organizationId, { authMethod: 'password' });
  return { userId, organizationId: r.json.organizationId, cookie: s.cookie.split(';')[0] };
}
async function enableTotp(e, who) {
  const s = await call(e, 'POST', '/api/customer/2fa/setup', {}, who.cookie);
  assert.equal(s.status, 200, s.text);
  const c = await call(e, 'POST', '/api/customer/2fa/confirm', { code: await totp.generateTotpCode(s.json.secret) }, who.cookie);
  assert.equal(c.status, 200, c.text);
  return s.json;
}
const sessionFor = async (e, userId, activeOrganizationId, authMethod) => (await customerAuth.createSession(e, userId, activeOrganizationId, { authMethod })).cookie.split(';')[0];

/** Org O requires 2FA (its owner has an authenticator). M is an admin of O and has an organization of their own, N, and no second factor. */
async function world(extra = {}) {
  const e = newEnv(extra);
  const owner = await signup(e, 'owner@example.test', 'Org O');
  await enableTotp(e, owner);
  const on = await call(e, 'PUT', `/api/organizations/${owner.organizationId}/security-policy`, { require2fa: true, reason: 'Org rule from the security review' }, owner.cookie);
  assert.equal(on.status, 200, on.text);
  const m = await signup(e, 'member@example.test', 'Org N');
  await e.LUMMET_DB.prepare('INSERT INTO organization_users (organization_id, user_id, role) VALUES (?, ?, ?)').bind(owner.organizationId, m.userId, 'admin').run();
  await e.LUMMET_DB.prepare(`INSERT INTO sites (id, organization_id, name, slug, product_id) VALUES ('site-o', ?, 'O site', 'o-site', 'prod_casino_news')`).bind(owner.organizationId).run();
  return { e, owner, m, O: owner.organizationId, N: m.organizationId };
}
const status = async (e, cookie, path) => (await call(e, 'GET', path, null, cookie)).status;

// ------------------------------------------------------------------ the setup API and page

test('H.4 the 2FA setup API returns a QR for the otpauth link, and it is that link', async () => {
  const e = newEnv();
  const u = await signup(e, 'qr@example.test', 'Org Q');
  const r = await call(e, 'POST', '/api/customer/2fa/setup', {}, u.cookie);
  assert.equal(r.status, 200);
  assert.match(r.json.otpauthUrl, /^otpauth:\/\/totp\//);
  assert.deepEqual(Object.keys(r.json.qr).sort(), ['path', 'size']);
  assert.deepEqual(r.json.qr, qrForText(r.json.otpauthUrl));
  assert.equal(readBack(qrModules(r.json.otpauthUrl)), r.json.otpauthUrl);
  assert.ok(!JSON.stringify(r.json.qr).includes(r.json.secret), 'the grid does not carry the secret in the clear');
});

test('H.4 the enrollment page draws the QR with DOM calls only and keeps working without one', async () => {
  const e = newEnv();
  const u = await signup(e, 'page@example.test', 'Org P');
  const page = await call(e, 'GET', '/app/security/2fa', null, u.cookie);
  assert.equal(page.status, 200);
  const script = [...page.text.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('drawQr'));
  assert.ok(script, 'page script has drawQr'); assert.doesNotThrow(() => new Function(script));
  assert.match(script, /createElementNS/); assert.ok(!/innerHTML|document\.write|eval\(/.test(script));
  assert.match(page.text, /id="qr"/);
  assert.ok(!page.text.includes('otpauth://'), 'static page still contains no secret');
});

// ------------------------------------------------------------------ the passkey rule

test('H.4 passkey rule off (default): no sign-in method but a real second factor lifts the restriction, a UV passkey session included', async () => {
  const w = await world();
  for (const method of ['password', 'passkey', 'passkey_uv', 'sso', null]) {
    const cookie = await sessionFor(w.e, w.m.userId, w.O, method);
    assert.equal(await status(w.e, cookie, `/api/organizations/${w.O}/sites`), 403, `${method}`);
  }
});

test('H.4 passkey rule on: only a passkey session that verified the person lifts the restriction; password, plain passkey and unrecorded sessions stay restricted', async () => {
  const w = await world({ ORG_2FA_PASSKEY_COUNTS: 'on' });
  const results = {};
  for (const method of ['password', 'password_totp', 'passkey', 'passkey_uv', 'sso', null]) {
    const cookie = await sessionFor(w.e, w.m.userId, w.O, method);
    results[method] = await status(w.e, cookie, `/api/organizations/${w.O}/sites`);
  }
  assert.deepEqual(results, { password: 403, password_totp: 403, passkey: 403, passkey_uv: 200, sso: 403, null: 403 });
  // 'password_totp' is a session of a person who completed TOTP: that person HAS an authenticator, so a real one is open (checked below).
});

test('H.4 a person with an active authenticator is never restricted, whatever the session recorded', async () => {
  const w = await world();
  const owner = await sessionFor(w.e, w.owner.userId, w.O, 'password');
  assert.equal(await status(w.e, owner, `/api/organizations/${w.O}/sites`), 200);
});

test('H.4 passkey login records how the session was authenticated, and with the flag on asks the authenticator to verify the person', async () => {
  for (const [uv, expected] of [[true, 'passkey_uv'], [false, 'passkey']]) {
    const w = await world({ ORG_2FA_PASSKEY_COUNTS: 'on' });
    const opts = await webauthn.generateRegistrationOptions(w.e, w.m.userId);
    assert.equal(opts.options.authenticatorSelection.userVerification, 'required');
    const reg = await buildRegistrationCredential({ challenge: opts.options.challenge });
    assert.equal((await webauthn.verifyRegistration(w.e, w.m.userId, reg.credential)).ok, true);
    const auth = await webauthn.generateAuthenticationOptions(w.e, w.m.userId);
    assert.equal(auth.options.userVerification, 'required');
    const assertion = await buildAuthenticationAssertion({ keyPair: reg.keyPair, credentialId: reg.credentialId, challenge: auth.options.challenge, counter: 1, userVerified: uv });
    const login = await webauthn.completePasswordlessLogin(w.e, assertion);
    assert.equal(login.ok, true, JSON.stringify(login));
    const row = await w.e.LUMMET_DB.prepare('SELECT auth_method FROM customer_sessions WHERE id = ?').bind(login.cookie.split('lummet_customer_session=')[1].split(';')[0]).first();
    assert.equal(row.auth_method, expected);
    // And the effect, end to end through the Worker with the real cookie:
    const cookie = login.cookie.split(';')[0];
    assert.equal(await status(w.e, cookie, `/api/organizations/${w.O}/sites`), uv ? 200 : 403, `uv=${uv}`);
  }
});

test('H.4 flag off keeps the old passkey options (preferred) and a passkey login is still recorded', async () => {
  const w = await world();
  const opts = await webauthn.generateRegistrationOptions(w.e, w.m.userId);
  assert.equal(opts.options.authenticatorSelection.userVerification, 'preferred');
  const reg = await buildRegistrationCredential({ challenge: opts.options.challenge });
  await webauthn.verifyRegistration(w.e, w.m.userId, reg.credential);
  const auth = await webauthn.generateAuthenticationOptions(w.e, w.m.userId);
  assert.equal(auth.options.userVerification, 'preferred');
  const assertion = await buildAuthenticationAssertion({ keyPair: reg.keyPair, credentialId: reg.credentialId, challenge: auth.options.challenge, userVerified: true });
  const login = await webauthn.completePasswordlessLogin(w.e, assertion);
  assert.equal(login.ok, true);
  assert.equal(await status(w.e, login.cookie.split(';')[0], `/api/organizations/${w.O}/sites`), 403, 'flag off: the passkey does not count');
});

test('H.4 a password sign-in records its method (TOTP and SSO are recorded the same way)', async () => {
  const e = newEnv();
  const u = await signup(e, 'method@example.test', 'Org M');
  const login = await call(e, 'POST', '/api/customer/login', { email: 'method@example.test', password: PW });
  assert.equal(login.status, 200, login.text);
  const rows = (await e.LUMMET_DB.prepare('SELECT auth_method FROM customer_sessions WHERE user_id = ?').bind(u.userId).all()).results.map((r) => r.auth_method);
  assert.ok(rows.length >= 2 && rows.every((m) => m === 'password'), JSON.stringify(rows));   // sign-up, the helper's session and this login
});

test('H.4 migration 0077 is one nullable column and nothing else', () => {
  const sql = readFileSync(new URL('../migrations/0077_session_auth_method.sql', import.meta.url), 'utf8').split('\n').filter((l) => !l.startsWith('--')).join('\n').trim();
  assert.equal(sql, 'ALTER TABLE customer_sessions ADD COLUMN auth_method TEXT;');
});

test('H.4 with passkeys counting, a member with a registered passkey is not counted as lacking a second factor, and a passkey-only owner can turn the rule on', async () => {
  for (const flag of ['off', 'on']) {
    const e = newEnv({ ORG_2FA_PASSKEY_COUNTS: flag });
    const owner = await signup(e, `po-${flag}@example.test`, 'Org PO');
    const opts = await webauthn.generateRegistrationOptions(e, owner.userId);
    const reg = await buildRegistrationCredential({ challenge: opts.options.challenge });
    assert.equal((await webauthn.verifyRegistration(e, owner.userId, reg.credential)).ok, true);
    const turnOn = await call(e, 'PUT', `/api/organizations/${owner.organizationId}/security-policy`, { require2fa: true, reason: 'Passkey-only owner enabling the rule' }, owner.cookie);
    assert.equal(turnOn.status, flag === 'on' ? 200 : 409, `${flag}: ${turnOn.text}`);
    if (flag === 'off') assert.equal(turnOn.json.error, 'actor_needs_2fa');
    const counted = await repo.countMembersWithout2fa(e, owner.organizationId, { passkeysCount: flag === 'on' });
    assert.equal(counted, flag === 'on' ? 0 : 1, `${flag}: members without a second factor`);
    if (flag === 'on') assert.equal(turnOn.json.membersWithout2fa, 0, 'and the change response reports it');
  }
});

// ------------------------------------------------------------------ the multi-organization rule

test('H.4 scope any_org (default): one organization requiring 2FA restricts the whole session, including the person\'s own organization and the list', async () => {
  const w = await world();
  assert.equal(orgPolicyScope(w.e), 'any_org');
  const cookie = await sessionFor(w.e, w.m.userId, w.N, 'password');
  for (const path of [`/api/organizations/${w.O}/sites`, `/api/organizations/${w.N}/sites`, '/api/organizations', '/api/sites/site-o']) assert.equal(await status(w.e, cookie, path), 403, path);
});

test('H.4 scope active_org: only the organization that requires 2FA is restricted; the person\'s other organizations, the list and switching stay available', async () => {
  const w = await world({ ORG_2FA_SCOPE: 'active_org' });
  const cookie = await sessionFor(w.e, w.m.userId, w.N, 'password');
  assert.equal(await status(w.e, cookie, `/api/organizations/${w.N}/sites`), 200, 'own organization works');
  assert.equal(await status(w.e, cookie, '/api/organizations'), 200, 'the list works');
  // The restricted organization is refused by the path it names, even though the session's active organization is not restricted.
  for (const path of [`/api/organizations/${w.O}/sites`, `/api/organizations/${w.O}/members`, `/api/organizations/${w.O}/audit-log`, '/api/sites/site-o']) assert.equal(await status(w.e, cookie, path), 403, path);
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await call(w.e, method, `/api/organizations/${w.O}/webhooks`, {}, cookie)).status, 403, method);
});

test('H.4 scope active_org: a session restricted in the 2FA organization can switch to its other organization, and not the other way', async () => {
  const w = await world({ ORG_2FA_SCOPE: 'active_org' });
  let cookie = await sessionFor(w.e, w.m.userId, w.O, 'password');                     // lands in the restricted organization
  assert.equal(await status(w.e, cookie, `/api/organizations/${w.O}/sites`), 403);
  assert.equal(await status(w.e, cookie, `/api/organizations/${w.N}/sites`), 200, 'the other organization is usable straight away');
  const page = await call(w.e, 'GET', '/app/overview', null, cookie);
  assert.equal(page.status, 403, 'the page for the restricted active organization shows the 2FA notice');
  const away = await call(w.e, 'POST', `/api/organizations/${w.N}/switch`, {}, cookie);
  assert.equal(away.status, 200, away.text);
  assert.equal((await call(w.e, 'GET', '/app/overview', null, cookie)).status, 200, 'after switching the page works');
  const back = await call(w.e, 'POST', `/api/organizations/${w.O}/switch`, {}, cookie);
  assert.equal(back.status, 403, 'cannot switch into the restricted organization');
});

test('H.4 scope active_org does not weaken the rule for someone with a second factor, and does not restrict anyone in shadow mode', async () => {
  const w = await world({ ORG_2FA_SCOPE: 'active_org' });
  assert.equal(await status(w.e, await sessionFor(w.e, w.owner.userId, w.O, 'password'), `/api/organizations/${w.O}/sites`), 200);
  const shadow = newEnv({ ORG_2FA_SCOPE: 'active_org', ORG_SECURITY_POLICY: 'shadow' });
  const o = await signup(shadow, 'so@example.test', 'Org SO');
  assert.equal(await status(shadow, o.cookie, `/api/organizations/${o.organizationId}/sites`), 200);
});

test('H.4 evaluateSessionUse and orgRouteDenied: the policy object says exactly what each route needs', async () => {
  const w = await world({ ORG_2FA_SCOPE: 'active_org' });
  const p = await evaluateSessionUse(w.e, w.m.userId, { authMethod: 'password', activeOrganizationId: w.N });
  assert.equal(p.blocked, false); assert.equal(p.wouldBlock, false); assert.deepEqual(p.blockedOrganizationIds, [w.O]); assert.equal(p.scope, 'active_org');
  assert.equal(orgRouteDenied(p, w.O), true); assert.equal(orgRouteDenied(p, w.N), false);
  const inO = await evaluateSessionUse(w.e, w.m.userId, { authMethod: 'password', activeOrganizationId: w.O });
  assert.equal(inO.blocked, true);
  const any = await evaluateSessionUse({ ...w.e, ORG_2FA_SCOPE: undefined }, w.m.userId, { authMethod: 'password', activeOrganizationId: w.N });
  assert.equal(any.blocked, true); assert.equal(orgRouteDenied(any, w.N), true, 'any_org: the whole session');
  assert.equal(orgRouteDenied(null, w.O), false);
  assert.equal(passkeyCountsFor2fa({}), false); assert.equal(passkeyCountsFor2fa({ ORG_2FA_PASSKEY_COUNTS: 'ON' }), true);
  assert.equal(orgPolicyScope({ ORG_2FA_SCOPE: 'nonsense' }), 'any_org');
});

// ------------------------------------------------------------------ configuration

test('H.4 the three settings are validated by config-check when set, never required, and declared in wrangler', () => {
  const base = { ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 37 + 11 + (i * i) % 251) % 256))), CREDENTIAL_KEK_STRICT: 'off', CREDENTIAL_ENCRYPTION_FORMAT: 'v1' };
  const mine = (extra) => configIssues({ ...base, ...extra }).filter((i) => ['API_ENTITLEMENT', 'ORG_2FA_PASSKEY_COUNTS', 'ORG_2FA_SCOPE'].includes(i.key)).map((i) => i.key);
  assert.deepEqual(mine({}), [], 'unset is fine');
  assert.deepEqual(mine({ API_ENTITLEMENT: 'enforce', ORG_2FA_PASSKEY_COUNTS: 'on', ORG_2FA_SCOPE: 'active_org' }), []);
  assert.deepEqual(mine({ API_ENTITLEMENT: 'yes', ORG_2FA_PASSKEY_COUNTS: 'true', ORG_2FA_SCOPE: 'one' }), ['API_ENTITLEMENT', 'ORG_2FA_PASSKEY_COUNTS', 'ORG_2FA_SCOPE']);
  for (const f of ['wrangler.jsonc', 'wrangler.example.jsonc']) {
    const text = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(text, /"API_ENTITLEMENT"\s*:\s*"off"/, f); assert.match(text, /"ORG_2FA_PASSKEY_COUNTS"\s*:\s*"off"/, f); assert.match(text, /"ORG_2FA_SCOPE"\s*:\s*"any_org"/, f);
  }
});

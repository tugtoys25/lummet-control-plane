// Round 6.4C (release 2.6.0.11): organization IP allowlist, lockout protection, SSO requirement stub.
// Acceptance tests (written first): allowlist denies and allows correctly; a bad allowlist cannot lock the organization out;
// non-business plans cannot set an allowlist; cross-organization access is impossible. All through the real Worker entry point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import * as plans from '../worker/plans.js';
import { createTestDb, applyMigrations } from './support/d1-shim.js';

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
const PW = 'Correct-Horse-Battery-9';
const OFFICE = '203.0.113.5';        // inside the office range used below
const ELSEWHERE = '192.0.2.44';       // outside it
const KEY = 'security.ip_allowlist.enabled';

function env(mode = 'enforce', extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)), ORG_IP_ALLOWLIST: mode, PORTAL_BASE_URL: 'https://app.example.test',
    EMAIL_FETCH: async () => new Response(JSON.stringify({ id: 'fake-email' }), { status: 200 }), ...extra };
}
async function call(e, method, path, body, cookie, ip = OFFICE, extraHeaders = {}) {
  const h = new Headers(extraHeaders);
  if (ip !== null) h.set('CF-Connecting-IP', ip);
  if (cookie) h.set('Cookie', cookie);
  if (body != null) h.set('Content-Type', 'application/json');
  const response = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body == null ? undefined : JSON.stringify(body), redirect: 'manual' }), e, ctx);
  const text = await response.text(); let json = null; try { json = JSON.parse(text); } catch (err) { json = null; }
  return { status: response.status, json, text, cookie: (response.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function signup(e, email) {
  const r = await call(e, 'POST', '/api/customer/signup', { email, password: PW, organizationName: 'Org ' + email });
  assert.equal(r.status, 200, r.text);
  return { cookie: r.cookie, organizationId: r.json.organizationId, userId: (await e.LUMMET_DB.prepare('SELECT id FROM customer_users WHERE email = ?').bind(email).first()).id };
}
async function addMember(e, organizationId, userId, role) {
  await e.LUMMET_DB.prepare('INSERT INTO organization_users (organization_id, user_id, role) VALUES (?, ?, ?)').bind(organizationId, userId, role).run();
}
/** A plan that carries the entitlement, built in the test (the code never names a plan). The owner decides which real plans get it. */
async function entitledPlan(e) {
  await e.LUMMET_DB.prepare(`INSERT OR REPLACE INTO plan_entitlements (plan_id, key, value_type, value) VALUES ('plan_agency_30', ?, 'boolean', 'true')`).bind(KEY).run();
}
async function subscribe(e, organizationId, planId) {
  const r = await plans.startTrialSubscription(e, organizationId, planId); assert.equal(r.ok, true, JSON.stringify(r));
}
/** Owner of an organization on a plan that includes the allowlist, plus an admin and an editor. */
async function setup(e, { entitled = true } = {}) {
  await entitledPlan(e);
  const owner = await signup(e, 'owner@example.test');
  await subscribe(e, owner.organizationId, entitled ? 'plan_agency_30' : 'plan_casino_news_starter');
  const admin = await signup(e, 'admin@example.test'); await addMember(e, owner.organizationId, admin.userId, 'admin');
  const editor = await signup(e, 'editor@example.test'); await addMember(e, owner.organizationId, editor.userId, 'editor');
  return { owner, admin, editor, base: `/api/organizations/${owner.organizationId}` };
}
const RANGE = ['203.0.113.0/24', '2001:db8:abcd::/48'];
async function setList(e, t, list = RANGE, ip = OFFICE) {
  return call(e, 'PUT', `${t.base}/ip-allowlist`, { ipAllowlist: list, reason: 'Office network only, per security review' }, t.owner.cookie, ip);
}
const audit = async (e, action) => (await e.LUMMET_DB.prepare(`SELECT * FROM lummet_audit_logs WHERE action = ? ORDER BY id`).bind(action).all()).results;

// ---------------------------------------------------------------- 1. denies and allows correctly
test('ALLOWLIST: a request from inside the list is served; from outside is 403 ip_not_allowed; this holds for every role', async () => {
  const e = env(); const t = await setup(e);
  const set = await setList(e, t); assert.equal(set.status, 200, set.text); assert.equal(set.json.changed, true);
  for (const who of [t.owner, t.admin, t.editor]) {
    assert.equal((await call(e, 'GET', `${t.base}/members`, null, who.cookie, OFFICE)).status, 200);
    const out = await call(e, 'GET', `${t.base}/members`, null, who.cookie, ELSEWHERE);
    assert.equal(out.status, 403); assert.equal(out.json.error, 'ip_not_allowed');
  }
});

test('ALLOWLIST: IPv6 inside and outside the range; an IPv4-mapped IPv6 client is judged as its IPv4 address', async () => {
  const e = env(); const t = await setup(e); assert.equal((await setList(e, t)).status, 200);
  assert.equal((await call(e, 'GET', `${t.base}/members`, null, t.owner.cookie, '2001:db8:abcd:12::9')).status, 200);
  assert.equal((await call(e, 'GET', `${t.base}/members`, null, t.owner.cookie, '2001:db8:abce::9')).status, 403);
  assert.equal((await call(e, 'GET', `${t.base}/members`, null, t.owner.cookie, '::ffff:203.0.113.77')).status, 200);
  assert.equal((await call(e, 'GET', `${t.base}/members`, null, t.owner.cookie, '::ffff:192.0.2.44')).status, 403);
});

test('ALLOWLIST proxy headers: a client-supplied X-Forwarded-For, X-Real-IP, Forwarded or True-Client-IP never grants access', async () => {
  const e = env(); const t = await setup(e); assert.equal((await setList(e, t)).status, 200);
  const spoof = { 'X-Forwarded-For': OFFICE, 'X-Real-IP': OFFICE, Forwarded: `for=${OFFICE}`, 'True-Client-IP': OFFICE };
  assert.equal((await call(e, 'GET', `${t.base}/members`, null, t.owner.cookie, ELSEWHERE, spoof)).status, 403);
  // and the reverse: a spoofed header cannot take a legitimate office user out of the list
  assert.equal((await call(e, 'GET', `${t.base}/members`, null, t.owner.cookie, OFFICE, { 'X-Forwarded-For': ELSEWHERE })).status, 200);
});

test('ALLOWLIST fails closed: no CF-Connecting-IP, an unreadable one, or a list of two addresses is denied', async () => {
  const e = env(); const t = await setup(e); assert.equal((await setList(e, t)).status, 200);
  for (const ip of [null, 'not-an-ip', `${OFFICE}, ${ELSEWHERE}`, '']) {
    const r = await call(e, 'GET', `${t.base}/members`, null, t.owner.cookie, ip);
    assert.equal(r.status, 403, `ip=${JSON.stringify(ip)} -> ${r.status}`); assert.equal(r.json.error, 'ip_not_allowed');
  }
});

test('ALLOWLIST also covers the organization sites route and the portal pages, and an allowed request still works', async () => {
  const e = env(); const t = await setup(e);
  await e.LUMMET_DB.prepare(`INSERT INTO sites (id, organization_id, tenant_id, name, slug, product_id, status) VALUES ('site-a', ?, NULL, 'S', 'site-a', 'prod_casino_news', 'active')`).bind(t.owner.organizationId).run().catch(async () => {
    const p = await e.LUMMET_DB.prepare(`SELECT id FROM products LIMIT 1`).first();
    await e.LUMMET_DB.prepare(`INSERT INTO sites (id, organization_id, name, slug, product_id, status) VALUES ('site-a', ?, 'S', 'site-a', ?, 'active')`).bind(t.owner.organizationId, p.id).run();
  });
  assert.equal((await setList(e, t)).status, 200);
  assert.equal((await call(e, 'GET', '/api/sites/site-a', null, t.owner.cookie, OFFICE)).status, 200);
  const siteOut = await call(e, 'GET', '/api/sites/site-a', null, t.owner.cookie, ELSEWHERE);
  assert.equal(siteOut.status, 403); assert.equal(siteOut.json.error, 'ip_not_allowed');
  assert.equal((await call(e, 'GET', '/app/overview', null, t.owner.cookie, OFFICE)).status, 200);
  const page = await call(e, 'GET', '/app/overview', null, t.owner.cookie, ELSEWHERE);
  assert.equal(page.status, 403); assert.match(page.text, /network/i); assert.doesNotMatch(page.text, /Org owner@example\.test/, 'the denied page shows no organization data');
});

test('ALLOWLIST: sign-in and the account-level routes are not blocked by an organization list (a member can still reach other organizations)', async () => {
  const e = env(); const t = await setup(e); assert.equal((await setList(e, t)).status, 200);
  const login = await call(e, 'POST', '/api/customer/login', { email: 'editor@example.test', password: PW }, null, ELSEWHERE);
  assert.equal(login.status, 200, login.text);
  assert.equal((await call(e, 'GET', '/api/organizations', null, login.cookie, ELSEWHERE)).status, 200);
});

test('FLAG shadow: the list can be set and read; nothing is denied. FLAG off: the API is dark and a stored list is ignored', async () => {
  const shadow = env('shadow'); const ts = await setup(shadow);
  assert.equal((await setList(shadow, ts)).status, 200);
  assert.equal((await call(shadow, 'GET', `${ts.base}/members`, null, ts.owner.cookie, ELSEWHERE)).status, 200, 'shadow never denies');
  const read = await call(shadow, 'GET', `${ts.base}/ip-allowlist`, null, ts.owner.cookie, ELSEWHERE);
  assert.equal(read.status, 200); assert.equal(read.json.enforcement, 'shadow'); assert.deepEqual(read.json.data.ipAllowlist, ['203.0.113.0/24', '2001:db8:abcd::/48']);

  const off = env('off'); const to = await setup(off);
  assert.equal((await setList(off, to)).status, 404);
  assert.equal((await call(off, 'GET', `${to.base}/ip-allowlist`, null, to.owner.cookie)).status, 404);
  await off.LUMMET_DB.prepare(`INSERT INTO organization_security_policies (organization_id, ip_allowlist_json) VALUES (?, '["203.0.113.0/24"]')`).bind(to.owner.organizationId).run();
  assert.equal((await call(off, 'GET', `${to.base}/members`, null, to.owner.cookie, ELSEWHERE)).status, 200, 'off ignores a stored list');
  const unset = env(undefined); delete unset.ORG_IP_ALLOWLIST;
  assert.equal((await call(unset, 'GET', '/api/organizations', null, null)).status, 401, 'an unset flag behaves as off and does not break routing');
});

// ---------------------------------------------------------------- 2. a bad allowlist cannot lock the organization out
test('LOCKOUT: an owner cannot save a list that excludes the address they are using, and nothing is stored', async () => {
  const e = env(); const t = await setup(e);
  const r = await setList(e, t, ['198.51.100.0/24'], OFFICE);
  assert.equal(r.status, 409); assert.equal(r.json.error, 'would_lock_out_actor');
  assert.equal((await call(e, 'GET', `${t.base}/ip-allowlist`, null, t.owner.cookie, OFFICE)).json.data.ipAllowlist.length, 0);
  const row = await e.LUMMET_DB.prepare(`SELECT ip_allowlist_json FROM organization_security_policies WHERE organization_id = ?`).bind(t.owner.organizationId).first();
  assert.ok(!row || row.ip_allowlist_json === '[]');
  const refused = await audit(e, 'ip_allowlist_set_refused');
  assert.equal(refused.length, 1); assert.equal(refused[0].success, 0); assert.equal(refused[0].error_message, 'would_lock_out_actor'); assert.equal(refused[0].organization_id, t.owner.organizationId);
});

test('LOCKOUT: if the owner address cannot be read at all, a non-empty list is refused (client_ip_unknown)', async () => {
  const e = env(); const t = await setup(e);
  for (const ip of [null, 'garbage']) {
    const r = await setList(e, t, RANGE, ip); assert.equal(r.status, 409, r.text); assert.equal(r.json.error, 'client_ip_unknown');
  }
});

test('LOCKOUT: bad input is refused before anything is stored (allow-everything, wrong type, too long, a reason that is too short)', async () => {
  const e = env(); const t = await setup(e); const url = `${t.base}/ip-allowlist`;
  const put = (body) => call(e, 'PUT', url, body, t.owner.cookie, OFFICE);
  assert.equal((await put({ ipAllowlist: ['0.0.0.0/0'], reason: 'allow everything please' })).status, 422);
  assert.equal((await put({ ipAllowlist: ['::/0'], reason: 'allow everything please' })).status, 422);
  assert.equal((await put({ ipAllowlist: 'a string', reason: 'a valid reason here' })).status, 422);
  assert.equal((await put({ ipAllowlist: ['1.2.3.4/99'], reason: 'a valid reason here' })).status, 422);
  assert.equal((await put({ ipAllowlist: Array.from({ length: 500 }, (_, i) => `10.${i % 250}.0.1`), reason: 'a valid reason here' })).json.error, 'too_many_entries');
  assert.equal((await put({ ipAllowlist: RANGE })).status, 422, 'no reason');
  assert.equal((await put({ ipAllowlist: RANGE, reason: 'abc' })).status, 422, 'reason too short');
  assert.equal((await call(e, 'GET', `${t.base}/members`, null, t.owner.cookie, ELSEWHERE)).status, 200, 'nothing was stored, so nobody is restricted');
});

test('LOCKOUT: only an owner changes the list; an admin, an editor, an outsider and a signed-out caller cannot, and every refusal is audited', async () => {
  const e = env(); const t = await setup(e);
  assert.equal((await call(e, 'PUT', `${t.base}/ip-allowlist`, { ipAllowlist: RANGE, reason: 'trying as admin' }, t.admin.cookie)).status, 403);
  assert.equal((await call(e, 'PUT', `${t.base}/ip-allowlist`, { ipAllowlist: RANGE, reason: 'trying as editor' }, t.editor.cookie)).status, 403);
  const outsider = await signup(e, 'out@example.test');
  assert.equal((await call(e, 'PUT', `${t.base}/ip-allowlist`, { ipAllowlist: RANGE, reason: 'trying as outsider' }, outsider.cookie)).status, 403);
  assert.equal((await call(e, 'PUT', `${t.base}/ip-allowlist`, { ipAllowlist: RANGE, reason: 'no cookie at all' }, null)).status, 401);
  assert.equal((await call(e, 'GET', `${t.base}/ip-allowlist`, null, outsider.cookie)).status, 403);
  assert.equal((await audit(e, 'ip_allowlist_set_refused')).length, 2, 'admin and editor refusals are audited with their organization (the outsider is stopped before the service)');
  assert.equal((await call(e, 'GET', `${t.base}/members`, null, t.owner.cookie, ELSEWHERE)).status, 200);
});

test('LOCKOUT recovery 1: an owner on an allowed address can widen or clear the list at any time, with a reason, audited', async () => {
  const e = env(); const t = await setup(e); assert.equal((await setList(e, t)).status, 200);
  const widen = await setList(e, t, [...RANGE, '192.0.2.0/24']); assert.equal(widen.status, 200);
  assert.equal((await call(e, 'GET', `${t.base}/members`, null, t.admin.cookie, ELSEWHERE)).status, 200, 'now inside');
  const clear = await call(e, 'PUT', `${t.base}/ip-allowlist`, { ipAllowlist: [], reason: 'Going remote, list removed' }, t.owner.cookie, OFFICE);
  assert.equal(clear.status, 200); assert.equal(clear.json.changed, true); assert.deepEqual(clear.json.data.ipAllowlist, []);
  assert.equal((await call(e, 'GET', `${t.base}/members`, null, t.editor.cookie, '198.51.100.9')).status, 200, 'an empty list means no restriction');
  const sets = await audit(e, 'ip_allowlist_set'); const clears = await audit(e, 'ip_allowlist_clear');
  assert.equal(sets.length, 2); assert.equal(clears.length, 1);
  assert.deepEqual([clears[0].reason, clears[0].resource, clears[0].customer_user_id, clears[0].organization_id, clears[0].actor_type], ['Going remote, list removed', 'organization_security_policy', t.owner.userId, t.owner.organizationId, 'customer_user']);
  assert.ok(clears[0].ip_hash && !String(clears[0].ip_hash).includes(OFFICE), 'the audit row stores a hash, never the address');
});

test('LOCKOUT recovery 2: when an owner is already locked out (their address changed), STAFF can clear the list, with a reason, audited with the staff id', async () => {
  const e = env(); const t = await setup(e); assert.equal((await setList(e, t)).status, 200);
  assert.equal((await call(e, 'GET', `${t.base}/members`, null, t.owner.cookie, ELSEWHERE)).status, 403, 'the owner is locked out from the new address');
  assert.equal((await call(e, 'PUT', `${t.base}/ip-allowlist`, { ipAllowlist: [], reason: 'trying from the new address' }, t.owner.cookie, ELSEWHERE)).status, 403, 'the owner cannot self-clear from outside');

  await call(e, 'POST', '/api/auth/bootstrap', { email: 'root@example.com', password: PW });
  const staff = (await call(e, 'POST', '/api/auth/login', { email: 'root@example.com', password: PW })).cookie;
  const path = `/api/platform/saas/organizations/${t.owner.organizationId}/ip-allowlist/clear`;
  assert.equal((await call(e, 'POST', path, { reason: '' }, staff)).status, 422, 'staff need a reason');
  assert.equal((await call(e, 'POST', path, { reason: 'Owner verified by phone callback, ticket 123' }, t.owner.cookie)).status === 200, false, 'a customer session is not staff');
  assert.equal((await call(e, 'POST', path, { reason: 'Owner verified by phone callback, ticket 123' })).status === 200, false, 'signed out is not staff');
  assert.equal((await call(e, 'POST', '/api/platform/saas/organizations/does-not-exist/ip-allowlist/clear', { reason: 'Owner verified by phone callback' }, staff)).status, 404);

  const done = await call(e, 'POST', path, { reason: 'Owner verified by phone callback, ticket 123' }, staff);
  assert.equal(done.status, 200, done.text); assert.equal(done.json.cleared, true);
  assert.equal((await call(e, 'GET', `${t.base}/members`, null, t.owner.cookie, ELSEWHERE)).status, 200, 'the owner is back in');
  const rows = await audit(e, 'ip_allowlist_staff_clear');
  assert.equal(rows.length, 1); assert.ok(rows[0].admin_id); assert.equal(rows[0].organization_id, t.owner.organizationId); assert.equal(rows[0].reason, 'Owner verified by phone callback, ticket 123'); assert.equal(rows[0].actor_type, 'lummet_admin');
});

test('LOCKOUT recovery 3: the flag is a kill switch: setting ORG_IP_ALLOWLIST to shadow or off lifts every denial at once', async () => {
  const e = env(); const t = await setup(e); assert.equal((await setList(e, t)).status, 200);
  assert.equal((await call(e, 'GET', `${t.base}/members`, null, t.owner.cookie, ELSEWHERE)).status, 403);
  e.ORG_IP_ALLOWLIST = 'shadow'; assert.equal((await call(e, 'GET', `${t.base}/members`, null, t.owner.cookie, ELSEWHERE)).status, 200);
  e.ORG_IP_ALLOWLIST = 'off'; assert.equal((await call(e, 'GET', `${t.base}/members`, null, t.owner.cookie, ELSEWHERE)).status, 200);
});

test('LOCKOUT: when the plan no longer includes the allowlist (downgrade, cancelled, unpaid) the list is not enforced, so billing can always be fixed', async () => {
  const e = env(); const t = await setup(e); assert.equal((await setList(e, t)).status, 200);
  assert.equal((await call(e, 'GET', `${t.base}/members`, null, t.owner.cookie, ELSEWHERE)).status, 403);
  await e.LUMMET_DB.prepare(`UPDATE subscriptions SET status = 'canceled' WHERE organization_id = ?`).bind(t.owner.organizationId).run();
  assert.equal((await call(e, 'GET', `${t.base}/members`, null, t.owner.cookie, ELSEWHERE)).status, 200);
  const read = await call(e, 'GET', `${t.base}/ip-allowlist`, null, t.owner.cookie, ELSEWHERE);
  assert.equal(read.json.data.entitled, false); assert.equal(read.json.data.enforced, false); assert.equal(read.json.data.ipAllowlist.length, 2, 'the stored list is kept for when the plan returns');
});

test('LOCKOUT: setting the list keeps the 2FA requirement and clearing keeps it too (the two controls never overwrite each other)', async () => {
  const e = env('enforce', { ORG_SECURITY_POLICY: 'shadow' }); const t = await setup(e);
  await e.LUMMET_DB.prepare(`INSERT INTO organization_security_policies (organization_id, require_2fa) VALUES (?, 1)`).bind(t.owner.organizationId).run();
  assert.equal((await setList(e, t)).status, 200);
  let row = await e.LUMMET_DB.prepare(`SELECT require_2fa, ip_allowlist_json FROM organization_security_policies WHERE organization_id = ?`).bind(t.owner.organizationId).first();
  assert.deepEqual([row.require_2fa, JSON.parse(row.ip_allowlist_json).length], [1, 2]);
  await call(e, 'PUT', `${t.base}/ip-allowlist`, { ipAllowlist: [], reason: 'clearing it again now' }, t.owner.cookie);
  row = await e.LUMMET_DB.prepare(`SELECT require_2fa, ip_allowlist_json FROM organization_security_policies WHERE organization_id = ?`).bind(t.owner.organizationId).first();
  assert.deepEqual([row.require_2fa, row.ip_allowlist_json], [1, '[]']);
});

// ---------------------------------------------------------------- 3. non-business plans cannot set an allowlist
test('PLAN GATE: an organization whose plan lacks the entitlement cannot set a list (403 feature_not_in_plan, audited), so no list is ever stored', async () => {
  const e = env(); const t = await setup(e, { entitled: false });
  const r = await setList(e, t); assert.equal(r.status, 403); assert.equal(r.json.error, 'feature_not_in_plan');
  assert.equal((await audit(e, 'ip_allowlist_set_refused')).length, 1);
  assert.equal(await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM organization_security_policies`).first().then((x) => x.n), 0);
  const read = await call(e, 'GET', `${t.base}/ip-allowlist`, null, t.owner.cookie); assert.equal(read.json.data.entitled, false);
});

test('PLAN GATE: an organization with no subscription at all (zero-access floor) cannot set a list either', async () => {
  const e = env(); await entitledPlan(e); const owner = await signup(e, 'nosub@example.test');
  const r = await call(e, 'PUT', `/api/organizations/${owner.organizationId}/ip-allowlist`, { ipAllowlist: RANGE, reason: 'no subscription here' }, owner.cookie);
  assert.equal(r.status, 403); assert.equal(r.json.error, 'feature_not_in_plan');
});

test('PLAN GATE: it goes through entitlements only; a staff override on one subscription grants it without any plan change', async () => {
  const e = env(); await entitledPlan(e); const owner = await signup(e, 'ovr@example.test'); await subscribe(e, owner.organizationId, 'plan_casino_news_starter');
  const url = `/api/organizations/${owner.organizationId}/ip-allowlist`; const body = { ipAllowlist: RANGE, reason: 'override test reason' };
  assert.equal((await call(e, 'PUT', url, body, owner.cookie)).status, 403);
  const sub = await e.LUMMET_DB.prepare(`SELECT id FROM subscriptions WHERE organization_id = ?`).bind(owner.organizationId).first();
  await e.LUMMET_DB.prepare(`INSERT INTO subscription_entitlement_overrides (subscription_id, key, value_type, value, reason) VALUES (?, ?, 'boolean', 'true', 'test')`).bind(sub.id, KEY).run();
  assert.equal((await call(e, 'PUT', url, body, owner.cookie)).status, 200);
});

test('PLAN GATE: clearing an existing list never needs the entitlement (a downgraded owner can always remove it)', async () => {
  const e = env(); const t = await setup(e); assert.equal((await setList(e, t)).status, 200);
  await e.LUMMET_DB.prepare(`UPDATE subscriptions SET status = 'canceled' WHERE organization_id = ?`).bind(t.owner.organizationId).run();
  const clear = await call(e, 'PUT', `${t.base}/ip-allowlist`, { ipAllowlist: [], reason: 'plan ended, removing list' }, t.owner.cookie);
  assert.equal(clear.status, 200, clear.text); assert.equal(clear.json.data.ipAllowlist.length, 0);
});

// ---------------------------------------------------------------- 4. cross-organization access is impossible
test('CROSS-ORG: one organization\'s list never restricts the same person in another organization, and nobody can read or set another organization\'s list', async () => {
  const e = env(); const a = await setup(e);
  const bOwner = await signup(e, 'b-owner@example.test'); await subscribe(e, bOwner.organizationId, 'plan_agency_30');
  const bBase = `/api/organizations/${bOwner.organizationId}`;
  await addMember(e, bOwner.organizationId, a.editor.userId, 'editor');            // the editor belongs to BOTH organizations
  assert.equal((await setList(e, a)).status, 200);

  assert.equal((await call(e, 'GET', `${a.base}/members`, null, a.editor.cookie, ELSEWHERE)).status, 403, 'A restricts the editor');
  assert.equal((await call(e, 'GET', `${bBase}/members`, null, a.editor.cookie, ELSEWHERE)).status, 200, 'B does not');
  assert.equal((await call(e, 'GET', `${bBase}/members`, null, bOwner.cookie, ELSEWHERE)).status, 200, 'B owner unaffected');

  // A's owner is not a member of B: cannot read or write B's list; B's owner cannot touch A's
  assert.equal((await call(e, 'GET', `${bBase}/ip-allowlist`, null, a.owner.cookie, OFFICE)).status, 403);
  assert.equal((await call(e, 'PUT', `${bBase}/ip-allowlist`, { ipAllowlist: ['203.0.113.0/24'], reason: 'cross organization attempt' }, a.owner.cookie, OFFICE)).status, 403);
  assert.equal((await call(e, 'PUT', `${a.base}/ip-allowlist`, { ipAllowlist: [], reason: 'cross organization attempt' }, bOwner.cookie, ELSEWHERE)).status, 403);
  const aRow = await e.LUMMET_DB.prepare(`SELECT ip_allowlist_json FROM organization_security_policies WHERE organization_id = ?`).bind(a.owner.organizationId).first();
  assert.equal(JSON.parse(aRow.ip_allowlist_json).length, 2, 'A\'s list is untouched');
  assert.equal(await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM organization_security_policies WHERE organization_id = ?`).bind(bOwner.organizationId).first().then((x) => x.n), 0, 'B has no policy row');
});

test('CROSS-ORG: a member of B only (no membership in A) is refused as forbidden by A\'s routes whatever the address; a staff-style id in the path cannot be used by a customer', async () => {
  const e = env(); const a = await setup(e); assert.equal((await setList(e, a)).status, 200);
  const outsider = await signup(e, 'zzz@example.test');
  for (const ip of [OFFICE, ELSEWHERE]) {
    const r = await call(e, 'GET', `${a.base}/ip-allowlist`, null, outsider.cookie, ip); assert.equal(r.status, 403); assert.equal(r.json.error, 'forbidden');
  }
  const staffPath = `/api/platform/saas/organizations/${a.owner.organizationId}/ip-allowlist/clear`;
  assert.notEqual((await call(e, 'POST', staffPath, { reason: 'customer using the staff route' }, a.owner.cookie, OFFICE)).status, 200);
  assert.equal(JSON.parse((await e.LUMMET_DB.prepare(`SELECT ip_allowlist_json j FROM organization_security_policies WHERE organization_id = ?`).bind(a.owner.organizationId).first()).j).length, 2);
});

// ---------------------------------------------------------------- 5. SSO requirement stub
test('SSO STUB: off by default (404); in shadow an owner can record the requirement, with a reason, audited; it is never enforced', async () => {
  const off = env('off'); const to = await setup(off);
  assert.equal((await call(off, 'PUT', `${to.base}/sso-requirement`, { requireSso: true, reason: 'sso test reason' }, to.owner.cookie)).status, 404);

  const e = env('off', { ORG_SSO_REQUIREMENT: 'shadow' }); const t = await setup(e);
  const set = await call(e, 'PUT', `${t.base}/sso-requirement`, { requireSso: true, reason: 'Policy draft for the IdP rollout' }, t.owner.cookie);
  assert.equal(set.status, 200, set.text); assert.equal(set.json.changed, true); assert.equal(set.json.data.requireSso, true);
  assert.equal(set.json.enforced, false); assert.equal(set.json.status, 'stub_no_idp');
  const rows = await audit(e, 'require_sso_enable'); assert.equal(rows.length, 1); assert.equal(rows[0].reason, 'Policy draft for the IdP rollout');
  // nobody is blocked: password sign-in and org routes work from any address
  const login = await call(e, 'POST', '/api/customer/login', { email: 'editor@example.test', password: PW }, null, ELSEWHERE);
  assert.equal(login.status, 200); assert.equal((await call(e, 'GET', `${t.base}/members`, null, login.cookie, ELSEWHERE)).status, 200);
  assert.equal((await call(e, 'PUT', `${t.base}/sso-requirement`, { requireSso: false, reason: 'removing the stub' }, t.owner.cookie)).json.data.requireSso, false);
});

test('SSO STUB: owner only, reason required, boolean required; an org-level change never touches the allowlist or 2FA columns', async () => {
  const e = env('enforce', { ORG_SSO_REQUIREMENT: 'shadow' }); const t = await setup(e); assert.equal((await setList(e, t)).status, 200);
  const url = `${t.base}/sso-requirement`;
  assert.equal((await call(e, 'PUT', url, { requireSso: true, reason: 'as admin, not allowed' }, t.admin.cookie)).status, 403);
  assert.equal((await call(e, 'PUT', url, { requireSso: true }, t.owner.cookie)).status, 422);
  assert.equal((await call(e, 'PUT', url, { requireSso: 'yes', reason: 'a string is not a boolean' }, t.owner.cookie)).status, 422);
  assert.equal((await call(e, 'PUT', url, { requireSso: true, reason: 'valid owner reason' }, t.owner.cookie)).status, 200);
  const row = await e.LUMMET_DB.prepare(`SELECT require_sso, require_2fa, ip_allowlist_json FROM organization_security_policies WHERE organization_id = ?`).bind(t.owner.organizationId).first();
  assert.deepEqual([row.require_sso, row.require_2fa, JSON.parse(row.ip_allowlist_json).length], [1, 0, 2]);
});

test('CONFIG: production config-check accepts the documented values, refuses invalid ones, and the three names default to off in both wrangler files', async () => {
  const { configIssues } = await import('../worker/config-check.js');
  const keys = (extra) => configIssues({ ENVIRONMENT: 'production', ...extra }).map((i) => i.key).filter((k) => /IP_ALLOWLIST|SSO_REQUIREMENT/.test(k));
  assert.deepEqual(keys({}), []);
  assert.deepEqual(keys({ ORG_IP_ALLOWLIST: 'enforce', ORG_SSO_REQUIREMENT: 'shadow', IP_ALLOWLIST_MAX_ENTRIES: '50' }), []);
  assert.deepEqual(keys({ ORG_IP_ALLOWLIST: 'on' }), ['ORG_IP_ALLOWLIST']);
  assert.deepEqual(keys({ ORG_SSO_REQUIREMENT: 'enforce' }), ['ORG_SSO_REQUIREMENT']); // there is no enforce for the stub
  assert.deepEqual(keys({ IP_ALLOWLIST_MAX_ENTRIES: '0' }), ['IP_ALLOWLIST_MAX_ENTRIES']);
  assert.deepEqual(keys({ IP_ALLOWLIST_MAX_ENTRIES: 'abc' }), ['IP_ALLOWLIST_MAX_ENTRIES']);
  const { readFileSync } = await import('node:fs');
  for (const f of ['../wrangler.jsonc', '../wrangler.example.jsonc']) {
    const text = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(text, /"ORG_IP_ALLOWLIST":\s*"off"/, f);
    assert.match(text, /"ORG_SSO_REQUIREMENT":\s*"off"/, f);
  }
});

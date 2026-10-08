// Roadmap 1.3: account and data deletion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import * as erasure from '../worker/erasure.js';
import * as policy from '../worker/retention-policy.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';

function env(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  const store = new Map();
  const BACKUPS = { store, async put(k, v) { store.set(k, v); }, async get(k) { return store.has(k) ? { async text() { return store.get(k); } } : null; }, async delete(k) { store.delete(k); } };
  return { LUMMET_DB: db, BACKUPS, CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production', ...extra };
}
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
let ipn = 1;
async function call(e, method, path, { body, cookie } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.' + (ipn++ % 250 + 1) }); if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0], headers: res.headers };
}
const PW = 'Correct-Horse-Battery-9';
const signup = async (e, email) => {
  const r = await call(e, 'POST', '/api/customer/signup', { body: { email, password: PW, organizationName: 'Org of ' + email } });
  const u = await e.LUMMET_DB.prepare(`SELECT id FROM customer_users WHERE email = ?`).bind(email).first();
  return { id: u.id, org: r.json.organizationId, cookie: r.cookie };
};
const count = async (e, sql, ...p) => (await e.LUMMET_DB.prepare(sql).bind(...p).first()).n;
const past = () => new Date(Date.now() - 86400000).toISOString();
const future = () => new Date(Date.now() + 5 * 86400000).toISOString();

test('every table that references an organization, site, user or email is covered by the retention policy', async () => {
  const e = env(); const db = e.LUMMET_DB;
  const tables = (await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all()).results.map((t) => t.name);
  const named = new Set([...policy.ORG_DELETE.map((x) => x[0]), ...policy.SITE_DELETE.map((x) => x[0]), ...policy.USER_DELETE.map((x) => x[0]),
    ...policy.FINANCIAL_RETAINED, ...policy.TOMBSTONED, policy.AUDIT_TABLE, ...Object.keys(policy.OUT_OF_SCOPE)]);
  for (const n of named) assert.ok(tables.includes(n), `policy names a table that does not exist: ${n}`);
  const personal = /^(organization_id|site_id|user_id|customer_user_id|tenant_id|email|to_email|invited_by|created_by|requested_by|actor_user_id|deletion_requested_by)$/;
  const uncovered = [];
  for (const t of tables) {
    const cols = (await db.prepare(`PRAGMA table_info("${t}")`).all()).results.map((c) => c.name);
    if (cols.some((c) => personal.test(c)) && !named.has(t)) uncovered.push(t);
  }
  assert.deepEqual(uncovered, [], 'add these to worker/retention-policy.js (or OUT_OF_SCOPE with a reason)');
});

test('erasing a person removes their access and personal data, keeps the row as an anonymous tombstone, and frees the email', async () => {
  const e = env();
  const alice = await signup(e, 'alice@example.com'); const bob = await signup(e, 'bob@example.com');
  await e.LUMMET_DB.prepare(`INSERT INTO organization_users (organization_id, user_id, role) VALUES (?, ?, 'viewer')`).bind(bob.org, alice.id).run();
  await e.LUMMET_DB.prepare(`INSERT INTO organization_invitations (id, organization_id, email, role, token_hash, invited_by, expires_at) VALUES ('i1', ?, 'new@example.com', 'viewer', 'h', ?, '2099-01-01')`).bind(bob.org, alice.id).run();
  await e.LUMMET_DB.prepare(`INSERT INTO customer_totp (user_id, encrypted_secret, secret_iv, status) VALUES (?, 'x', 'y', 'active')`).bind(alice.id).run();
  await call(e, 'GET', '/app/overview', { cookie: alice.cookie });
  assert.ok(await count(e, `SELECT COUNT(*) n FROM lummet_audit_logs WHERE customer_user_id = ?`, alice.id) > 0);

  const r = await erasure.eraseUser(e, alice.id);
  assert.equal(r.ok, true);
  const u = await e.LUMMET_DB.prepare(`SELECT * FROM customer_users WHERE id = ?`).bind(alice.id).first();
  assert.equal(u.status, 'deleted'); assert.equal(u.email, `deleted-${alice.id}@deleted.invalid`); assert.equal(u.full_name, null); assert.ok(u.deleted_at);
  assert.equal(await count(e, `SELECT COUNT(*) n FROM customer_sessions WHERE user_id = ?`, alice.id), 0);
  assert.equal(await count(e, `SELECT COUNT(*) n FROM customer_totp WHERE user_id = ?`, alice.id), 0);
  assert.equal(await count(e, `SELECT COUNT(*) n FROM organization_users WHERE user_id = ?`, alice.id), 0);
  assert.equal(await count(e, `SELECT COUNT(*) n FROM organization_invitations WHERE invited_by = ?`, alice.id), 0);
  assert.equal(await count(e, `SELECT COUNT(*) n FROM lummet_audit_logs WHERE customer_user_id = ? AND ip_hash IS NOT NULL`, alice.id), 0, 'IP hashes are scrubbed from their audit rows');
  assert.equal((await call(e, 'GET', '/app/overview', { cookie: alice.cookie })).status, 302, 'the old session is dead');
  assert.equal((await call(e, 'POST', '/api/customer/login', { body: { email: 'alice@example.com', password: PW } })).status, 401, 'cannot sign in');
  assert.equal(await count(e, `SELECT COUNT(*) n FROM organization_users WHERE user_id = ?`, bob.id), 1, 'other people are untouched');

  assert.equal((await call(e, 'POST', '/api/customer/signup', { body: { email: 'alice@example.com', password: PW, organizationName: 'Again' } })).status, 200, 'the address can be used again');
  assert.equal((await erasure.eraseUser(e, alice.id)).alreadyErased, true, 'idempotent');
  assert.equal((await erasure.eraseUser(e, 'nope')).status, 404);
});

test('self-service deletion needs the right email and password, and refuses while the person is the only owner of an organization', async () => {
  const e = env(); const a = await signup(e, 'owner@example.com');
  const del = (body) => call(e, 'POST', '/api/customer/account/delete', { cookie: a.cookie, body });
  assert.equal((await call(e, 'POST', '/api/customer/account/delete', { body: {} })).status, 401);
  assert.equal((await del({ confirmEmail: 'someone@else.com', password: PW })).json.error, 'confirmation_email_mismatch');
  assert.equal((await del({ confirmEmail: 'owner@example.com', password: 'wrong-password-123' })).json.error, 'incorrect_password');
  assert.equal((await del({ confirmEmail: 'owner@example.com' })).json.error, 'incorrect_password', 'a missing password is not accepted');
  const blocked = await del({ confirmEmail: 'OWNER@example.com', password: PW });
  assert.equal(blocked.status, 409); assert.equal(blocked.json.error, 'sole_owner_of_organizations'); assert.equal(blocked.json.organizations[0].id, a.org);
  assert.equal(await count(e, `SELECT COUNT(*) n FROM customer_users WHERE status = 'deleted'`), 0);

  // a second owner lifts the block
  const b = await signup(e, 'second@example.com');
  await e.LUMMET_DB.prepare(`INSERT INTO organization_users (organization_id, user_id, role) VALUES (?, ?, 'owner')`).bind(a.org, b.id).run();
  const ok = await del({ confirmEmail: 'owner@example.com', password: PW });
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.headers.get('Set-Cookie') || '', /Max-Age=0/, 'the session cookie is cleared');
  assert.equal(await count(e, `SELECT COUNT(*) n FROM lummet_audit_logs WHERE action = 'erase' AND success = 1`), 1);
});

test('an organization scheduled for deletion does not block its sole owner', async () => {
  const e = env(); const a = await signup(e, 'leaving@example.com');
  await e.LUMMET_DB.prepare(`UPDATE organizations SET scheduled_deletion_at = ? WHERE id = ?`).bind(future(), a.org).run();
  assert.equal((await call(e, 'POST', '/api/customer/account/delete', { cookie: a.cookie, body: { confirmEmail: 'leaving@example.com', password: PW } })).status, 200);
});

test('export contains the person\'s data and never a secret', async () => {
  const e = env(); const a = await signup(e, 'exp@example.com');
  await e.LUMMET_DB.prepare(`INSERT INTO customer_api_keys (id, organization_id, name, key_prefix, key_hash, scopes, created_by) VALUES ('k1', ?, 'My key', 'lk_pre', 'SECRETHASH', '[]', ?)`).bind(a.org, a.id).run();
  const r = await call(e, 'GET', '/api/customer/account/export', { cookie: a.cookie });
  assert.equal(r.status, 200); assert.match(r.headers.get('Content-Disposition'), /attachment/); assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.equal(r.json.profile.email, 'exp@example.com'); assert.equal(r.json.organizations[0].role, 'owner');
  assert.equal(r.json.apiKeysCreated[0].name, 'My key');
  for (const secret of ['SECRETHASH', 'password_hash', 'encrypted_secret']) assert.equal(r.text.includes(secret), false, secret);
  assert.equal((await call(e, 'GET', '/api/customer/account/export')).status, 401);
});

async function richOrg(e) {
  const owner = await signup(e, 'rich@example.com'); const org = owner.org; const db = e.LUMMET_DB;
  const prod = await db.prepare(`SELECT id FROM products LIMIT 1`).first();
  await db.prepare(`INSERT INTO tenants (id, name, host, api_base_url) VALUES ('t1','T','t1.example.com','https://t1.example.com')`).run();
  await db.prepare(`INSERT INTO sites (id, organization_id, product_id, name, slug, status, tenant_id) VALUES ('s1', ?, ?, 'Secret Site Name', 'secret-site', 'active', 't1')`).bind(org, prod.id).run();
  for (const [type, id, name] of [['worker', 'w', 'tenant-worker-1'], ['d1', 'd1-id', 'db'], ['kv', 'kv-id', 'kv'], ['r2', 'r2-id', 'bucket']]) {
    await db.prepare(`INSERT INTO site_resources (site_id, provider, resource_type, resource_id, resource_name) VALUES ('s1','cloudflare',?,?,?)`).bind(type, id, name).run();
  }
  await db.prepare(`INSERT INTO domains (id, site_id, hostname, status, verification_token, ssl_resource_id) VALUES ('d1','s1','www.secret.example','active','t','ch-1')`).run();
  await db.prepare(`INSERT INTO deployments (id, site_id, version, status) VALUES ('dep1','s1','1.0','active')`).run();
  await db.prepare(`INSERT INTO webhooks (id, organization_id, url, encrypted_secret, secret_iv, event_types) VALUES ('w1', ?, 'https://h.example/x', 'c', 'i', '[]')`).bind(org).run();
  await db.prepare(`INSERT INTO customer_api_keys (id, organization_id, name, key_prefix, key_hash, scopes) VALUES ('k1', ?, 'k', 'p', 'h', '[]')`).bind(org).run();
  await db.prepare(`INSERT INTO site_backups (id, organization_id, site_id, status, storage_key) VALUES ('b1', ?, 's1', 'complete', 'backups/b1.json')`).bind(org).run();
  e.BACKUPS.store.set('backups/b1.json', 'content');
  await db.prepare(`INSERT INTO invoices (id, organization_id, provider, provider_invoice_id, status, amount_due_cents, currency) VALUES ('inv1', ?, 'stripe', 'in_1', 'paid', 500, 'USD')`).bind(org).run();
  await db.prepare(`INSERT INTO organization_invitations (id, organization_id, email, role, token_hash, invited_by, expires_at) VALUES ('i1', ?, 'invitee@example.com', 'viewer', 'h', ?, '2099-01-01')`).bind(org, owner.id).run();
  await db.prepare(`UPDATE organizations SET scheduled_deletion_at = ?, billing_email = 'billing@rich.example' WHERE id = ?`).bind(past(), org).run();
  await db.prepare(`INSERT INTO lummet_audit_logs (actor_type, customer_user_id, organization_id, endpoint, method, resource, action, success, status_code, error_message, ip_hash) VALUES ('customer_user', ?, ?, '/x', 'POST', 'r', 'a', 0, 400, 'email:rich@example.com failed', 'iphash')`).bind(owner.id, org).run();
  return { owner, org };
}

test('erasing an organization deletes external resources first, then its data, keeps financial records, and anonymizes what remains', async () => {
  const e = env(); const { org } = await richOrg(e); const infra = createFakeInfraProvider();
  const r = await erasure.eraseOrganization(e, org, { infra });
  assert.equal(r.ok, true, JSON.stringify(r));

  assert.deepEqual(infra._calls.map((c) => c.method), ['deleteCustomHostname', 'deleteWorkerScript', 'deleteDatabase', 'deleteKVNamespace', 'deleteR2Bucket'], 'external resources go first, the Worker before its data');
  assert.equal(infra._calls.find((c) => c.method === 'deleteWorkerScript').workerName, 'tenant-worker-1');
  assert.equal(e.BACKUPS.store.has('backups/b1.json'), false, 'stored backup file deleted');

  for (const [table, where] of [['webhooks', 'organization_id'], ['customer_api_keys', 'organization_id'], ['site_backups', 'organization_id'], ['organization_invitations', 'organization_id'], ['organization_users', 'organization_id']]) {
    assert.equal(await count(e, `SELECT COUNT(*) n FROM ${table} WHERE ${where} = ?`, org), 0, table);
  }
  assert.equal(await count(e, `SELECT COUNT(*) n FROM deployments WHERE site_id = 's1'`), 0);
  assert.equal(await count(e, `SELECT COUNT(*) n FROM domains WHERE site_id = 's1'`), 0);
  assert.equal(await count(e, `SELECT COUNT(*) n FROM tenants WHERE id = 't1'`), 0, 'the tenant registry entry is gone');

  const o = await e.LUMMET_DB.prepare(`SELECT * FROM organizations WHERE id = ?`).bind(org).first();
  assert.equal(o.name, 'Erased organization'); assert.equal(o.billing_email, null); assert.equal(o.status, 'closed'); assert.ok(o.erased_at); assert.equal(o.scheduled_deletion_at, null);
  const s = await e.LUMMET_DB.prepare(`SELECT * FROM sites WHERE id = 's1'`).bind().first();
  assert.equal(s.name, 'Erased site'); assert.equal(s.status, 'deleted'); assert.equal(s.tenant_id, null);
  assert.equal(await count(e, `SELECT COUNT(*) n FROM invoices WHERE organization_id = ?`, org), 1, 'invoices are retained for the legal period');
  assert.equal(await count(e, `SELECT COUNT(*) n FROM lummet_audit_logs WHERE organization_id = ? AND (ip_hash IS NOT NULL OR error_message LIKE '%@%')`, org), 0, 'audit rows survive without personal content');
  assert.ok(await count(e, `SELECT COUNT(*) n FROM lummet_audit_logs WHERE organization_id = ?`, org) >= 1);

  const log = (await erasure.listErasureLog(e))[0];
  assert.equal(log.status, 'complete'); assert.equal(log.subject_id, org);
  assert.equal(JSON.stringify(log).includes('Secret Site Name'), false, 'the log holds counts, not content');
  assert.equal((await erasure.eraseOrganization(e, org, { infra })).alreadyErased, true, 'idempotent');
});

test('nothing is erased before the grace period ends or for an organization that was never scheduled', async () => {
  const e = env(); const a = await signup(e, 'early@example.com'); const infra = createFakeInfraProvider();
  assert.equal((await erasure.eraseOrganization(e, a.org, { infra })).error, 'grace_period_not_over');
  await e.LUMMET_DB.prepare(`UPDATE organizations SET scheduled_deletion_at = ? WHERE id = ?`).bind(future(), a.org).run();
  assert.equal((await erasure.eraseOrganization(e, a.org, { infra })).error, 'grace_period_not_over');
  assert.equal((await erasure.eraseOrganization(e, 'nope', { infra })).status, 404);
  assert.equal(infra._calls.length, 0);
});

test('if external cleanup fails, NOTHING in the database is touched, the attempt is logged as partial, and a retry finishes the job', async () => {
  const e = env(); const { org } = await richOrg(e); const infra = createFakeInfraProvider();
  infra._failNextCall('deleteWorkerScript', 'Cloudflare 500 upstream');
  const first = await erasure.eraseOrganization(e, org, { infra });
  assert.equal(first.ok, false); assert.equal(first.partial, true); assert.equal(first.failures[0].step, 'worker:w');
  assert.equal(await count(e, `SELECT COUNT(*) n FROM webhooks WHERE organization_id = ?`, org), 1, 'data is still there to retry against');
  assert.equal((await e.LUMMET_DB.prepare(`SELECT erased_at FROM organizations WHERE id = ?`).bind(org).first()).erased_at, null);
  assert.equal((await erasure.listErasureLog(e))[0].status, 'partial');

  const second = await erasure.eraseOrganization(e, org, { infra });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(infra._calls.filter((c) => c.method === 'deleteCustomHostname').length, 1, 'the hostname deleted on the first pass is not deleted twice');
});

test('a resource that is already gone counts as deleted', async () => {
  const e = env(); const { org } = await richOrg(e);
  const infra = createFakeInfraProvider();
  infra.deleteDatabase = async () => { throw new Error('Cloudflare: database not found'); };
  assert.equal((await erasure.eraseOrganization(e, org, { infra })).ok, true);
});

test('the purge picks up only organizations that are due, a few at a time, and one failure does not stop the others', async () => {
  const e = env(); const infra = createFakeInfraProvider();
  const orgs = []; for (let i = 0; i < 4; i++) orgs.push(await signup(e, `due${i}@example.com`));
  for (const o of orgs.slice(0, 3)) await e.LUMMET_DB.prepare(`UPDATE organizations SET scheduled_deletion_at = ? WHERE id = ?`).bind(past(), o.org).run();
  await e.LUMMET_DB.prepare(`UPDATE organizations SET scheduled_deletion_at = ? WHERE id = ?`).bind(future(), orgs[3].org).run();
  const first = await erasure.purgeDueOrganizations(e, { infra, limit: 2 });
  assert.equal(first.processed, 2);
  const second = await erasure.purgeDueOrganizations(e, { infra, limit: 2 });
  assert.equal(second.processed, 1);
  assert.equal((await erasure.purgeDueOrganizations(e, { infra })).processed, 0);
  assert.equal(await count(e, `SELECT COUNT(*) n FROM organizations WHERE erased_at IS NOT NULL`), 3);
  assert.equal((await e.LUMMET_DB.prepare(`SELECT erased_at FROM organizations WHERE id = ?`).bind(orgs[3].org).first()).erased_at, null, 'the not-yet-due one is untouched');
});

test('people who exist only through an erased organization\'s SSO are erased with it', async () => {
  const e = env(); const a = await signup(e, 'sso-owner@example.com'); const infra = createFakeInfraProvider();
  await e.LUMMET_DB.prepare(`INSERT INTO customer_users (id, email, password_hash, sso_organization_id) VALUES ('sso-u', 'emp@corp.example', 'h', ?)`).bind(a.org).run();
  await e.LUMMET_DB.prepare(`UPDATE organizations SET scheduled_deletion_at = ? WHERE id = ?`).bind(past(), a.org).run();
  await erasure.eraseOrganization(e, a.org, { infra });
  assert.equal((await e.LUMMET_DB.prepare(`SELECT status, email FROM customer_users WHERE id = 'sso-u'`).first()).status, 'deleted');
  assert.equal((await e.LUMMET_DB.prepare(`SELECT status FROM customer_users WHERE id = ?`).bind(a.id).first()).status, 'active', 'normal accounts are not erased with the organization');
});

test('the financial retention sweep removes billing records only after the policy period', async () => {
  const e = env(); const { org } = await richOrg(e); const infra = createFakeInfraProvider();
  await erasure.eraseOrganization(e, org, { infra });
  const now = Date.now();
  assert.equal((await erasure.sweepExpiredFinancialRecords(e, { now: now + 6 * 365.25 * 86400000 })).swept, 0);
  assert.equal(await count(e, `SELECT COUNT(*) n FROM invoices WHERE organization_id = ?`, org), 1);
  assert.equal((await erasure.sweepExpiredFinancialRecords(e, { now: now + 8 * 365.25 * 86400000 })).swept, 1);
  assert.equal(await count(e, `SELECT COUNT(*) n FROM invoices WHERE organization_id = ?`, org), 0);
  assert.equal(await count(e, `SELECT COUNT(*) n FROM organizations WHERE id = ?`, org), 0);
});

test('the account page renders, lists owned organizations and offers the right action', async () => {
  const e = env(); const a = await signup(e, 'page@example.com');
  let page = await call(e, 'GET', '/app/account', { cookie: a.cookie });
  assert.equal(page.status, 200); assert.match(page.text, /Download your data/); assert.match(page.text, /Delete organization/); assert.match(page.text, /id="del-pw"/);
  assert.match(page.text, /href="\/app\/account"/);
  await e.LUMMET_DB.prepare(`UPDATE organizations SET scheduled_deletion_at = '2099-01-01T00:00:00Z' WHERE id = ?`).bind(a.org).run();
  page = await call(e, 'GET', '/app/account', { cookie: a.cookie });
  assert.match(page.text, /Cancel deletion/); assert.match(page.text, /2099-01-01/);
  assert.ok([301, 302, 303].includes((await call(e, 'GET', '/app/account')).status));
});

test('the pinger tick erases a due organization without any other trigger', async () => {
  const e = env({ ALERT_CHECK_TOKEN: 'tok' }); const a = await signup(e, 'tick@example.com');
  await e.LUMMET_DB.prepare(`UPDATE organizations SET scheduled_deletion_at = ? WHERE id = ?`).bind(past(), a.org).run();
  const h = new Headers({ Authorization: 'Bearer tok', 'CF-Connecting-IP': '198.51.100.250' });
  assert.equal((await worker.fetch(new Request('https://cp.test/api/ops/alert-check', { method: 'POST', headers: h }), e, ctx)).status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok((await e.LUMMET_DB.prepare(`SELECT erased_at FROM organizations WHERE id = ?`).bind(a.org).first()).erased_at);
});

test('v6A: erasing an organization also removes coupons reserved for it, and leaves shared coupons alone', async () => {
  const e = env(); const { org } = await richOrg(e); const db = e.LUMMET_DB;
  await db.prepare(`INSERT INTO coupons (id, code, provider, provider_coupon_id, percent_off, organization_id, note) VALUES ('c-own', 'ACME-ONLY', 'stripe', 'st1', 10, ?, 'for Acme')`).bind(org).run();
  await db.prepare(`INSERT INTO coupons (id, code, provider, provider_coupon_id, percent_off) VALUES ('c-all', 'EVERYONE', 'stripe', 'st2', 10)`).run();
  const r = await erasure.eraseOrganization(e, org, { infra: createFakeInfraProvider() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await count(e, `SELECT COUNT(*) n FROM coupons WHERE id = 'c-own'`), 0);
  assert.equal(await count(e, `SELECT COUNT(*) n FROM coupons WHERE id = 'c-all'`), 1);
});

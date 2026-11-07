// Template lines (2.7.1): what a customer sees for a brokerage site (admin setup) and what the site is bound with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import { renderDeploymentsPage } from '../worker/views/customer-pages/deployments.js';
import { buildSiteBindings, deriveAdminSetupCode } from '../worker/site-bindings.js';
import { encryptSecret } from '../worker/crypto.js';

const ROOT = 'portal-root-'.padEnd(40, 'x');
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); }, passThroughOnException() {} };
let ip = 10;
function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)), TENANT_SECRET_ROOT: ROOT, ...extra };
}
async function call(env, method, path, { body, cookie } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': `198.51.100.${ip++ % 250}` });
  if (cookie) h.set('Cookie', cookie);
  let payload;
  if (body !== undefined) { h.set('Content-Type', 'application/json'); payload = JSON.stringify(body); }
  const res = await worker.fetch(new Request('https://cp.example.test' + path, { method, headers: h, body: payload, redirect: 'manual' }), env, ctx);
  const text = await res.text();
  return { status: res.status, text, headers: res.headers, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function customerWithSite(env, email, { productId, status = 'active' }) {
  const s = await call(env, 'POST', '/api/customer/signup', { body: { email, password: 'Correct-Horse-Battery-9', organizationName: 'Org ' + email, displayName: 'T' } });
  const siteId = 'site-' + email.split('@')[0];
  await env.LUMMET_DB.prepare(`INSERT INTO sites (id, organization_id, product_id, name, slug, status, primary_domain) VALUES (?, ?, ?, 'My Site', ?, ?, 'mysite.example.test')`)
    .bind(siteId, s.json.organizationId, productId, siteId, status).run();
  return { cookie: s.cookie, siteId };
}

test('the deployments card links to admin setup only for a live brokerage site the viewer can manage', () => {
  const site = { id: 's1', name: 'S', status: 'active', template_line: 'brokerage' };
  assert.match(renderDeploymentsPage({ sites: [site], deploymentsBySite: {}, latestVersion: null, canManage: true }), /href="\/app\/sites\/s1\/admin-setup"/);
  assert.doesNotMatch(renderDeploymentsPage({ sites: [site], deploymentsBySite: {}, latestVersion: null, canManage: false }), /admin-setup/);
  assert.doesNotMatch(renderDeploymentsPage({ sites: [{ ...site, template_line: 'casino' }], deploymentsBySite: {}, latestVersion: null, canManage: true }), /admin-setup/);
  assert.doesNotMatch(renderDeploymentsPage({ sites: [{ ...site, status: 'provisioned' }], deploymentsBySite: {}, latestVersion: null, canManage: true }), /admin-setup/);
});

test('admin setup page: shows the site setup URL and the same code the site is bound with, never cached', async () => {
  const env = makeEnv();
  const { cookie, siteId } = await customerWithSite(env, 'owner@example.com', { productId: 'prod_brokerage_site' });
  const page = await call(env, 'GET', `/app/sites/${siteId}/admin-setup`, { cookie });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('Cache-Control') || '', /no-store/);
  assert.match(page.text, /https:\/\/mysite\.example\.test\/admin\/setup/);
  const code = await deriveAdminSetupCode(env, siteId);
  assert.match(code, /^[0-9a-f]{64}$/);
  assert.ok(page.text.includes(code));
  const deployments = await call(env, 'GET', '/app/deployments', { cookie });
  assert.match(deployments.text, new RegExp(`/app/sites/${siteId}/admin-setup`));
  assert.equal(await deriveAdminSetupCode(makeEnv({ TENANT_SECRET_ROOT: undefined }), siteId), null);
  assert.notEqual(await deriveAdminSetupCode(makeEnv({ TENANT_SECRET_ROOT: 'z'.repeat(40) }), siteId), code);
});

test('admin setup page: 404 for a casino site, a site not live, another organization\'s site and anonymous visitors', async () => {
  const env = makeEnv();
  const casino = await customerWithSite(env, 'casino@example.com', { productId: 'prod_casino_news' });
  assert.equal((await call(env, 'GET', `/app/sites/${casino.siteId}/admin-setup`, { cookie: casino.cookie })).status, 404);
  const pending = await customerWithSite(env, 'pending@example.com', { productId: 'prod_brokerage_site', status: 'provisioned' });
  assert.equal((await call(env, 'GET', `/app/sites/${pending.siteId}/admin-setup`, { cookie: pending.cookie })).status, 404);
  const live = await customerWithSite(env, 'live@example.com', { productId: 'prod_brokerage_site' });
  assert.equal((await call(env, 'GET', `/app/sites/${live.siteId}/admin-setup`, { cookie: casino.cookie })).status, 404, 'another organization cannot read it');
  const anon = await call(env, 'GET', `/app/sites/${live.siteId}/admin-setup`);
  assert.ok([301, 302, 303].includes(anon.status));
});

test('the brokerage site is bound with the setup code as ADMIN_BOOTSTRAP_TOKEN', async () => {
  const env = makeEnv();
  const db = env.LUMMET_DB;
  await db.prepare(`INSERT INTO tenants (id, name, host, api_base_url, status) VALUES ('t1', 'T', 't1.example.test', 'https://t1.example.test', 'active')`).run();
  const { encryptedSecret, secretIv } = await encryptSecret(env, 'hmac-secret-value');
  await db.prepare(`INSERT INTO tenant_api_credentials (tenant_id, credential_id, encrypted_secret, secret_iv, status) VALUES ('t1', 'cred-1', ?, ?, 'active')`).bind(encryptedSecret, secretIv).run();
  await db.prepare(`INSERT INTO organizations (id, name, slug) VALUES ('o1', 'O', 'o')`).run();
  await db.prepare(`INSERT INTO sites (id, organization_id, product_id, name, slug, status, tenant_id) VALUES ('s1', 'o1', 'prod_brokerage_site', 'S', 's', 'active', 't1')`).run();
  for (const [type, id] of [['d1', 'db-1'], ['kv', 'kv-1'], ['r2', 'bucket-1']]) {
    await db.prepare(`INSERT INTO site_resources (site_id, provider, resource_type, resource_id, resource_name) VALUES ('s1', 'cloudflare', ?, ?, ?)`).bind(type, id, id).run();
  }
  const b = await buildSiteBindings(env, { site: { id: 's1', tenant_id: 't1' }, deploymentId: 1, host: 'h.example.test', hasAssets: false, line: 'brokerage' });
  const token = b.find((x) => x.name === 'ADMIN_BOOTSTRAP_TOKEN');
  assert.equal(token.type, 'secret_text');
  assert.equal(token.text, await deriveAdminSetupCode(env, 's1'));
  assert.ok(token.text.length >= 32);
});

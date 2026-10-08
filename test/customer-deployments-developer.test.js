// Roadmap 1.1: customer Deployments and API keys/webhooks pages, plus the
// two route changes that let customers deploy/roll back without supplying
// script content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import { renderDeploymentsPage } from '../worker/views/customer-pages/deployments.js';
import { renderDeveloperPage } from '../worker/views/customer-pages/developer.js';

function makeEnv() {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)) };
}
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); }, passThroughOnException() {} };
let ipn = 120;
async function call(env, method, path, { body, cookie } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': `203.0.113.${ipn++ % 250}` });
  if (cookie) h.set('Cookie', cookie);
  let payload;
  if (body !== undefined) { h.set('Content-Type', 'application/json'); payload = JSON.stringify(body); }
  const res = await worker.fetch(new Request('https://cp.example.test' + path, { method, headers: h, body: payload, redirect: 'manual' }), env, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function signup(env, email) {
  const r = await call(env, 'POST', '/api/customer/signup', { body: { email, password: 'Correct-Horse-Battery-9', organizationName: 'Org ' + email, displayName: 'T' } });
  return r;
}

const site = { id: 's1', name: 'My <b>Site</b>', status: 'active' };
const dep = (o) => ({ id: 'd1', site_id: 's1', version: 'v1', status: 'active', is_rollback: 0, is_current: 0, error_message: null, created_at: '2026-10-01', ...o });

test('deployments page: update banner appears only when a newer release exists and the viewer can manage', () => {
  const current = dep({ id: 'd2', version: 'v1', is_current: 1 });
  const out = renderDeploymentsPage({ sites: [site], deploymentsBySite: { s1: [current] }, latestVersion: 'v2', canManage: true });
  assert.match(out, /Update to v2/);
  const viewer = renderDeploymentsPage({ sites: [site], deploymentsBySite: { s1: [current] }, latestVersion: 'v2', canManage: false });
  assert.doesNotMatch(viewer, /Update to v2/);
  const upToDate = renderDeploymentsPage({ sites: [site], deploymentsBySite: { s1: [current] }, latestVersion: 'v1', canManage: true });
  assert.match(upToDate, /up to date/);
});

test('deployments page: rollback is offered only for earlier successful deploys, and names are escaped', () => {
  const out = renderDeploymentsPage({
    sites: [site],
    deploymentsBySite: { s1: [dep({ id: 'cur', version: 'v2', is_current: 1 }), dep({ id: 'old', version: 'v1' }), dep({ id: 'bad', version: 'v0', status: 'failed', error_message: 'health check failed' })] },
    latestVersion: 'v2', canManage: true
  });
  assert.match(out, /data-onclick="lummetRollback" data-args="\[&quot;s1&quot;,&quot;old&quot;\]"/);
  assert.doesNotMatch(out, /data-onclick="lummetRollback" data-args="\[&quot;s1&quot;,&quot;cur&quot;\]"/);
  assert.doesNotMatch(out, /data-onclick="lummetRollback" data-args="\[&quot;s1&quot;,&quot;bad&quot;\]"/);
  assert.match(out, /health check failed/);
  assert.doesNotMatch(out, /<b>Site<\/b>/);
  assert.match(out, /&lt;b&gt;Site/);
});

test('deployments page: empty states render without throwing', () => {
  assert.match(renderDeploymentsPage({ sites: [], deploymentsBySite: {}, latestVersion: null, canManage: true }), /Create a site first/);
  assert.match(renderDeploymentsPage({ sites: [site], deploymentsBySite: {}, latestVersion: null, canManage: true }), /No deployments yet/);
});

test('developer page: non-admins see no keys or forms; admins get both sections, escaped', () => {
  const viewer = renderDeveloperPage({ apiKeys: [{ id: 'k', name: 'x', key_prefix: 'abc', scopes: [], status: 'active' }], webhooks: [], eventTypes: [], canManage: false });
  assert.match(viewer, /Only organization admins/);
  assert.doesNotMatch(viewer, /key-form/);

  const admin = renderDeveloperPage({
    apiKeys: [{ id: 'k1', name: '<script>x</script>', key_prefix: 'lk_ab', scopes: ['sites:read'], status: 'active', last_used_at: null }, { id: 'k2', name: 'old', key_prefix: 'lk_cd', scopes: [], status: 'revoked' }],
    webhooks: [{ id: 'w1', url: 'https://example.com/h', event_types: ['site.active'], status: 'active' }],
    eventTypes: ['site.active'], canManage: true
  });
  assert.match(admin, /id="key-form"/);
  assert.match(admin, /id="hook-form"/);
  assert.doesNotMatch(admin, /<script>x<\/script>/);
  assert.match(admin, /data-onclick="lummetRevokeKey" data-args="\[&quot;k1&quot;\]"/);
  assert.doesNotMatch(admin, /data-onclick="lummetRevokeKey" data-args="\[&quot;k2&quot;\]"/);
  assert.match(admin, /data-onclick="lummetRotateSecret" data-args="\[&quot;w1&quot;\]"/);
});

test('routes: both new pages render for a signed-in customer and are in the nav', async () => {
  const env = makeEnv();
  const s = await signup(env, 'dev@example.com');
  for (const [path, text] of [['/app/deployments', /Deployments/], ['/app/developer', /API keys/]]) {
    const r = await call(env, 'GET', path, { cookie: s.cookie });
    assert.equal(r.status, 200, path);
    assert.match(r.text, text);
    assert.match(r.text, /href="\/app\/deployments"/);
    assert.match(r.text, /href="\/app\/developer"/);
  }
  assert.ok([301, 302, 303].includes((await call(env, 'GET', '/app/deployments')).status));
});

test('routes: deploy-latest requires auth, 404s for an unknown site, and rollback still 404s for unknown sites', async () => {
  const env = makeEnv();
  const s = await signup(env, 'dl@example.com');
  const orgId = s.json.organizationId;
  assert.equal((await call(env, 'POST', `/api/organizations/${orgId}/sites/nope/deployments/latest`)).status, 401);
  const unknown = await call(env, 'POST', `/api/organizations/${orgId}/sites/nope/deployments/latest`, { cookie: s.cookie, body: {} });
  assert.equal(unknown.status, 404);
  const rb = await call(env, 'POST', `/api/organizations/${orgId}/sites/nope/deployments/x/rollback`, { cookie: s.cookie, body: {} });
  assert.equal(rb.status, 404);
});

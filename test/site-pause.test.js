// Customer pause / resume of a live site: offline without deleting, undoable only by the customer, never a way around a staff suspension.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';
import worker from '../worker/index.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';
import * as access from '../worker/site-access.js';
import { createProvisioningService } from '../worker/provisioning.js';
import { createDeploymentService } from '../worker/deployments.js';

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); }, passThroughOnException() {} };
let ipn = 90;
function makeEnv() {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, ENVIRONMENT: 'production', PLATFORM_DOMAIN_SUFFIX: 'lummet.app', CF_ZONE_ID: 'zone-default', CREDENTIAL_KEK: btoa('k'.repeat(32)) };
}
async function call(env, method, path, { body, cookie } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': `198.51.100.${(ipn++ % 240) + 1}` });
  if (cookie) h.set('Cookie', cookie);
  let payload; if (body !== undefined) { h.set('Content-Type', 'application/json'); payload = JSON.stringify(body); }
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: payload, redirect: 'manual' }), env, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function signup(env, email) {
  const r = await call(env, 'POST', '/api/customer/signup', { body: { email, password: 'Correct-Horse-Battery-9', organizationName: 'Org ' + email, displayName: 'T' } });
  assert.equal(r.status, 200, r.text);
  await plans.startTrialSubscription(env, r.json.organizationId, 'plan_casino_news_starter').catch(() => {});
  return { cookie: r.cookie, orgId: r.json.organizationId };
}
async function activeSite(env, o, name = 'Pausable') {
  const made = await call(env, 'POST', `/api/organizations/${o.orgId}/sites`, { cookie: o.cookie, body: { name, productId: 'prod_casino_news' } });
  assert.equal(made.status, 200, made.text);
  await env.LUMMET_DB.prepare(`UPDATE sites SET status = 'active' WHERE id = ?`).bind(made.json.siteId).run();
  return made.json.siteId;
}
const action = (env, o, siteId, a) => call(env, 'POST', `/api/organizations/${o.orgId}/sites/${siteId}/${a}`, { cookie: o.cookie, body: {} });
const status = async (env, id) => (await sites.getSite(env, id)).status;

test('a customer admin can pause a live site and resume it; the list says who paused it', async () => {
  const env = makeEnv(); const o = await signup(env, 'pause-a@example.com');
  const id = await activeSite(env, o);
  assert.equal((await action(env, o, id, 'pause')).status, 200);
  assert.equal(await status(env, id), 'suspended');
  const list = (await sites.listSitesForOrganization(env, o.orgId)).find((s) => s.id === id);
  assert.equal(list.suspended_by, 'customer_user');
  assert.equal((await action(env, o, id, 'pause')).json.error, 'already_paused');
  assert.equal((await action(env, o, id, 'resume')).status, 200);
  assert.equal(await status(env, id), 'active');
  assert.equal((await action(env, o, id, 'resume')).json.error, 'not_paused');
  const audit = await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM lummet_audit_logs WHERE resource_id = ? AND action IN ('pause','resume') AND success = 1`).bind(id).first();
  assert.equal(audit.n, 2);
});

test('only a live site can be paused', async () => {
  const env = makeEnv(); const o = await signup(env, 'pause-b@example.com');
  const made = await call(env, 'POST', `/api/organizations/${o.orgId}/sites`, { cookie: o.cookie, body: { name: 'Not live', productId: 'prod_casino_news' } });
  const r = await action(env, o, made.json.siteId, 'pause');
  assert.equal(r.status, 409); assert.equal(r.json.error, 'site_not_live');
  assert.equal(await status(env, made.json.siteId), 'pending');
});

test('a site Lummet suspended cannot be resumed by the customer, and pausing is not a way around it', async () => {
  const env = makeEnv(); const o = await signup(env, 'pause-c@example.com');
  const id = await activeSite(env, o);
  await access.suspendSite(env, id, { reason: 'abuse report', actorId: '1', actorType: 'lummet_admin' });
  const r = await action(env, o, id, 'resume');
  assert.equal(r.status, 403); assert.equal(r.json.error, 'suspended_by_lummet');
  assert.equal(await status(env, id), 'suspended');
  assert.equal((await action(env, o, id, 'pause')).json.error, 'already_paused', 'a second suspension cannot re-label it as the customer\'s');
  assert.equal((await sites.listSitesForOrganization(env, o.orgId)).find((s) => s.id === id).suspended_by, 'lummet_admin');
  // Staff can still reactivate it.
  assert.equal((await access.reactivateSite(env, id, { reason: 'resolved', actorId: '1' })).ok, true);
  assert.equal(await status(env, id), 'active');
});

test('a staff suspension on top of a customer pause hands control to staff', async () => {
  const env = makeEnv(); const o = await signup(env, 'pause-d@example.com');
  const id = await activeSite(env, o);
  await action(env, o, id, 'pause');
  await access.reactivateSite(env, id, { reason: 'x', actorId: '1' });          // staff reactivate...
  await access.suspendSite(env, id, { reason: 'abuse', actorId: '1' });          // ...then suspend
  assert.equal((await action(env, o, id, 'resume')).json.error, 'suspended_by_lummet');
});

test('a paused site cannot be resumed while the organization itself is not active', async () => {
  const env = makeEnv(); const o = await signup(env, 'pause-e@example.com');
  const id = await activeSite(env, o);
  await action(env, o, id, 'pause');
  await env.LUMMET_DB.prepare(`UPDATE organizations SET status = 'suspended' WHERE id = ?`).bind(o.orgId).run();
  const r = await action(env, o, id, 'resume');
  assert.equal(r.json.error, 'organization_suspended', 'the platform-wide organization guard refuses it first');
  assert.equal(await status(env, id), 'suspended');
});

test('another organization cannot pause or resume the site', async () => {
  const env = makeEnv(); const a = await signup(env, 'pause-f@example.com'); const b = await signup(env, 'pause-g@example.com');
  const id = await activeSite(env, a);
  assert.equal((await action(env, b, id, 'pause')).status, 404);
  assert.equal(await status(env, id), 'active');
});

test('a paused site can still be deleted', async () => {
  const env = makeEnv(); const o = await signup(env, 'pause-h@example.com');
  const id = await activeSite(env, o);
  await action(env, o, id, 'pause');
  const del = await call(env, 'DELETE', `/api/organizations/${o.orgId}/sites/${id}`, { cookie: o.cookie, body: { confirmName: 'Pausable' } });
  assert.equal(del.status, 202, del.text);
});

test('pausing queues the signed "suspended" access state for the tenant, and resuming queues "serving"', async () => {
  const env = makeEnv(); const o = await signup(env, 'pause-i@example.com');
  const made = await call(env, 'POST', `/api/organizations/${o.orgId}/sites`, { cookie: o.cookie, body: { name: 'With tenant', productId: 'prod_casino_news' } });
  const id = made.json.siteId;
  const infra = createFakeInfraProvider();
  const prov = createProvisioningService(infra, { deploymentService: createDeploymentService(infra) });
  await prov.runJob(env, (await prov.startProvisioning(env, id)).jobId);
  assert.ok((await sites.getSite(env, id)).tenant_id, 'provisioned with a tenant');
  await env.LUMMET_DB.prepare(`UPDATE sites SET status = 'active' WHERE id = ?`).bind(id).run();

  await action(env, o, id, 'pause');
  let jobs = (await env.LUMMET_DB.prepare(`SELECT desired_state, status FROM site_access_push_jobs WHERE site_id = ? ORDER BY generation`).bind(id).all()).results;
  assert.equal(jobs.at(-1).desired_state, 'suspended');
  await action(env, o, id, 'resume');
  jobs = (await env.LUMMET_DB.prepare(`SELECT desired_state, status FROM site_access_push_jobs WHERE site_id = ? ORDER BY generation`).bind(id).all()).results;
  assert.equal(jobs.at(-1).desired_state, 'serving');
  assert.equal(jobs.filter((j) => j.status === 'pending').length, 1, 'only the newest state is pending');
});

test('the Sites page offers Pause on live sites, Resume only on customer pauses, and says who suspended the others', async () => {
  const { renderSitesPage } = await import('../worker/views/customer-pages/sites.js');
  const html = renderSitesPage({
    sites: [
      { id: 'live', name: 'Live', status: 'active', product_name: 'P' },
      { id: 'mine', name: 'Mine', status: 'suspended', suspended_by: 'customer_user', product_name: 'P' },
      { id: 'theirs', name: 'Theirs', status: 'suspended', suspended_by: 'lummet_admin', product_name: 'P' }
    ],
    products: [{ id: 'p', name: 'P' }], canManage: true, platformDomains: []
  });
  assert.equal((html.match(/lummetPauseSite/g) || []).length >= 1, true);
  assert.ok(html.includes('Pause site')); assert.ok(html.includes('Resume site')); assert.ok(html.includes('Suspended by Lummet'));
  assert.equal((html.match(/Resume site/g) || []).length, 1, 'only the customer-paused site can be resumed');
  assert.ok(html.includes('>paused<'), 'a customer pause reads "paused", not "suspended"');
  const script = html.match(/<script[^>]*>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script), 'the page script parses');
});

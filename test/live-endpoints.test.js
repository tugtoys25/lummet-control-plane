// The endpoints behind the live regions: who may read them, what they return, and that they match the pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';
import { liveHash } from '../worker/live.js';

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); }, passThroughOnException() {} };
let ipn = 140;
const makeEnv = () => { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, ENVIRONMENT: 'production', PLATFORM_DOMAIN_SUFFIX: 'lummet.app', CF_ZONE_ID: 'z', CREDENTIAL_KEK: btoa('k'.repeat(32)) }; };
async function call(env, method, path, { body, cookie } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': `198.51.100.${(ipn++ % 240) + 1}` });
  if (cookie) h.set('Cookie', cookie);
  let payload; if (body !== undefined) { h.set('Content-Type', 'application/json'); payload = JSON.stringify(body); }
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: payload, redirect: 'manual' }), env, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function signup(env, email) {
  const r = await call(env, 'POST', '/api/customer/signup', { body: { email, password: 'Correct-Horse-Battery-9', organizationName: 'Org ' + email, displayName: 'T' } });
  assert.equal(r.status, 200, r.text);
  await plans.startTrialSubscription(env, r.json.organizationId, 'plan_casino_news_starter').catch(() => {});
  return { cookie: r.cookie, orgId: r.json.organizationId };
}
const create = (env, o, name) => call(env, 'POST', `/api/organizations/${o.orgId}/sites`, { cookie: o.cookie, body: { name, productId: 'prod_casino_news' } });

test('sites live-rows: returns the rows, a hash, and busy while a site is in flight; never cached', async () => {
  const env = makeEnv(); const o = await signup(env, 'live-a@example.com');
  const made = await create(env, o, 'Alpha');
  const r = await call(env, 'GET', `/api/organizations/${o.orgId}/sites/live-rows`, { cookie: o.cookie });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.ok(r.json.data.html.includes('Alpha'));
  assert.equal(r.json.data.hash, liveHash(r.json.data.html));
  assert.equal(r.json.data.busy, true, 'a pending site is in flight');

  await env.LUMMET_DB.prepare(`UPDATE sites SET status = 'active' WHERE id = ?`).bind(made.json.siteId).run();
  const waiting = await call(env, 'GET', `/api/organizations/${o.orgId}/sites/live-rows`, { cookie: o.cookie });
  assert.equal(waiting.json.data.busy, true, 'live, but its first setup is still waiting to apply');
  await env.LUMMET_DB.prepare(`UPDATE site_setup_requests SET status = 'applied' WHERE site_id = ?`).bind(made.json.siteId).run();
  const settled = await call(env, 'GET', `/api/organizations/${o.orgId}/sites/live-rows`, { cookie: o.cookie });
  assert.equal(settled.json.data.busy, false);
  assert.notEqual(settled.json.data.hash, r.json.data.hash, 'the change is visible to the poller');
  assert.ok(settled.json.data.html.includes('Pause site'), 'an admin gets the action buttons');

  await env.LUMMET_DB.prepare(`UPDATE sites SET status = 'deleting' WHERE id = ?`).bind(made.json.siteId).run();
  const deleting = await call(env, 'GET', `/api/organizations/${o.orgId}/sites/live-rows`, { cookie: o.cookie });
  assert.equal(deleting.json.data.busy, true); assert.ok(deleting.json.data.html.includes('Deleting'));
});

test('sites live-rows: the page ships the same hash the endpoint returns, so nothing flickers on the first poll', async () => {
  const env = makeEnv(); const o = await signup(env, 'live-b@example.com');
  await create(env, o, 'Beta');
  const page = await call(env, 'GET', `/app/sites?org=${o.orgId}`, { cookie: o.cookie });
  assert.equal(page.status, 200);
  const hash = (page.text.match(/data-live-hash="([0-9a-f]{8})"/) || [])[1];
  const live = await call(env, 'GET', `/api/organizations/${o.orgId}/sites/live-rows`, { cookie: o.cookie });
  assert.equal(hash, live.json.data.hash);
  assert.ok(page.text.includes(`data-live-src="/api/organizations/${o.orgId}/sites/live-rows"`));
});

test('live endpoints need a signed-in member of that organization', async () => {
  const env = makeEnv(); const a = await signup(env, 'live-c@example.com'); const b = await signup(env, 'live-d@example.com');
  for (const path of ['sites/live-rows', 'deployments/live-cards']) {
    assert.equal((await call(env, 'GET', `/api/organizations/${a.orgId}/${path}`)).status, 401, `${path}: signed out`);
    const other = await call(env, 'GET', `/api/organizations/${a.orgId}/${path}`, { cookie: b.cookie });
    assert.ok(other.status === 403 || other.status === 404, `${path}: another organization is refused (${other.status})`);
    assert.ok(!other.text.includes('live-c@example.com'));
  }
});

test('deployments live-cards: returns the cards and a hash, and the page ships the matching hash', async () => {
  const env = makeEnv(); const o = await signup(env, 'live-e@example.com');
  const made = await create(env, o, 'Gamma');
  await env.LUMMET_DB.prepare(`UPDATE sites SET status = 'active' WHERE id = ?`).bind(made.json.siteId).run();
  const r = await call(env, 'GET', `/api/organizations/${o.orgId}/deployments/live-cards`, { cookie: o.cookie });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.ok(r.json.data.html.includes('Gamma')); assert.equal(r.json.data.busy, false);
  const page = await call(env, 'GET', `/app/deployments?org=${o.orgId}`, { cookie: o.cookie });
  assert.equal(page.status, 200);
  assert.equal((page.text.match(/data-live-hash="([0-9a-f]{8})"/) || [])[1], r.json.data.hash);
});

test('the pages that were slow still render correctly after the reads were batched', async () => {
  const env = makeEnv(); const o = await signup(env, 'live-f@example.com');
  const s1 = await create(env, o, 'One');
  for (const path of ['/app/overview', '/app/sites', '/app/domains', '/app/deployments', '/app/billing']) {
    const r = await call(env, 'GET', `${path}?org=${o.orgId}`, { cookie: o.cookie });
    assert.equal(r.status, 200, `${path} ${r.status}`);
  }
  const domains = await call(env, 'GET', `/app/domains?org=${o.orgId}`, { cookie: o.cookie });
  assert.ok(domains.text.includes('One'));
  assert.ok(s1.json.siteId);
});

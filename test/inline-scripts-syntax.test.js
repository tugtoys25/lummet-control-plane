// A page whose inline <script> has a syntax error loses ALL of its buttons silently (the browser drops the whole
// script and shows nothing). The two-factor page once had exactly that: a "\n" inside a template literal became a
// real newline inside a JS string. This renders the main staff and customer pages and compiles every inline script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';

test('every inline script on the main staff and customer pages is valid JavaScript', async () => {
  const db = createTestDb(); applyMigrations(db);
  const env = { LUMMET_DB: db, ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)) };
  const ctx = { waitUntil() {} }; let n = 1;
  const call = async (method, path, { body, cookie } = {}) => {
    const h = new Headers({ 'CF-Connecting-IP': `198.19.8.${n++ % 250 + 1}` });
    if (cookie) h.set('Cookie', cookie);
    if (body !== undefined) h.set('Content-Type', 'application/json');
    const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' }), env, ctx);
    return { status: res.status, text: await res.text(), cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
  };
  const broken = [];
  let checked = 0;
  const check = (label, r) => {
    for (const m of r.text.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/src=/.test(m[1])) continue;
      checked++;
      try { new vm.Script(m[2]); } catch (e) { broken.push(`${label}: ${e.message}`); }
    }
  };
  await call('POST', '/api/auth/bootstrap', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } });
  const staff = (await call('POST', '/api/auth/login', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } })).cookie;
  for (const p of ['/dashboard', '/account/2fa', '/account/password', '/platform/saas', '/platform/saas/revenue-analytics', '/platform/saas/organizations', '/platform/saas/subscriptions', '/platform/saas/plans', '/platform/saas/coupons', '/platform/saas/domains', '/platform/saas/deployments', '/platform/saas/webhooks', '/platform/saas/api-keys', '/platform/saas/backups', '/platform/saas/alerts', '/platform/saas/errors', '/platform/saas/cp-backups', '/platform/saas/key-rotation', '/platform/saas/jobs', '/platform/saas/email', '/platform/saas/releases', '/tenants']) {
    const r = await call('GET', p, { cookie: staff });
    assert.equal(r.status, 200, `staff ${p}`);
    check(`staff ${p}`, r);
  }
  const customer = (await call('POST', '/api/customer/signup', { body: { email: 'c@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'Org', displayName: 'T' } })).cookie;
  for (const p of ['/app/overview', '/app/sites', '/app/content', '/app/analytics', '/app/reports', '/app/campaigns', '/app/alerts', '/app/notifications', '/app/domains', '/app/deployments', '/app/team', '/app/billing', '/app/usage', '/app/backups', '/app/automations', '/app/search', '/app/settings', '/app/account']) {
    const r = await call('GET', p, { cookie: customer });
    assert.equal(r.status, 200, `customer ${p}`);
    check(`customer ${p}`, r);
  }
  assert.ok(checked > 60, `only ${checked} scripts were checked`);
  assert.deepEqual(broken, []);
});

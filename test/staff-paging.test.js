// Staff list paging: 50 per page, Previous/Next that keep filters, stable order, safe page input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';

const ctx = { waitUntil() {} };
let n = 1;
function makeEnv() { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)) }; }
async function call(env, method, path, body, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': `198.18.1.${n++ % 250 + 1}` });
  if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  return { status: res.status, text: await res.text(), cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function staffLogin(env) {
  await call(env, 'POST', '/api/auth/bootstrap', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' });
  return (await call(env, 'POST', '/api/auth/login', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' })).cookie;
}
const ids = (html, prefix) => [...html.matchAll(new RegExp(`${prefix}([A-Za-z0-9_-]+)"`, 'g'))].map((m) => m[1]);

test('organizations: 120 rows page as 50/50/20 with no duplicates or gaps, even with identical timestamps', async () => {
  const env = makeEnv(); const staff = await staffLogin(env);
  for (let i = 0; i < 120; i++) {
    await env.LUMMET_DB.prepare(`INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, '2026-01-01 00:00:00')`).bind(`org_${String(i).padStart(3, '0')}`, `Org ${i}`, `org-${i}`).run();
  }
  const seen = [];
  for (const [page, expected, next] of [[1, 50, true], [2, 50, true], [3, 20, false]]) {
    const r = await call(env, 'GET', `/platform/saas/organizations${page > 1 ? '?page=' + page : ''}`, null, staff);
    assert.equal(r.status, 200);
    const got = ids(r.text, '/platform/saas/organizations/');
    assert.equal(got.length, expected, `page ${page}`);
    assert.equal(/Next &rarr;/.test(r.text), next, `next on page ${page}`);
    assert.equal(/Previous/.test(r.text), page > 1);
    seen.push(...got);
  }
  assert.equal(new Set(seen).size, 120);
});

test('jobs: pager links keep the active filters; bad page values fall back to page 1', async () => {
  const env = makeEnv(); const staff = await staffLogin(env);
  for (let i = 0; i < 60; i++) {
    await env.LUMMET_DB.prepare(`INSERT INTO jobs (id, type, status) VALUES (?, 'tenant_provisioning', 'failed')`).bind(`job_${i}`).run();
  }
  await env.LUMMET_DB.prepare(`INSERT INTO jobs (id, type, status) VALUES ('job_ok', 'tenant_provisioning', 'success')`).run();

  const p1 = await call(env, 'GET', '/platform/saas/jobs?status=failed', null, staff);
  assert.equal(ids(p1.text, '/platform/saas/jobs/').length, 50);
  assert.match(p1.text, /href="\/platform\/saas\/jobs\?status=failed&amp;page=2"/);
  assert.ok(!p1.text.includes('job_ok'));

  const p2 = await call(env, 'GET', '/platform/saas/jobs?status=failed&page=2', null, staff);
  assert.equal(ids(p2.text, '/platform/saas/jobs/').length, 10);
  assert.doesNotMatch(p2.text, /Next &rarr;/);
  assert.match(p2.text, /href="\/platform\/saas\/jobs\?status=failed"/); // Previous goes to page 1 without ?page=1

  for (const bad of ['0', '-3', 'abc', '99999999999', '1e9', '']) {
    const r = await call(env, 'GET', `/platform/saas/jobs?status=failed&page=${bad}`, null, staff);
    assert.equal(r.status, 200, bad);
    assert.equal(ids(r.text, '/platform/saas/jobs/').length, 50, `page=${bad} behaves as page 1`);
  }
});

test('operational lists (domains, backups, webhooks, api keys, deployments, subscriptions) accept ?page= and render', async () => {
  const env = makeEnv(); const staff = await staffLogin(env);
  for (const p of ['domains', 'deployments', 'webhooks', 'api-keys', 'backups', 'subscriptions']) {
    const r = await call(env, 'GET', `/platform/saas/${p}?page=2`, null, staff);
    assert.equal(r.status, 200, p);
  }
});

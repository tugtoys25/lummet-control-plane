import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import * as plans from '../worker/plans.js';

const ctx = { waitUntil() {} };
let n = 1;
async function get(env, path, cookie) {
  const res = await worker.fetch(new Request('https://cp.test' + path, { headers: { Cookie: cookie, 'CF-Connecting-IP': `198.51.100.${n++ % 250 + 1}` } }), env, ctx);
  return { status: res.status, text: await res.text() };
}
async function signup(env, email) {
  const res = await worker.fetch(new Request('https://cp.test/api/customer/signup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `198.51.100.${n++ % 250 + 1}` }, body: JSON.stringify({ email, password: 'Correct-Horse-Battery-9', organizationName: 'Org', displayName: 'T' }) }), env, ctx);
  const j = await res.json();
  return { orgId: j.organizationId, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}

test('Starter does not see Backups/Automations links; a higher plan does; the page itself still explains the limit', async () => {
  const db = createTestDb(); applyMigrations(db);
  const env = { LUMMET_DB: db, ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)) };
  const [starter, growth, pro] = ['starter', 'growth', 'pro'].map((k) => `plan_casino_news_${k}`);

  const s = await signup(env, 'starter@example.com');
  await plans.startTrialSubscription(env, s.orgId, starter);
  const sOverview = await get(env, '/app/overview', s.cookie);
  assert.equal(sOverview.status, 200);
  assert.match(sOverview.text, /href="\/app\/sites"/);
  assert.match(sOverview.text, /href="\/app\/developer"/);
  assert.doesNotMatch(sOverview.text, /href="\/app\/backups"/);
  assert.doesNotMatch(sOverview.text, /href="\/app\/automations"/);

  // Reached by URL, the page renders, keeps its own nav link and shows the upgrade notice.
  const page = await get(env, '/app/backups', s.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /href="\/app\/backups"/);
  assert.match(page.text, /aren't included in your current plan/);
  assert.doesNotMatch(page.text, /href="\/app\/automations"/);

  // Growth includes backups but not automations.
  const g = await signup(env, 'growth@example.com');
  await plans.startTrialSubscription(env, g.orgId, growth);
  const gOverview = await get(env, '/app/overview', g.cookie);
  assert.match(gOverview.text, /href="\/app\/backups"/);
  assert.doesNotMatch(gOverview.text, /href="\/app\/automations"/);

  const p = await signup(env, 'pro@example.com');
  await plans.startTrialSubscription(env, p.orgId, pro);
  const pOverview = await get(env, '/app/overview', p.cookie);
  assert.match(pOverview.text, /href="\/app\/backups"/);
  assert.match(pOverview.text, /href="\/app\/automations"/);
});

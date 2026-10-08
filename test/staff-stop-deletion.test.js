import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import * as organizations from '../worker/organizations.js';

const ctx = { waitUntil() {} };
let n = 1;
function makeEnv() { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)) }; }
async function call(env, method, path, body, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': `198.19.2.${n++ % 250 + 1}` });
  if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  return { status: res.status, text: await res.text(), cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function staffLogin(env) {
  await call(env, 'POST', '/api/auth/bootstrap', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' });
  return (await call(env, 'POST', '/api/auth/login', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' })).cookie;
}
async function scheduledOrg(env) {
  const s = await call(env, 'POST', '/api/customer/signup', { email: 'del@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'Doomed', displayName: 'T' });
  const sj = JSON.parse(s.text);
  const user = await env.LUMMET_DB.prepare(`SELECT id FROM customer_users WHERE email = ?`).bind('del@example.com').first();
  const r = await organizations.requestDeletion(env, sj.organizationId, user.id, {});
  assert.equal(r.ok, true, JSON.stringify(r));
  return sj.organizationId;
}

test('staff cannot mark an organization active while an erasure is scheduled; they must stop the deletion', async () => {
  const env = makeEnv(); const staff = await staffLogin(env); const org = await scheduledOrg(env);
  const bad = await call(env, 'POST', `/api/platform/saas/organizations/${org}/status`, { status: 'active' }, staff);
  assert.equal(bad.status, 409); assert.match(bad.text, /deletion_scheduled_stop_it_first/);
  const page = await call(env, 'GET', `/platform/saas/organizations/${org}`, null, staff);
  assert.match(page.text, /Stop scheduled deletion/); assert.doesNotMatch(page.text, />Reactivate</);
});

test('stop-deletion clears the schedule, reactivates, is audited, and is refused when nothing is scheduled', async () => {
  const env = makeEnv(); const staff = await staffLogin(env); const org = await scheduledOrg(env);
  const ok = await call(env, 'POST', `/api/platform/saas/organizations/${org}/stop-deletion`, {}, staff);
  assert.equal(ok.status, 200, ok.text);
  const row = await env.LUMMET_DB.prepare(`SELECT status, scheduled_deletion_at FROM organizations WHERE id = ?`).bind(org).first();
  assert.equal(row.status, 'active'); assert.equal(row.scheduled_deletion_at, null);
  assert.equal((await call(env, 'POST', `/api/platform/saas/organizations/${org}/stop-deletion`, {}, staff)).status, 409);
  const audit = await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM lummet_audit_logs WHERE action = 'stop_scheduled_deletion' AND success = 1`).first();
  assert.equal(audit.n, 1);
});

test('stop-deletion needs a staff session', async () => {
  const env = makeEnv(); const org = await scheduledOrg(env);
  const r = await call(env, 'POST', `/api/platform/saas/organizations/${org}/stop-deletion`, {});
  assert.ok([401, 403].includes(r.status), String(r.status));
});

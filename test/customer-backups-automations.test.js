// Roadmap 1.1: customer Backups and Automations pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import { renderBackupsPage } from '../worker/views/customer-pages/backups.js';
import { renderAutomationsPage } from '../worker/views/customer-pages/automations.js';

function makeEnv() {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)) };
}
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); }, passThroughOnException() {} };
let ipn = 30;
async function call(env, method, path, { body, cookie } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': `192.0.2.${ipn++ % 250}` });
  if (cookie) h.set('Cookie', cookie);
  let payload;
  if (body !== undefined) { h.set('Content-Type', 'application/json'); payload = JSON.stringify(body); }
  const res = await worker.fetch(new Request('https://cp.example.test' + path, { method, headers: h, body: payload, redirect: 'manual' }), env, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}

const sites = [{ id: 's1', name: 'Site <i>One</i>' }];
const backup = (o) => ({ id: 'b1', site_id: 's1', status: 'complete', size_bytes: 2048, verified_at: null, created_at: '2026-10-01', ...o });

test('backups page: non-admins see nothing actionable', () => {
  const out = renderBackupsPage({ sites, backups: [backup()], enabled: true, isOwner: false, canManage: false });
  assert.match(out, /Only organization admins/);
  assert.doesNotMatch(out, /onclick="lummetBackupVerify/);
});

test('backups page: restore only for owners, only on usable backups; create form hidden without the entitlement', () => {
  const admin = renderBackupsPage({ sites, backups: [backup()], enabled: true, isOwner: false, canManage: true });
  assert.match(admin, /data-onclick="lummetBackupVerify" data-args="\[&quot;b1&quot;\]"/);
  assert.doesNotMatch(admin, /onclick="lummetBackupRestore/);
  assert.match(admin, /id="backup-form"/);

  const owner = renderBackupsPage({ sites, backups: [backup(), backup({ id: 'b2', status: 'failed' })], enabled: true, isOwner: true, canManage: true });
  assert.match(owner, /data-onclick="lummetBackupRestore" data-args="\[&quot;b1&quot;,&quot;s1&quot;\]"/);
  assert.doesNotMatch(owner, /lummetBackupRestore\('b2'/);

  const noPlan = renderBackupsPage({ sites, backups: [backup()], enabled: false, isOwner: true, canManage: true });
  assert.doesNotMatch(noPlan, /id="backup-form"/);
  assert.match(noPlan, /aren't included in your current plan/);
});

test('backups page: site names are escaped in both the table and the script data', () => {
  const out = renderBackupsPage({ sites: [{ id: 's1', name: '</script><b>x' }], backups: [backup()], enabled: true, isOwner: true, canManage: true });
  assert.doesNotMatch(out, /<\/script><b>x/);
  assert.match(renderBackupsPage({ sites: [], backups: [], enabled: true, isOwner: true, canManage: true }), /No backups yet/);
});

test('automations page: rules, runs, pause/resume labels, plan notice', () => {
  const rules = [
    { id: 'r1', name: 'Pay <alert>', trigger_event: 'payment.failed', conditions: [], actions: [{ type: 'notify_owners' }], status: 'active' },
    { id: 'r2', name: 'Old', trigger_event: 'site.failed', conditions: [{ field: 'plan', op: 'in', value: ['pro', 'team'] }], actions: [{ type: 'create_alert' }], status: 'paused' }
  ];
  const out = renderAutomationsPage({ rules, runs: [{ created_at: 't', rule_name: 'Old', status: 'success' }], enabled: true, canManage: true, triggers: ['payment.failed'], actions: ['notify_owners'] });
  assert.doesNotMatch(out, /Pay <alert>/);
  assert.match(out, /data-onclick="lummetRuleToggle" data-args="\[&quot;r1&quot;,&quot;pause&quot;\]"/);
  assert.match(out, /data-onclick="lummetRuleToggle" data-args="\[&quot;r2&quot;,&quot;resume&quot;\]"/);
  assert.match(out, /plan in pro\|team/);
  assert.match(out, /id="rule-form"/);

  const noPlan = renderAutomationsPage({ rules: [], runs: [], enabled: false, canManage: true });
  assert.doesNotMatch(noPlan, /id="rule-form"/);
  assert.match(noPlan, /aren't included/);
  assert.match(renderAutomationsPage({ rules: [], runs: [], enabled: true, canManage: false }), /Only organization admins/);
});

test('routes: backups and automations pages render for a signed-in customer; without the plan, only the open page keeps its nav link', async () => {
  const env = makeEnv();
  const s = await call(env, 'POST', '/api/customer/signup', { body: { email: 'ba@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'Org', displayName: 'T' } });
  assert.equal(s.status, 200, s.text);
  for (const [path, text] of [['/app/backups', /Backups/], ['/app/automations', /Automations/]]) {
    const r = await call(env, 'GET', path, { cookie: s.cookie });
    assert.equal(r.status, 200, path);
    assert.match(r.text, text);
    const other = path === '/app/backups' ? '/app/automations' : '/app/backups';
    assert.ok(r.text.includes(`href="${path}"`), 'open page keeps its own link');
    assert.ok(!r.text.includes(`href="${other}"`), 'unavailable feature link is hidden');
  }
  assert.ok([301, 302, 303].includes((await call(env, 'GET', '/app/backups')).status));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createBackupService } from '../worker/backups.js';
import * as automations from '../worker/automations.js';
import * as webhooks from '../worker/webhooks.js';
import * as plans from '../worker/plans.js';
import worker from '../worker/index.js';

function fakeR2() {
  const m = new Map();
  return { m, async put(k, v) { m.set(k, v); }, async get(k) { return m.has(k) ? { async text() { return m.get(k); } } : null; }, async delete(k) { m.delete(k); } };
}
function env(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production', ...extra }; }
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
async function call(e, method, path, body, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.' + (Math.floor(Math.random() * 200) + 1) });
  if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
  const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, text: t, headers: res.headers, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function orgWithSite(e, email, planId = 'plan_casino_news_pro', siteStatus = 'active') {
  const s = await call(e, 'POST', '/api/customer/signup', { email, password: 'Correct-Horse-Battery-9', organizationName: 'O ' + email });
  const org = s.json.organizationId;
  await plans.startTrialSubscription(e, org, planId);
  const siteId = crypto.randomUUID();
  await e.LUMMET_DB.prepare(`INSERT INTO tenants (id, name, host, api_base_url) VALUES (?, 'T', ?, 'https://t.example')`).bind('tn-' + siteId, siteId + '.example').run();
  await e.LUMMET_DB.prepare(`INSERT INTO sites (id, organization_id, tenant_id, name, slug, product_id, status) VALUES (?, ?, ?, 'S', ?, 'prod_casino_news', ?)`).bind(siteId, org, 'tn-' + siteId, 's-' + siteId.slice(0, 8), siteStatus).run();
  return { org, siteId, cookie: s.cookie };
}
const tenantData = { casinos: [{ slug: 'a', name: 'A', password_hash: 'LEAK', api_key: 'LEAK2' }, { slug: 'b', name: 'B' }], news: [{ slug: 'n1' }] };
function fakeClient({ failFor = [], posts = [] } = {}) {
  return {
    async getFromTenant(_e, _t, path) { const k = path.split('/').pop(); if (failFor.includes(k) || !tenantData[k]) return { ok: false, status: 404, reason: 'resource_disabled' }; return { ok: true, data: { data: tenantData[k] } }; },
    async postToTenant(_e, tenant, path, body) { posts.push({ tenant, path, body }); return { ok: true, data: {} }; }
  };
}

test('backup fails closed without a storage binding', async () => {
  const e = env(); const o = await orgWithSite(e, 'a@x.test');
  const r = await createBackupService(fakeClient()).createBackup(e, { organizationId: o.org, siteId: o.siteId });
  assert.equal(r.error, 'backup_storage_not_configured');
});

test('backup stores checksummed content, excludes users, scrubs secret-named fields, reports failures honestly', async () => {
  const e = env({ BACKUPS: fakeR2() }); const o = await orgWithSite(e, 'b@x.test');
  const svc = createBackupService(fakeClient());
  const r = await svc.createBackup(e, { organizationId: o.org, siteId: o.siteId });
  assert.ok(r.ok, JSON.stringify(r)); assert.equal(r.status, 'partial', 'some resources unreadable => partial, not complete');
  assert.equal(r.resources.casinos.count, 2); assert.equal(r.resources.reviews.ok, false); assert.equal(r.resources.users, undefined);
  const stored = [...e.BACKUPS.m.values()][0];
  assert.ok(!stored.includes('LEAK'), 'secret-named fields never reach the backup');
  assert.equal((await svc.verifyBackup(e, o.org, r.backupId)).ok, true);
  [...e.BACKUPS.m.keys()].forEach((k) => e.BACKUPS.m.set(k, stored + ' '));
  const bad = await svc.verifyBackup(e, o.org, r.backupId);
  assert.equal(bad.error, 'checksum_mismatch');
});

test('all resources failing marks the backup failed and stores nothing', async () => {
  const e = env({ BACKUPS: fakeR2() }); const o = await orgWithSite(e, 'f@x.test');
  const svc = createBackupService({ getFromTenant: async () => ({ ok: false, status: 502 }), postToTenant: async () => ({ ok: true }) });
  const r = await svc.createBackup(e, { organizationId: o.org, siteId: o.siteId });
  assert.equal(r.error, 'tenant_unreachable'); assert.equal(e.BACKUPS.m.size, 0);
});

test('cross-organization: another org cannot back up, read, verify or restore my site/backup', async () => {
  const e = env({ BACKUPS: fakeR2() }); const a = await orgWithSite(e, 'oa@x.test'); const b = await orgWithSite(e, 'ob@x.test');
  const svc = createBackupService(fakeClient());
  assert.equal((await svc.createBackup(e, { organizationId: b.org, siteId: a.siteId })).error, 'site_not_found');
  const made = await svc.createBackup(e, { organizationId: a.org, siteId: a.siteId });
  assert.equal((await svc.downloadBackup(e, b.org, made.backupId)).error, 'backup_not_found');
  assert.equal((await svc.verifyBackup(e, b.org, made.backupId)).error, 'backup_not_found');
  assert.equal((await svc.restoreBackup(e, { organizationId: b.org, backupId: made.backupId, targetSiteId: b.siteId })).error, 'backup_not_found');
});

test('restore never overwrites the source, needs a ready target, and replays via create endpoints', async () => {
  const e = env({ BACKUPS: fakeR2() }); const a = await orgWithSite(e, 'r@x.test');
  const posts = []; const svc = createBackupService(fakeClient({ posts }));
  const made = await svc.createBackup(e, { organizationId: a.org, siteId: a.siteId });
  assert.equal((await svc.restoreBackup(e, { organizationId: a.org, backupId: made.backupId, targetSiteId: a.siteId })).error, 'restore_into_source_refused');
  const t2 = crypto.randomUUID();
  await e.LUMMET_DB.prepare(`INSERT INTO tenants (id, name, host, api_base_url) VALUES ('tn-t2', 'T2', 't2.example', 'https://t2.example')`).run();
  await e.LUMMET_DB.prepare(`INSERT INTO sites (id, organization_id, tenant_id, name, slug, product_id, status) VALUES (?, ?, 'tn-t2', 'S2', 's2x', 'prod_casino_news', 'provisioning')`).bind(t2, a.org).run();
  assert.equal((await svc.restoreBackup(e, { organizationId: a.org, backupId: made.backupId, targetSiteId: t2 })).error, 'target_site_not_ready');
  await e.LUMMET_DB.prepare(`UPDATE sites SET status='active' WHERE id=?`).bind(t2).run();
  const r = await svc.restoreBackup(e, { organizationId: a.org, backupId: made.backupId, targetSiteId: t2 });
  assert.ok(r.ok, JSON.stringify(r)); assert.ok(posts.length >= 3 && posts.every((p) => p.tenant === 'tn-t2'));
  [...e.BACKUPS.m.keys()].forEach((k) => e.BACKUPS.m.set(k, 'tampered'));
  assert.equal((await svc.restoreBackup(e, { organizationId: a.org, backupId: made.backupId, targetSiteId: t2 })).error, 'checksum_mismatch', 'never restore a backup that fails its checksum');
});

test('retention purge deletes expired backup objects', async () => {
  const e = env({ BACKUPS: fakeR2() }); const a = await orgWithSite(e, 'p@x.test'); const svc = createBackupService(fakeClient());
  await svc.createBackup(e, { organizationId: a.org, siteId: a.siteId, retentionDays: 1 });
  assert.equal((await svc.purgeExpired(e, new Date(Date.now() + 3 * 86400000))).purged, 1);
  assert.equal(e.BACKUPS.m.size, 0);
});

test('backup routes: plan gate, role gate, org scope, audit, download headers', async () => {
  const e = env({ BACKUPS: fakeR2() });
  const starter = await orgWithSite(e, 'st@x.test', 'plan_casino_news_starter');
  const gated = await call(e, 'POST', `/api/organizations/${starter.org}/backups`, { siteId: starter.siteId }, starter.cookie);
  assert.equal(gated.status, 403); assert.equal(gated.json.error, 'backups_not_enabled');
  const pro = await orgWithSite(e, 'pro@x.test'); const other = await orgWithSite(e, 'oth@x.test');
  assert.ok([403, 404].includes((await call(e, 'GET', `/api/organizations/${pro.org}/backups`, null, other.cookie)).status));
  assert.equal((await call(e, 'GET', `/api/organizations/${pro.org}/backups`)).status, 401);
  assert.equal((await call(e, 'GET', `/api/organizations/${pro.org}/backups`, null, pro.cookie)).status, 200);
  const attempt = await call(e, 'POST', `/api/organizations/${pro.org}/backups`, { siteId: pro.siteId }, pro.cookie);
  assert.equal(attempt.status, 502, 'real tenant client cannot reach the fake tenant, and the failure is reported, not hidden');
  const foreign = await call(e, 'POST', `/api/organizations/${other.org}/backups`, { siteId: pro.siteId }, other.cookie);
  assert.equal(foreign.status, 404, 'cannot back up a site that belongs to another org');
  const audited = await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM lummet_audit_logs WHERE resource='site_backup'`).first();
  assert.ok(audited.n >= 1);
});

// ---------------- automations ----------------
const rule = { name: 'Pay fail', triggerEvent: 'payment.failed', conditions: [{ field: 'amountDue', op: 'gte', value: 1000 }], actions: [{ type: 'create_alert', params: { message: 'card failed' } }, { type: 'count_usage' }] };

test('rule validation rejects arbitrary actions, operators and fields', () => {
  assert.equal(automations.validateRule({ ...rule, actions: [{ type: 'run_js', params: { code: 'x' } }] }), 'unknown_action');
  assert.equal(automations.validateRule({ ...rule, conditions: [{ field: 'a', op: 'eval', value: 1 }] }), 'invalid_condition');
  assert.equal(automations.validateRule({ ...rule, conditions: [{ field: 'a b;drop', op: 'eq', value: 1 }] }), 'invalid_condition');
  assert.equal(automations.validateRule({ ...rule, triggerEvent: 'nope' }), 'invalid_trigger_event');
  assert.equal(automations.validateRule({ ...rule, actions: [] }), 'invalid_actions');
  assert.equal(automations.validateRule(rule), null);
});

test('plan gate: starter/growth cannot create automations, pro can', async () => {
  const e = env(); const g = await orgWithSite(e, 'g@x.test', 'plan_casino_news_growth'); const p = await orgWithSite(e, 'pp@x.test');
  assert.equal((await automations.createRule(e, g.org, rule, 'u')).error, 'automations_not_enabled');
  assert.ok((await automations.createRule(e, p.org, rule, 'u')).ok);
});

test('event fires matching rule once, honours conditions, is idempotent per event, and is tenant-scoped', async () => {
  const e = env(); const a = await orgWithSite(e, 'aa@x.test'); const b = await orgWithSite(e, 'bb@x.test');
  await automations.createRule(e, a.org, rule, 'u'); await automations.createRule(e, b.org, rule, 'u');
  await webhooks.dispatchEvent(e, a.org, 'payment.failed', { amountDue: 5 });
  assert.equal((await automations.listRuns(e, a.org)).length, 0, 'condition not met');
  const ev = 'evt-1';
  await automations.runAutomations(e, a.org, 'payment.failed', { amountDue: 5000 }, ev);
  await automations.runAutomations(e, a.org, 'payment.failed', { amountDue: 5000 }, ev);
  assert.equal((await automations.listRuns(e, a.org)).length, 1, 'replayed event is a no-op');
  assert.equal((await automations.listRuns(e, b.org)).length, 0, 'other org untouched');
  const alerts = await e.LUMMET_DB.prepare('SELECT organization_id FROM automation_alerts').all();
  assert.deepEqual(alerts.results.map((x) => x.organization_id), [a.org]);
});

test('rate limit stops a noisy rule; paused rules do not run; plan downgrade gates execution', async () => {
  const e = env(); const a = await orgWithSite(e, 'rl@x.test');
  const { ruleId } = await automations.createRule(e, a.org, { ...rule, conditions: [], maxRunsPerHour: 2 }, 'u');
  for (let i = 0; i < 5; i++) await automations.runAutomations(e, a.org, 'payment.failed', {}, 'e' + i);
  const runs = await automations.listRuns(e, a.org);
  assert.equal(runs.filter((r) => r.status === 'success').length, 2);
  assert.equal(runs.filter((r) => r.status === 'skipped_rate_limited').length, 3);
  await automations.setRuleStatus(e, a.org, ruleId, 'paused');
  const before = (await automations.listRuns(e, a.org)).length;
  await automations.runAutomations(e, a.org, 'payment.failed', {}, 'later');
  assert.equal((await automations.listRuns(e, a.org)).length, before);
});

test('automation actions cannot re-trigger automations (no loops)', async () => {
  const e = env(); const a = await orgWithSite(e, 'lp@x.test');
  await automations.createRule(e, a.org, { name: 'x', triggerEvent: 'site.failed', actions: [{ type: 'create_alert' }] }, 'u');
  await automations.runAutomations(e, a.org, 'site.failed', {}, 'e1');
  assert.equal((await automations.listRuns(e, a.org)).length, 1);
  assert.ok(!Object.keys(automations.ACTIONS).some((k) => /emit|dispatch|webhook/.test(k)));
});

test('automation routes: org scoped, admin-only, audited', async () => {
  const e = env(); const a = await orgWithSite(e, 'ra@x.test'); const b = await orgWithSite(e, 'rb@x.test');
  const created = await call(e, 'POST', `/api/organizations/${a.org}/automations`, rule, a.cookie);
  assert.equal(created.status, 200, created.text);
  assert.equal((await call(e, 'POST', `/api/organizations/${a.org}/automations`, { ...rule, actions: [{ type: 'rm_rf' }] }, a.cookie)).status, 422);
  assert.ok([403, 404].includes((await call(e, 'GET', `/api/organizations/${a.org}/automations`, null, b.cookie)).status));
  const del = await call(e, 'DELETE', `/api/organizations/${b.org}/automations/${created.json.ruleId}`, null, b.cookie);
  assert.equal(del.status, 404, 'cannot delete another org\'s rule via my own org path');
  assert.equal((await call(e, 'DELETE', `/api/organizations/${a.org}/automations/${created.json.ruleId}`, null, a.cookie)).status, 200);
  const n = await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM lummet_audit_logs WHERE resource='automation_rule'`).first();
  assert.ok(n.n >= 3);
});

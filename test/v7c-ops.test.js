// v7C: configuration check, inquiries erasure, customer-portal nav links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { configIssues } from '../worker/config-check.js';
import { runAlertCheck } from '../worker/alerts.js';
import { renderSaasOverview } from '../worker/views/pages/saas-admin.js';
import * as erasure from '../worker/erasure.js';
import * as customerAuth from '../worker/customer-auth.js';

const mk = (extra = {}) => { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ...extra }; };
const HOOK = 'https://hooks.example.com/services/T/B/x';
const recorder = () => { const calls = []; const f = async (u, i) => { calls.push({ url: String(u), body: i && i.body ? JSON.parse(i.body) : null }); return { ok: true, status: 200 }; }; f.calls = calls; return f; };
const sup = (env, email, org = 'Org') => customerAuth.signUp({ async json() { return { email, password: 'correct-horse-battery', organizationName: org }; }, headers: { get: () => '203.0.113.9' } }, env);

test('configIssues: nothing outside production; names and impacts (never values) inside it', () => {
  assert.deepEqual(configIssues({}), []);
  assert.deepEqual(configIssues({ ENVIRONMENT: 'staging' }), []);
  const issues = configIssues({ ENVIRONMENT: 'production', PORTAL_BASE_URL: '', STRIPE_SECRET_KEY: 'sk_live_SECRETVALUE' });
  const keys = issues.map((i) => i.key);
  assert.ok(keys.includes('PORTAL_BASE_URL') && keys.includes('CREDENTIAL_KEK') && keys.includes('CF_ZONE_ID'));
  assert.ok(!keys.includes('STRIPE_SECRET_KEY'), 'a set value is not reported');
  assert.equal(JSON.stringify(issues).includes('SECRETVALUE'), false);
  assert.match(issues.find((i) => i.key === 'PORTAL_BASE_URL').impact, /emails/);
  assert.ok(configIssues({ ENVIRONMENT: 'production', PORTAL_BASE_URL: 'not-a-url' }).some((i) => i.key === 'PORTAL_BASE_URL'), 'must be http(s)');
});

test('an incomplete production configuration raises an alert naming what is missing, and resolves when fixed', async () => {
  const e = mk({ ENVIRONMENT: 'production', ALERT_WEBHOOK_URL: HOOK, PORTAL_BASE_URL: '' }); const f = recorder();
  const r = await runAlertCheck(e, { fetchImpl: f });
  assert.equal(r.results.find((x) => x.key === 'config_incomplete').action, 'notified');
  const text = f.calls[0].body.text;
  assert.match(text, /Production configuration is incomplete/);
  assert.match(text, /Missing: .*PORTAL_BASE_URL/);
  // Fix everything.
  Object.assign(e, { PORTAL_BASE_URL: 'https://app.example.com', STRIPE_SECRET_KEY: 'x', STRIPE_WEBHOOK_SECRET: 'x', CF_API_TOKEN: 'x', CF_ACCOUNT_ID: 'x', CF_ZONE_ID: 'x',
    EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'x', EMAIL_FROM: 'a@example.com', ALERT_CHECK_TOKEN: 'tick', WEBAUTHN_RP_ID: 'a', WEBAUTHN_ORIGIN: 'https://a', CSP_MODE: 'enforce' });
  assert.equal((await runAlertCheck(e, { fetchImpl: f })).results.find((x) => x.key === 'config_incomplete').action, 'resolved');
});

test('staging never raises the configuration alert', async () => {
  const e = mk({ ENVIRONMENT: 'staging', ALERT_WEBHOOK_URL: HOOK });
  assert.equal((await runAlertCheck(e, { fetchImpl: recorder() })).results.find((x) => x.key === 'config_incomplete').action, 'ok');
});

test('the staff SaaS overview shows a banner for missing production settings, and none when complete or not production', async () => {
  const admin = { id: 1, email: 'a@b.c', role: 'super_admin' };
  const bad = await renderSaasOverview(mk({ ENVIRONMENT: 'production', PORTAL_BASE_URL: '' }), admin);
  assert.match(bad, /Production configuration is incomplete/);
  assert.match(bad, /<code>PORTAL_BASE_URL<\/code>/);
  const fine = await renderSaasOverview(mk({ ENVIRONMENT: 'staging' }), admin);
  assert.equal(fine.includes('Production configuration is incomplete'), false);
});

test('erasing a person also deletes the public contact/demo inquiries sent with their email address', async () => {
  const e = mk(); const a = await sup(e, 'alice@example.com'); const db = e.LUMMET_DB;
  const add = (email) => db.prepare(`INSERT INTO lummet_inquiries (form_key, name, email, summary) VALUES ('contact', 'N', ?, 's')`).bind(email).run();
  await add('Alice@Example.com'); await add('alice@example.com'); await add('someone-else@example.com');
  const r = await erasure.eraseUser(e, a.userId);
  assert.equal(r.ok, true);
  const left = (await db.prepare(`SELECT email FROM lummet_inquiries`).all()).results.map((x) => x.email);
  assert.deepEqual(left, ['someone-else@example.com']);
});

test('erasing an organization deletes inquiries sent with its billing email', async () => {
  const e = mk(); const a = await sup(e, 'owner@example.com'); const db = e.LUMMET_DB;
  await db.prepare(`UPDATE organizations SET billing_email = 'billing@acme.example', scheduled_deletion_at = '2000-01-01T00:00:00.000Z', status = 'closed' WHERE id = ?`).bind(a.organizationId).run();
  await db.prepare(`INSERT INTO lummet_inquiries (form_key, email, summary) VALUES ('demo', 'BILLING@acme.example', 's'), ('demo', 'keep@example.com', 's')`).run();
  const r = await erasure.eraseOrganization(e, a.organizationId, { infra: (await import('./support/fake-infra-provider.js')).createFakeInfraProvider() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual((await db.prepare(`SELECT email FROM lummet_inquiries`).all()).results.map((x) => x.email), ['keep@example.com']);
});

test('the public header and footer link to the customer portal sign-in, and the migration is idempotent', async () => {
  const e = mk(); const db = e.LUMMET_DB;
  const links = (await db.prepare(`SELECT placement, href, visible_when, status FROM lummet_nav_links WHERE href = '/app/login' ORDER BY placement`).all()).results;
  assert.deepEqual(links.map((l) => l.placement), ['footer_platform', 'header_cta']);
  assert.ok(links.every((l) => l.visible_when === 'always' && l.status === 'published'));
  // An edit by staff survives a re-run.
  await db.prepare(`UPDATE lummet_nav_links SET label = 'Customer sign in', status = 'draft' WHERE placement = 'header_cta' AND href = '/app/login'`).run();
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../migrations/0039_customer_portal_nav_links.sql', import.meta.url), 'utf8');
  const { splitSqlStatements } = await import('./support/d1-shim.js');
  for (const stmt of splitSqlStatements(sql)) await db.prepare(stmt).run();
  assert.equal((await db.prepare(`SELECT status FROM lummet_nav_links WHERE placement = 'header_cta' AND href = '/app/login'`).first()).status, 'draft');
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM lummet_nav_links WHERE href = '/app/login'`).first()).n, 2);
});

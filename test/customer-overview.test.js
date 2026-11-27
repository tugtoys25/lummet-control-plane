// The customer Overview: site health, usage bars, needs-your-attention, billing summary, activity, checklist progress, scoping, resilience.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { renderOverviewPage } from '../worker/views/customer-pages/overview.js';
import { loadCustomerOverview, customerAttention } from '../worker/customer-overview.js';

const usage = { sites: { used: 2, limit: 2 }, users: { used: 1, limit: 10 }, customDomains: { used: 1, limit: 3 } };
const sites = [
  { id: 's1', name: 'Kigali Daily', product_name: 'News', status: 'active', primary_domain: 'k.test' },
  { id: 's2', name: 'Lagos Review', product_name: 'News', status: 'failed', primary_domain: null }
];

async function env() {
  const db = createTestDb(); applyMigrations(db);
  await db.prepare('PRAGMA foreign_keys = OFF').run();
  const run = (s, ...b) => db.prepare(s).bind(...b).run();
  await run(`INSERT INTO tenants (id,name,host,api_base_url,status) VALUES ('t1','K','k.test','https://k.test','active')`);
  await run(`INSERT INTO tenant_health (tenant_id,status) VALUES ('t1','Unavailable')`);
  await run(`INSERT INTO organizations (id,name,slug) VALUES ('o1','Acme','acme'),('o2','Other','other')`);
  await run(`INSERT INTO sites (id,organization_id,tenant_id,name,slug,product_id,status) VALUES ('s1','o1','t1','Kigali Daily','kd','p','active'),('s2','o1',NULL,'Lagos Review','lr','p','failed'),('sx','o2',NULL,'Other site','os','p','active')`);
  await run(`INSERT INTO deployments (id,site_id,version,status,created_at) VALUES ('d1','s1','2026.11.1','active','2026-11-20 10:00:00'),('d2','s1','2026.11.2','failed','2026-11-25 10:00:00'),('dx','sx','9.9.9','active','2026-11-26 10:00:00')`);
  await run(`INSERT INTO domains (id,site_id,hostname,verification_token,status,created_at) VALUES ('dm1','s1','www.k.test','v1','pending','2026-11-21 10:00:00'),('dm2','sx','other.test','v2','failed','2026-11-21 10:00:00')`);
  await run(`INSERT INTO payments (id,organization_id,provider,provider_payment_id,status,amount_cents,currency) VALUES ('p1','o1','x','a','failed',500,'usd')`);
  await run(`INSERT INTO invoices (id,organization_id,provider,provider_invoice_id,status,amount_due_cents,amount_paid_cents,total_cents,currency) VALUES ('i1','o1','x','a','open',2500,0,2500,'usd')`);
  await run(`INSERT INTO lummet_audit_logs (admin_id,organization_id,endpoint,method,resource,action,success,actor_type) VALUES (NULL,'o1','/x','POST','domain','add_domain',1,'customer'),(NULL,'o2','/x','POST','site','create',1,'customer')`);
  return { LUMMET_DB: db };
}
const sub = { status: 'past_due', current_period_end: '2026-12-01 00:00:00', plan_id: 'p', grace_ends_at: '2026-11-30 00:00:00' };

test('loads only this organization, with health, last deploy, domain issues, billing and activity', async () => {
  const e = await env();
  const x = await loadCustomerOverview(e, { organizationId: 'o1', sites, subscription: sub, canManage: true });
  assert.equal(x.siteRows.find((r) => r.id === 's1').health, 'Unavailable');
  assert.equal(x.siteRows.find((r) => r.id === 's1').deploy.version, '2026.11.2');
  assert.deepEqual(x.domains.map((d) => d.hostname), ['www.k.test']);
  assert.equal(x.billing.failed30, 1); assert.equal(x.billing.invoice.status, 'open');
  assert.ok(x.activity.some((a) => /add domain/.test(a.text)) && !x.activity.some((a) => /9\.9\.9|create site/.test(a.text)));
});

test('a member who cannot manage billing gets no billing data', async () => {
  const x = await loadCustomerOverview(await env(), { organizationId: 'o1', sites, subscription: sub, canManage: false });
  assert.equal(x.billing, null);
  const html = renderOverviewPage({ organization: { name: 'Acme' }, subscription: sub, plan: { name: 'Pro' }, usage, sites, extra: x, attention: [], canManage: false });
  assert.ok(!html.includes('Payment method') && html.includes('Recent activity'));
});

test('attention list: urgent before checks, covers payment, failed site, down site, domain, limits', async () => {
  const e = await env();
  const extra = await loadCustomerOverview(e, { organizationId: 'o1', sites, subscription: sub, canManage: true });
  const items = customerAttention({ sites, subscription: sub, usage, extra, twoFactorMissing: false, canManage: true });
  const titles = items.map((i) => i.title).join('|');
  for (const t of ['payment did not go through', 'Lagos Review failed to set up', 'Kigali Daily is not responding', 'www.k.test is not connected yet', 'used all your sites']) assert.ok(titles.includes(t), t);
  const levels = items.map((i) => i.level); assert.deepEqual(levels, [...levels].sort((a, b) => (a === 'danger' ? 0 : 1) - (b === 'danger' ? 0 : 1)));
});

test('page: attention panel, usage bars, health and last update columns, billing card, activity', async () => {
  const e = await env();
  const extra = await loadCustomerOverview(e, { organizationId: 'o1', sites, subscription: sub, canManage: true });
  const attention = customerAttention({ sites, subscription: sub, usage, extra, canManage: true });
  const html = renderOverviewPage({ organization: { name: 'Acme' }, subscription: sub, plan: { name: 'Pro' }, usage, sites, extra, attention, canManage: true });
  for (const need of ['Needs your attention', 'usage-bar is-full', '<th>Health</th>', '<th>Last update</th>', 'Unavailable', 'Payment method', 'None saved', 'Latest invoice', 'Recent activity', 'Kigali Daily']) assert.ok(html.includes(need), need);
  assert.ok(!html.includes('<script'));
});

test('old callers (no extra) still get the original page; new customers see checklist progress, not an All clear panel', () => {
  const base = { organization: { name: 'Acme' }, subscription: { status: 'active' }, plan: { name: 'Pro' }, usage: { sites: { used: 0, limit: 1 }, users: { used: 2, limit: 3 }, customDomains: { used: 0, limit: 0 } }, sites: [] };
  const html = renderOverviewPage(base);
  assert.ok(!html.includes('<th>Health</th>') && html.includes('getting-started-guide'));
  const fresh = renderOverviewPage({ ...base, extra: { siteRows: [], domains: [], activity: [], billing: null }, attention: [] });
  assert.ok(fresh.includes('2 of 5 done') && fresh.includes('is-done') && !fresh.includes('All clear'));
});

test('a failing query hides only its block', async () => {
  const e = await env();
  await e.LUMMET_DB.prepare('DROP TABLE domains').run();
  const x = await loadCustomerOverview(e, { organizationId: 'o1', sites, subscription: sub, canManage: true });
  assert.deepEqual(x.domains, []); assert.equal(x.billing.invoice.status, 'open');
});

// The staff Overview as an operations summary: needs-attention list, releases, billing, incidents, trends, scoping, resilience.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { renderDashboardHome } from '../worker/views/pages/dashboard.js';
import { loadOpsSummary, attentionItems } from '../worker/ops-summary.js';

const SUPER = { id: 1, email: 'root@lummet.test', role: 'super_admin' };
const SCOPED = { id: 2, email: 'ed@lummet.test', role: 'admin' };

async function env() {
  const db = createTestDb(); applyMigrations(db);
  await db.prepare('PRAGMA foreign_keys = OFF').run();
  const run = (sql, ...b) => db.prepare(sql).bind(...b).run();
  await run(`INSERT INTO tenants (id,name,host,api_base_url,status) VALUES ('t1','Kigali Daily','k.test','https://k.test','active'),('t2','Lagos Review','l.test','https://l.test','active')`);
  await run(`INSERT INTO tenant_health (tenant_id,status,last_checked_at,last_error) VALUES ('t1','Online','2026-11-27 08:00:00',NULL),('t2','Unavailable','2026-11-27 08:00:00','connect timeout')`);
  await run(`INSERT INTO lummet_admin_tenant_access (admin_id,tenant_id) VALUES (2,'t1')`);
  await run(`INSERT INTO organizations (id,name,slug) VALUES ('o1','Acme Media','acme'),('o2','Beta Betting','beta')`);
  await run(`INSERT INTO subscriptions (id,organization_id,plan_id,status) VALUES ('s1','o1','p','past_due'),('s2','o2','p','restricted'),('s3','o1','p','active')`);
  await run(`INSERT INTO payments (id,organization_id,provider,provider_payment_id,status,amount_cents,currency,created_at) VALUES ('pay1','o1','x','pp1','failed',500,'usd',datetime('now'))`);
  await run(`INSERT INTO invoices (id,organization_id,provider,provider_invoice_id,status,amount_due_cents,amount_paid_cents,currency,due_at) VALUES ('i1','o1','x','pi1','open',2500,0,'usd',datetime('now','-3 days'))`);
  await run(`INSERT INTO alert_state (key,firing,last_count,first_seen_at,updated_at) VALUES ('failed_sites',1,2,datetime('now'),datetime('now')),('past_due',0,0,datetime('now'),datetime('now'))`);
  await run(`INSERT INTO tenant_template_releases (id,version,storage_key,size_bytes,sha256,status,template_line) VALUES ('r1','2026.11.26.7','k',1,'h','active','casino')`);
  await run(`INSERT INTO lummet_audit_logs (admin_id,tenant_id,endpoint,method,resource,action,success,created_at) VALUES (1,'t1','/x','POST','tenant','update',0,datetime('now')),(1,'t2','/x','POST','tenant','update',1,datetime('now'))`);
  return { LUMMET_DB: db };
}

test('super admin sees attention, release, billing, incidents and the original tenant and activity tables', async () => {
  const e = await env();
  const html = await renderDashboardHome(e, SUPER);
  for (const need of ['Needs attention', 'Lagos Review is unavailable', 'Releases and rollout', 'Billing', 'Incidents', 'Sites in a failed state', 'Acme Media', 'Beta Betting', 'Failed payments, 7 days', 'Recent activity', 'Registered tenants', 'Kigali Daily']) assert.ok(html.includes(need), need);
  assert.ok(html.includes('<svg class="ops-spark'));
  assert.ok(html.indexOf('Needs attention') < html.indexOf('Releases and rollout') && html.indexOf('Releases and rollout') < html.indexOf('Recent activity'));
});

test('urgent items come before warnings', async () => {
  const e = await env();
  const items = attentionItems(await loadOpsSummary(e, SUPER));
  assert.ok(items.length >= 4);
  const levels = items.map((i) => i.level); assert.deepEqual(levels, [...levels].sort((a, b) => (a === 'danger' ? 0 : 1) - (b === 'danger' ? 0 : 1)));
  assert.ok(items.some((i) => /restricted or suspended/.test(i.title)) && items.some((i) => /past due/.test(i.title)));
});

test('a scoped admin sees only their tenants and no platform billing, releases or incidents', async () => {
  const e = await env();
  const html = await renderDashboardHome(e, SCOPED);
  assert.ok(html.includes('Kigali Daily') && !html.includes('Lagos Review') && !html.includes('Acme Media'));
  assert.ok(!html.includes('Releases and rollout') && !html.includes('Failed payments') && !html.includes('Sites in a failed state'));
  assert.ok(html.includes('All clear'));
});

test('a broken block hides itself only; the page still renders', async () => {
  const e = await env();
  await e.LUMMET_DB.prepare('DROP TABLE payments').run();
  const html = await renderDashboardHome(e, SUPER);
  assert.ok(html.includes('Billing data is not available') && html.includes('Releases and rollout') && html.includes('Kigali Daily'));
});

test('empty system renders all clear and the empty tenant message', async () => {
  const db = createTestDb(); applyMigrations(db);
  const html = await renderDashboardHome({ LUMMET_DB: db }, SUPER);
  assert.ok(html.includes('All clear') && html.includes('No tenants registered yet') && html.includes('No activity yet'));
});

// The Content tab: casino sites keep the dashboard password form; brokerage sites point to Admin setup on the Deployments tab instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderInsightContent } from '../worker/views/customer-pages/insights.js';

const live = (extra) => ({ tenant_id: 't', status: 'active', primary_domain: 'x.lummet.app', ...extra });

test('a brokerage site shows guidance and a button to Deployments, and no password field', () => {
  const html = renderInsightContent({ sites: [live({ id: 'b', name: 'Sales', template_line: 'brokerage', primary_domain: 'sales.lummet.app' })], email: 'a@b.c', canManage: true });
  assert.ok(html.includes('href="/app/deployments"') && html.includes('Go to Deployments'));
  assert.ok(html.includes('Admin setup') && html.includes('brokerage site'));
  assert.ok(!html.includes('type="password"'), 'no password field for a brokerage site');
  assert.ok(!html.includes('Set dashboard password'));
  assert.ok(html.includes('https://sales.lummet.app/admin/login'), 'links to the brokerage admin, not the casino /en/dashboard');
  assert.ok(!html.includes('/en/dashboard'));
});

test('a casino site is unchanged: dashboard link and the password form', () => {
  const html = renderInsightContent({ sites: [live({ id: 'c', name: 'Reviews', template_line: 'casino', primary_domain: 'reviews.lummet.app' })], email: 'a@b.c', canManage: true });
  assert.ok(html.includes('type="password"') && html.includes('Set dashboard password'));
  assert.ok(html.includes('https://reviews.lummet.app/en/dashboard'));
  assert.ok(!html.includes('Go to Deployments'));
  const noLine = renderInsightContent({ sites: [live({ id: 'n', name: 'Old', primary_domain: 'old.lummet.app' })], email: 'a@b.c', canManage: true });
  assert.ok(noLine.includes('type="password"'), 'a site with no template line is a casino site');
});

test('a mixed list renders each site by its own line; non-admins see no button and no form; not-live brokerage sites show neither', () => {
  const sites = [live({ id: 'c', name: 'Reviews', template_line: 'casino' }), live({ id: 'b', name: 'Sales', template_line: 'brokerage' }), { id: 'p', name: 'Pending', status: 'pending', template_line: 'brokerage' }];
  const admin = renderInsightContent({ sites, email: 'a@b.c', canManage: true });
  assert.equal((admin.match(/type="password"/g) || []).length, 1);
  assert.equal((admin.match(/Go to Deployments/g) || []).length, 1, 'only the live brokerage site');
  assert.ok(admin.includes('Brokerage sites are set up from the Deployments tab instead.'));
  const member = renderInsightContent({ sites, email: 'a@b.c', canManage: false });
  assert.ok(!member.includes('type="password"') && !member.includes('Go to Deployments'));
  assert.ok(member.includes('Ask an organization admin'));
});

import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';
import { createTenantAdminService } from '../worker/tenant-admin.js';

test('the service refuses to set a dashboard password on a brokerage site, and touches nothing', async () => {
  const db = createTestDb(); applyMigrations(db);
  const env = { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)) };
  await db.prepare(`INSERT INTO organizations (id, name, slug) VALUES ('o1', 'Org', 'org-1')`).run();
  await db.prepare(`INSERT INTO tenants (id, name, host, api_base_url) VALUES ('t1', 'T', 't1.x.test', 'https://t1.x.test')`).run();
  for (const [id, product] of [['s-b', 'prod_brokerage_site'], ['s-c', 'prod_casino_news']]) {
    await db.prepare(`INSERT INTO sites (id, organization_id, name, slug, host_label, product_id, status, tenant_id) VALUES (?, 'o1', ?, ?, ?, ?, 'active', 't1')`).bind(id, id, id, id, product).run();
    await db.prepare(`INSERT INTO site_resources (site_id, provider, resource_type, resource_id, resource_name) VALUES (?, 'cloudflare', 'd1', 'db-1', 'tenant-db')`).bind(id).run();
  }
  const infra = createFakeInfraProvider();
  const svc = createTenantAdminService(infra);
  const args = { organizationId: 'o1', email: 'a@b.co', password: 'correct-horse-battery-staple' };
  const refused = await svc.setDashboardPassword(env, { ...args, siteId: 's-b' });
  assert.equal(refused.ok, false); assert.equal(refused.status, 409); assert.equal(refused.error, 'use_admin_setup');
  assert.equal(infra._calls.filter((c) => c.method === 'runD1Query').length, 0, 'nothing was written to the brokerage database');
  const casino = await svc.setDashboardPassword(env, { ...args, siteId: 's-c' });
  assert.equal(casino.ok, true, 'a casino site is unchanged');
});

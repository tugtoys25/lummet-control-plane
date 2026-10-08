// test/tenant-portal.test.js
//
// Covers worker/tenant-portal.js against a real SQLite schema (D1
// shim) and a fake tenant client standing in for client.js's real
// requestTenant() -- no network needed. Confirms the two gates
// (entitlement, then deployment) both actually block a call, and
// that the exact REAL tenant Super API paths (confirmed against
// lummet-tenant/en/worker/super/router.js) are what gets requested.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeTenantClient } from './support/fake-tenant-client.js';

import { createTenantPortalService } from '../worker/tenant-portal.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';

function makeEnv() {
  const db = createTestDb();
  applyMigrations(db);
  return { LUMMET_DB: db };
}

function fakeSignupRequest(email) {
  return {
    async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org' }; },
    headers: { get: () => '203.0.113.40' }
  };
}

async function setUpSite(env, email, { withTenant = false, planEntitlementOverrides = {}, skipSubscription = false } = {}) {
  const signup = await customerAuth.signUp(fakeSignupRequest(email), env);
  if (!skipSubscription) {
    await plans.startTrialSubscription(env, signup.organizationId, 'plan_casino_news_starter');
  }

  for (const [key, value] of Object.entries(planEntitlementOverrides)) {
    await env.LUMMET_DB.prepare(
      `INSERT INTO plan_entitlements (plan_id, key, value_type, value) VALUES ('plan_casino_news_starter', ?, 'boolean', ?)
       ON CONFLICT(plan_id, key) DO UPDATE SET value = excluded.value`
    ).bind(key, value ? 'true' : 'false').run();
  }

  const site = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });

  if (withTenant) {
    // A real tenant_id is only needed to pass tenant-portal.js's
    // "is this site deployed" check -- the fake client never
    // actually looks up the tenants row itself, but sites.tenant_id
    // has a real FK to tenants(id), so a minimal real row is needed
    // to satisfy the schema.
    const tenantId = `tenant-fake-${site.siteId}`;
    await env.LUMMET_DB.prepare(
      `INSERT INTO tenants (id, name, host, api_base_url) VALUES (?, 'Fake Tenant', ?, ?)`
    ).bind(tenantId, `${tenantId}.example.test`, `https://${tenantId}.example.test`).run();
    await env.LUMMET_DB.prepare(`UPDATE sites SET tenant_id = ? WHERE id = ?`).bind(tenantId, site.siteId).run();
  }

  const siteRow = await sites.getSite(env, site.siteId);
  return { signup, siteRow };
}

// -----------------------------------------------------
// Entitlement gate
// -----------------------------------------------------

test('analytics endpoints refuse an organization with analytics.level = none, without calling the tenant', async () => {
  const env = makeEnv();
  const client = createFakeTenantClient();
  const portal = createTenantPortalService(client);
  const { siteRow } = await setUpSite(env, 'no-analytics@example.com', { withTenant: true, skipSubscription: true });

  const result = await portal.getAnalyticsOverview(env, siteRow, { startDate: '2026-01-01', endDate: '2026-01-31' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_entitled');
  assert.equal(client._calls.length, 0, 'an unentitled org must never reach the tenant');
});

test('analytics endpoints succeed once analytics.level is not none, and hit the real Super API path with the right query params', async () => {
  const env = makeEnv();
  const client = createFakeTenantClient();
  const portal = createTenantPortalService(client);
  const { siteRow } = await setUpSite(env, 'has-analytics@example.com', {
    withTenant: true, planEntitlementOverrides: {}
  });
  // The seeded Starter plan already sets analytics.level = 'basic'.

  const result = await portal.getAnalyticsOverview(env, siteRow, {
    startDate: '2026-01-01', endDate: '2026-01-31', dimensionType: 'casino', currency: 'USD'
  });
  assert.equal(result.ok, true);

  const call = client._calls[0];
  assert.equal(call.method, 'GET');
  assert.equal(call.tenantOrId, siteRow.tenant_id);
  assert.equal(
    call.path,
    '/en/api/super/analytics-overview?start_date=2026-01-01&end_date=2026-01-31&dimension_type=casino&currency=USD'
  );
});

test('tracking-health and revenue hit the correct real paths too', async () => {
  const env = makeEnv();
  const client = createFakeTenantClient();
  const portal = createTenantPortalService(client);
  const { siteRow } = await setUpSite(env, 'tracking-health@example.com', { withTenant: true });

  await portal.getTrackingHealth(env, siteRow);
  assert.equal(client._calls.at(-1).path, '/en/api/super/tracking-health');

  await portal.getAnalyticsRevenue(env, siteRow, { startDate: '2026-01-01', endDate: '2026-01-31', currency: 'USD' });
  assert.equal(client._calls.at(-1).path, '/en/api/super/analytics-revenue?start_date=2026-01-01&end_date=2026-01-31&currency=USD');
});

test('reports endpoints require reports.enabled, independent of analytics.level', async () => {
  const env = makeEnv();
  const client = createFakeTenantClient();
  const portal = createTenantPortalService(client);
  const { siteRow } = await setUpSite(env, 'reports-gate@example.com', { withTenant: true });
  // Starter plan has analytics.level = 'basic' but reports.enabled = false.

  const listResult = await portal.listReports(env, siteRow);
  assert.equal(listResult.ok, false);
  assert.equal(listResult.reason, 'not_entitled');

  const runResult = await portal.runReport(env, siteRow, 'report-123');
  assert.equal(runResult.ok, false);
  assert.equal(client._calls.length, 0);
});

test('reports endpoints succeed once reports.enabled is true, hitting the exact run path', async () => {
  const env = makeEnv();
  const client = createFakeTenantClient();
  const portal = createTenantPortalService(client);
  const { siteRow } = await setUpSite(env, 'reports-enabled@example.com', {
    withTenant: true, planEntitlementOverrides: { 'reports.enabled': true }
  });

  const listResult = await portal.listReports(env, siteRow);
  assert.equal(listResult.ok, true);

  await portal.runReport(env, siteRow, 'report-abc');
  const runCall = client._calls.at(-1);
  assert.equal(runCall.method, 'POST');
  assert.equal(runCall.path, '/en/api/super/reports/report-abc/run');
});

test('campaigns are gated on affiliate.enabled, not analytics or reports', async () => {
  const env = makeEnv();
  const client = createFakeTenantClient();
  const portal = createTenantPortalService(client);
  const { siteRow } = await setUpSite(env, 'campaigns-gate@example.com', {
    withTenant: true, planEntitlementOverrides: { 'reports.enabled': true } // reports on, affiliate still off
  });

  const listResult = await portal.listCampaigns(env, siteRow);
  assert.equal(listResult.ok, false);
  assert.equal(listResult.reason, 'not_entitled');

  const withAffiliate = await setUpSite(env, 'campaigns-allowed@example.com', {
    withTenant: true, planEntitlementOverrides: { 'affiliate.enabled': true }
  });
  const allowed = await portal.listCampaigns(env, withAffiliate.siteRow);
  assert.equal(allowed.ok, true);

  await portal.createCampaign(env, withAffiliate.siteRow, { name: 'Spring Push' });
  const createCall = client._calls.at(-1);
  assert.equal(createCall.method, 'POST');
  assert.equal(createCall.path, '/en/api/super/campaigns');
  assert.deepEqual(createCall.body, { name: 'Spring Push' });
});

test('alerts are gated on alerts.enabled and hit the exact acknowledge path', async () => {
  const env = makeEnv();
  const client = createFakeTenantClient();
  const portal = createTenantPortalService(client);
  const { siteRow } = await setUpSite(env, 'alerts-gate@example.com', {
    withTenant: true, planEntitlementOverrides: { 'alerts.enabled': true }
  });

  const listResult = await portal.listAlerts(env, siteRow);
  assert.equal(listResult.ok, true);

  await portal.acknowledgeAlert(env, siteRow, 'alert-99');
  const call = client._calls.at(-1);
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/en/api/super/alerts/alert-99/acknowledge');
});

// -----------------------------------------------------
// Deployment gate
// -----------------------------------------------------

test('an entitled organization whose site has no tenant_id yet gets site_not_deployed, not a tenant call', async () => {
  const env = makeEnv();
  const client = createFakeTenantClient();
  const portal = createTenantPortalService(client);
  const { siteRow } = await setUpSite(env, 'not-deployed@example.com', { withTenant: false });

  const result = await portal.getAnalyticsOverview(env, siteRow, { startDate: '2026-01-01', endDate: '2026-01-31' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'site_not_deployed');
  assert.equal(client._calls.length, 0);
});

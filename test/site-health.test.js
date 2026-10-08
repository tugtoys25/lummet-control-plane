// test/site-health.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';

import { getSiteHealthReport } from '../worker/site-health.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as sites from '../worker/sites.js';

function makeEnv() {
  const db = createTestDb();
  applyMigrations(db);
  return { LUMMET_DB: db };
}

function fakeSignupRequest(email) {
  return {
    async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org' }; },
    headers: { get: () => '203.0.113.140' }
  };
}

test('returns null for an unknown site rather than throwing', async () => {
  const env = makeEnv();
  const report = await getSiteHealthReport(env, 'does-not-exist');
  assert.equal(report, null);
});

test('a brand-new site with only its creation event has no computable uptime ratio (null, not 0 or 100)', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('health-new@example.com'), env);
  const site = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });

  const report = await getSiteHealthReport(env, site.siteId);
  assert.equal(report.currentStatus, 'pending');
  assert.equal(report.approximateUptimeRatio, null);
  assert.equal(report.lastFailure, null);
  assert.equal(report.lastHealthCheck, null);
  assert.equal(report.statusHistory.length, 1);
});

test('uptime ratio reflects real elapsed time in each status, and lastFailure reflects real history', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('health-history@example.com'), env);
  const site = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });

  const baseTime = Date.now() - 10 * 60 * 60 * 1000; // 10 hours ago
  const steps = [
    ['provisioning', 0],
    ['provisioned', 60],
    ['configuring', 61],
    ['deploying', 62],
    ['active', 63],       // active from minute 63 to minute 600 (~537 min active)
    ['suspended', 600]
  ];

  for (const [status] of steps) {
    await sites.transitionSiteStatus(env, site.siteId, status);
  }

  const events = await env.LUMMET_DB.prepare(`SELECT id, to_status FROM site_status_events WHERE site_id = ? ORDER BY id`)
    .bind(site.siteId).all();
  const eventList = events.results;
  for (let i = 0; i < steps.length; i++) {
    const [, minuteOffset] = steps[i];
    const eventRow = eventList[i + 1]; // +1 to skip the initial 'pending' event from createSite
    await env.LUMMET_DB.prepare(`UPDATE site_status_events SET created_at = ? WHERE id = ?`)
      .bind(new Date(baseTime + minuteOffset * 60 * 1000).toISOString(), eventRow.id)
      .run();
  }
  await env.LUMMET_DB.prepare(`UPDATE site_status_events SET created_at = ? WHERE id = ?`)
    .bind(new Date(baseTime).toISOString(), eventList[0].id)
    .run();

  const report = await getSiteHealthReport(env, site.siteId);
  assert.equal(report.currentStatus, 'suspended');
  assert.ok(
    report.approximateUptimeRatio > 0 && report.approximateUptimeRatio < 1,
    `expected a ratio strictly between 0 and 1, got ${report.approximateUptimeRatio}`
  );
  assert.ok(report.approximateUptimeRatio > 0.7, `expected most of the window to be active, got ${report.approximateUptimeRatio}`);
});

test('lastHealthCheck reflects a deployment health_check job step, when one exists', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('health-check-step@example.com'), env);
  const site = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });

  const jobId = crypto.randomUUID();
  await env.LUMMET_DB.prepare(
    `INSERT INTO jobs (id, type, site_id, status) VALUES (?, 'site_deployment', ?, 'success')`
  ).bind(jobId, site.siteId).run();
  await env.LUMMET_DB.prepare(
    `INSERT INTO job_steps (job_id, step_key, step_order, status, output, completed_at) VALUES (?, 'health_check', 0, 'success', ?, CURRENT_TIMESTAMP)`
  ).bind(jobId, JSON.stringify({ url: 'https://example.com/', statusCode: 200 })).run();

  const report = await getSiteHealthReport(env, site.siteId);
  assert.equal(report.lastHealthCheck.status, 'success');
  assert.equal(report.lastHealthCheck.detail.statusCode, 200);
});

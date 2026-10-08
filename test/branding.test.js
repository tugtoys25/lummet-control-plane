// test/branding.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';

import * as branding from '../worker/branding.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as plans from '../worker/plans.js';

function makeEnv() {
  const db = createTestDb();
  applyMigrations(db);
  return { LUMMET_DB: db };
}

function fakeSignupRequest(email) {
  return {
    async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org' }; },
    headers: { get: () => '203.0.113.110' }
  };
}

test('getBranding returns sensible defaults for an organization with no branding set yet', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('branding-defaults@example.com'), env);

  const result = await branding.getBranding(env, signup.organizationId);
  assert.equal(result.brand_name, null);
  assert.equal(result.hide_lummet_branding, 0);
});

test('updateBranding refuses an organization without white_label.enabled', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('branding-not-entitled@example.com'), env);

  const result = await branding.updateBranding(env, signup.organizationId, { brandName: 'Acme' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not_entitled');

  const stillDefault = await branding.getBranding(env, signup.organizationId);
  assert.equal(stillDefault.brand_name, null);
});

test('updateBranding succeeds once entitled, rejects a non-https logo URL, and persists across reads', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('branding-entitled@example.com'), env);
  await env.LUMMET_DB.prepare(
    `INSERT INTO plan_entitlements (plan_id, key, value_type, value) VALUES ('plan_casino_news_starter', 'white_label.enabled', 'boolean', 'true')
     ON CONFLICT(plan_id, key) DO UPDATE SET value = 'true'`
  ).run();
  await plans.startTrialSubscription(env, signup.organizationId, 'plan_casino_news_starter');

  const badUrl = await branding.updateBranding(env, signup.organizationId, { logoUrl: 'http://insecure.example/logo.png' });
  assert.equal(badUrl.ok, false);
  assert.equal(badUrl.error, 'logoUrl_must_be_https');

  const result = await branding.updateBranding(env, signup.organizationId, {
    brandName: 'Acme Media', logoUrl: 'https://acme.example/logo.png', hideLummetBranding: true
  });
  assert.equal(result.ok, true);

  const fetched = await branding.getBranding(env, signup.organizationId);
  assert.equal(fetched.brand_name, 'Acme Media');
  assert.equal(fetched.logo_url, 'https://acme.example/logo.png');
  assert.equal(fetched.hide_lummet_branding, 1);

  const second = await branding.updateBranding(env, signup.organizationId, { brandName: 'Acme Renamed' });
  assert.equal(second.ok, true);
  const fetchedAgain = await branding.getBranding(env, signup.organizationId);
  assert.equal(fetchedAgain.brand_name, 'Acme Renamed');
  assert.equal(fetchedAgain.logo_url, null, 'fields not resent on the second update are cleared, not merged');
});

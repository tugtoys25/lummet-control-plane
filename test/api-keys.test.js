// test/api-keys.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';

import * as apiKeys from '../worker/api-keys.js';
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
    headers: { get: () => '203.0.113.60' }
  };
}

test('createApiKey rejects a missing name and invalid scopes', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('keys-invalid@example.com'), env);

  const noName = await apiKeys.createApiKey(env, { organizationId: signup.organizationId, name: '', scopes: ['sites:read'] });
  assert.equal(noName.ok, false);
  assert.equal(noName.error, 'name_required');

  const badScope = await apiKeys.createApiKey(env, {
    organizationId: signup.organizationId, name: 'CI key', scopes: ['sites:write', 'sites:read']
  });
  assert.equal(badScope.ok, false);
  assert.equal(badScope.error, 'invalid_scopes');
  assert.deepEqual(badScope.invalidScopes, ['sites:write']);
});

test('createApiKey rejects a site from a different organization', async () => {
  const env = makeEnv();
  const orgA = await customerAuth.signUp(fakeSignupRequest('key-org-a@example.com'), env);
  const orgB = await customerAuth.signUp(fakeSignupRequest('key-org-b@example.com'), env);
  const siteInB = await sites.createSite(env, {
    organizationId: orgB.organizationId, name: 'B Site', productId: 'prod_casino_news', actorUserId: orgB.userId
  });

  const result = await apiKeys.createApiKey(env, {
    organizationId: orgA.organizationId, siteId: siteInB.siteId, name: 'Cross-org key', scopes: ['sites:read']
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_site');
});

test('a created key verifies to the right organization/site/scopes, and the listing never shows the token', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('key-verify@example.com'), env);
  const site = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });

  const created = await apiKeys.createApiKey(env, {
    organizationId: signup.organizationId, siteId: site.siteId, name: 'CI key', scopes: ['sites:read', 'usage:read']
  });
  assert.equal(created.ok, true);
  assert.ok(created.token.startsWith('lmk_'));

  const auth = await apiKeys.verifyApiKey(env, created.token);
  assert.equal(auth.organizationId, signup.organizationId);
  assert.equal(auth.siteId, site.siteId);
  assert.deepEqual(auth.scopes.sort(), ['sites:read', 'usage:read']);
  assert.equal(apiKeys.hasScope(auth, 'sites:read'), true);
  assert.equal(apiKeys.hasScope(auth, 'domains:read'), false);

  const listed = await apiKeys.listApiKeys(env, signup.organizationId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].key_prefix, created.prefix);
  assert.equal('token' in listed[0], false, 'the listing must never include the raw token');
});

test('verifyApiKey rejects an unknown token, a revoked key, and an expired key', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('key-lifecycle@example.com'), env);

  const bogus = await apiKeys.verifyApiKey(env, 'lmk_doesnotexist_atall');
  assert.equal(bogus, null);

  const created = await apiKeys.createApiKey(env, {
    organizationId: signup.organizationId, name: 'Revoke me', scopes: ['sites:read']
  });
  const revoked = await apiKeys.revokeApiKey(env, signup.organizationId, created.keyId);
  assert.equal(revoked.ok, true);
  assert.equal(await apiKeys.verifyApiKey(env, created.token), null);

  const expiring = await apiKeys.createApiKey(env, {
    organizationId: signup.organizationId, name: 'Expires soon', scopes: ['sites:read'],
    expiresAt: new Date(Date.now() - 1000).toISOString()
  });
  assert.equal(await apiKeys.verifyApiKey(env, expiring.token), null);
});

test('verifyApiKey updates last_used_at on successful auth', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('key-last-used@example.com'), env);
  const created = await apiKeys.createApiKey(env, {
    organizationId: signup.organizationId, name: 'Tracked key', scopes: ['usage:read']
  });

  const before = await apiKeys.listApiKeys(env, signup.organizationId);
  assert.equal(before[0].last_used_at, null);

  await apiKeys.verifyApiKey(env, created.token);

  const after = await apiKeys.listApiKeys(env, signup.organizationId);
  assert.ok(after[0].last_used_at);
});

test('revokeApiKey refuses a key id belonging to a different organization', async () => {
  const env = makeEnv();
  const orgA = await customerAuth.signUp(fakeSignupRequest('key-revoke-a@example.com'), env);
  const orgB = await customerAuth.signUp(fakeSignupRequest('key-revoke-b@example.com'), env);
  const created = await apiKeys.createApiKey(env, {
    organizationId: orgA.organizationId, name: 'A key', scopes: ['sites:read']
  });

  const result = await apiKeys.revokeApiKey(env, orgB.organizationId, created.keyId);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not_found');

  // Still usable, since the wrong-org revoke must not have succeeded.
  assert.ok(await apiKeys.verifyApiKey(env, created.token));
});

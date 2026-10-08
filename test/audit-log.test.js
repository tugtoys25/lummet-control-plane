// test/audit-log.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';

import { listOrganizationAuditLog } from '../worker/audit-log.js';
import { logAudit } from '../worker/audit.js';
import * as customerAuth from '../worker/customer-auth.js';

function makeEnv() {
  const db = createTestDb();
  applyMigrations(db);
  return { LUMMET_DB: db };
}

function fakeSignupRequest(email) {
  return {
    async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org' }; },
    headers: { get: () => '203.0.113.130' }
  };
}

test('listOrganizationAuditLog returns only entries for that organization, newest first', async () => {
  const env = makeEnv();
  const orgA = await customerAuth.signUp(fakeSignupRequest('audit-org-a@example.com'), env);
  const orgB = await customerAuth.signUp(fakeSignupRequest('audit-org-b@example.com'), env);

  await logAudit(env, {
    actorType: 'customer_user', customerUserId: orgA.userId, organizationId: orgA.organizationId,
    endpoint: '/api/organizations/x/sites', method: 'POST', resource: 'site', action: 'create', success: true, statusCode: 200
  });
  await logAudit(env, {
    actorType: 'customer_user', customerUserId: orgB.userId, organizationId: orgB.organizationId,
    endpoint: '/api/organizations/y/sites', method: 'POST', resource: 'site', action: 'create', success: true, statusCode: 200
  });
  await logAudit(env, {
    actorType: 'customer_user', customerUserId: orgA.userId, organizationId: orgA.organizationId,
    endpoint: '/api/organizations/x/domains', method: 'POST', resource: 'domain', action: 'create', success: false, statusCode: 422,
    errorMessage: 'invalid_hostname'
  });

  const entries = await listOrganizationAuditLog(env, orgA.organizationId);
  assert.equal(entries.length, 2, 'must only include org A\'s two entries, not org B\'s');
  assert.equal(entries.every((e) => e.resource === 'site' || e.resource === 'domain'), true);

  assert.equal(entries[0].resource, 'domain');
  assert.equal(entries[0].success, 0);
  assert.equal(entries[0].error_message, 'invalid_hostname');
  assert.equal(entries[1].resource, 'site');
});

test('listOrganizationAuditLog respects the limit and caps it at 500', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('audit-limit@example.com'), env);

  for (let i = 0; i < 5; i++) {
    await logAudit(env, {
      actorType: 'customer_user', customerUserId: signup.userId, organizationId: signup.organizationId,
      endpoint: '/api/x', method: 'GET', resource: 'test', action: 'noop', success: true, statusCode: 200
    });
  }

  const limited = await listOrganizationAuditLog(env, signup.organizationId, { limit: 3 });
  assert.equal(limited.length, 3);

  const overCapped = await listOrganizationAuditLog(env, signup.organizationId, { limit: 10000 });
  assert.ok(overCapped.length <= 500);
});

test('an organization with no audit history returns an empty array, not an error', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('audit-empty@example.com'), env);
  const entries = await listOrganizationAuditLog(env, signup.organizationId);
  assert.deepEqual(entries, []);
});

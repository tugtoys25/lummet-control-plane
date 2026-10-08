// test/change-requests.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';

import * as changeRequests from '../worker/change-requests.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as organizations from '../worker/organizations.js';
import * as sites from '../worker/sites.js';
import * as plans from '../worker/plans.js';

function makeEnv() {
  const db = createTestDb();
  applyMigrations(db);
  return { LUMMET_DB: db };
}

function fakeSignupRequest(email) {
  return {
    async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org' }; },
    headers: { get: () => '203.0.113.120' }
  };
}

async function enableApprovalWorkflows(env, organizationId) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO plan_entitlements (plan_id, key, value_type, value) VALUES ('plan_casino_news_starter', 'approval_workflows.enabled', 'boolean', 'true')
     ON CONFLICT(plan_id, key) DO UPDATE SET value = 'true'`
  ).run();
  await plans.startTrialSubscription(env, organizationId, 'plan_casino_news_starter');
}

test('without the entitlement, requesting deletion deletes the site immediately (unchanged existing behavior)', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('no-approval@example.com'), env);
  const site = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });

  const result = await changeRequests.requestSiteDeletion(env, {
    organizationId: signup.organizationId, siteId: site.siteId, actorUserId: signup.userId
  });
  assert.equal(result.ok, true);
  assert.equal(result.requiresApproval, false);

  const siteRow = await sites.getSite(env, site.siteId);
  assert.equal(siteRow.status, 'deleting');
});

test('with the entitlement, requesting deletion creates a pending change request and leaves the site untouched', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('approval-required@example.com'), env);
  await enableApprovalWorkflows(env, signup.organizationId);
  const site = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });

  const result = await changeRequests.requestSiteDeletion(env, {
    organizationId: signup.organizationId, siteId: site.siteId, actorUserId: signup.userId, reason: 'no longer needed'
  });
  assert.equal(result.ok, true);
  assert.equal(result.requiresApproval, true);
  assert.ok(result.changeRequestId);

  const siteRow = await sites.getSite(env, site.siteId);
  assert.equal(siteRow.status, 'pending', 'the site must not change status until approved');

  const pending = await changeRequests.listChangeRequests(env, signup.organizationId, { status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].resource_id, site.siteId);
});

test('a second deletion request for the same pending site is refused, not duplicated', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('duplicate-request@example.com'), env);
  await enableApprovalWorkflows(env, signup.organizationId);
  const site = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });

  await changeRequests.requestSiteDeletion(env, { organizationId: signup.organizationId, siteId: site.siteId, actorUserId: signup.userId });
  const second = await changeRequests.requestSiteDeletion(env, { organizationId: signup.organizationId, siteId: site.siteId, actorUserId: signup.userId });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'deletion_already_requested');
});

test('the requester cannot approve their own request (segregation of duties)', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('self-approve@example.com'), env);
  await enableApprovalWorkflows(env, signup.organizationId);
  const site = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });
  const request = await changeRequests.requestSiteDeletion(env, {
    organizationId: signup.organizationId, siteId: site.siteId, actorUserId: signup.userId
  });

  const selfApprove = await changeRequests.approveChangeRequest(env, {
    organizationId: signup.organizationId, changeRequestId: request.changeRequestId, approverUserId: signup.userId
  });
  assert.equal(selfApprove.ok, false);
  assert.equal(selfApprove.error, 'cannot_approve_own_request');

  const siteRow = await sites.getSite(env, site.siteId);
  assert.equal(siteRow.status, 'pending', 'the site must remain untouched after a refused self-approval');
});

test('a different admin approving the request actually deletes the site, and rejecting it does not', async () => {
  const env = makeEnv();
  const requester = await customerAuth.signUp(fakeSignupRequest('approval-requester@example.com'), env);
  await enableApprovalWorkflows(env, requester.organizationId);

  const invitation = await organizations.createInvitation(env, {
    organizationId: requester.organizationId, email: 'approver@example.com', role: 'admin', invitedBy: requester.userId
  });
  const approver = await customerAuth.signUp(fakeSignupRequest('approver@example.com'), env);
  await organizations.acceptInvitation(env, invitation.token, approver.userId);

  const site = await sites.createSite(env, {
    organizationId: requester.organizationId, name: 'Site To Delete', productId: 'prod_casino_news', actorUserId: requester.userId
  });
  const request = await changeRequests.requestSiteDeletion(env, {
    organizationId: requester.organizationId, siteId: site.siteId, actorUserId: requester.userId
  });

  const approval = await changeRequests.approveChangeRequest(env, {
    organizationId: requester.organizationId, changeRequestId: request.changeRequestId, approverUserId: approver.userId
  });
  assert.equal(approval.ok, true);

  const siteRow = await sites.getSite(env, site.siteId);
  assert.equal(siteRow.status, 'deleting');

  const stillPending = await changeRequests.listChangeRequests(env, requester.organizationId, { status: 'pending' });
  assert.equal(stillPending.length, 0);

  const site2 = await sites.createSite(env, {
    organizationId: requester.organizationId, name: 'Site To Keep', productId: 'prod_casino_news', actorUserId: requester.userId
  });
  const request2 = await changeRequests.requestSiteDeletion(env, {
    organizationId: requester.organizationId, siteId: site2.siteId, actorUserId: requester.userId
  });
  const rejection = await changeRequests.rejectChangeRequest(env, {
    organizationId: requester.organizationId, changeRequestId: request2.changeRequestId, approverUserId: approver.userId, reason: 'keep it'
  });
  assert.equal(rejection.ok, true);
  const site2Row = await sites.getSite(env, site2.siteId);
  assert.equal(site2Row.status, 'pending', 'a rejected deletion request must not touch the site');
});

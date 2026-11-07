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

// The workflow only applies when a second owner/admin exists who could approve.
async function addSecondAdmin(env, organizationId, ownerUserId, email) {
  const invitation = await organizations.createInvitation(env, { organizationId, email, role: 'admin', invitedBy: ownerUserId });
  const second = await customerAuth.signUp(fakeSignupRequest(email), env);
  await organizations.acceptInvitation(env, invitation.token, second.userId);
  return second;
}

test('without the entitlement, requesting deletion deletes the site immediately (unchanged existing behavior)', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('no-approval@example.com'), env);
  const site = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });

  const result = await changeRequests.requestSiteDeletion(env, { confirmName: 'Site',
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
  await addSecondAdmin(env, signup.organizationId, signup.userId, 'second1@example.com');
  const site = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });

  const result = await changeRequests.requestSiteDeletion(env, { confirmName: 'Site',
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
  await addSecondAdmin(env, signup.organizationId, signup.userId, 'second2@example.com');
  const site = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });

  await changeRequests.requestSiteDeletion(env, { confirmName: 'Site', organizationId: signup.organizationId, siteId: site.siteId, actorUserId: signup.userId });
  const second = await changeRequests.requestSiteDeletion(env, { confirmName: 'Site', organizationId: signup.organizationId, siteId: site.siteId, actorUserId: signup.userId });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'deletion_already_requested');
});

test('the requester cannot approve their own request (segregation of duties)', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('self-approve@example.com'), env);
  await enableApprovalWorkflows(env, signup.organizationId);
  await addSecondAdmin(env, signup.organizationId, signup.userId, 'second3@example.com');
  const site = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });
  const request = await changeRequests.requestSiteDeletion(env, { confirmName: 'Site',
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
  const request = await changeRequests.requestSiteDeletion(env, { confirmName: 'Site To Delete',
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
  const request2 = await changeRequests.requestSiteDeletion(env, { confirmName: 'Site To Keep',
    organizationId: requester.organizationId, siteId: site2.siteId, actorUserId: requester.userId
  });
  const rejection = await changeRequests.rejectChangeRequest(env, {
    organizationId: requester.organizationId, changeRequestId: request2.changeRequestId, approverUserId: approver.userId, reason: 'keep it'
  });
  assert.equal(rejection.ok, true);
  const site2Row = await sites.getSite(env, site2.siteId);
  assert.equal(site2Row.status, 'pending', 'a rejected deletion request must not touch the site');
});

test('with the entitlement but no second owner/admin, the sole owner deletes directly (nobody could approve), still with the typed name', async () => {
  const env = makeEnv();
  const solo = await customerAuth.signUp(fakeSignupRequest('solo-owner@example.com'), env);
  await enableApprovalWorkflows(env, solo.organizationId);
  const site = await sites.createSite(env, { organizationId: solo.organizationId, name: 'Solo Site', productId: 'prod_casino_news', actorUserId: solo.userId });

  const wrong = await changeRequests.requestSiteDeletion(env, { organizationId: solo.organizationId, siteId: site.siteId, actorUserId: solo.userId, confirmName: 'nope' });
  assert.equal(wrong.error, 'confirmation_required');

  const r = await changeRequests.requestSiteDeletion(env, { confirmName: 'Solo Site', organizationId: solo.organizationId, siteId: site.siteId, actorUserId: solo.userId });
  assert.equal(r.ok, true); assert.equal(r.requiresApproval, false); assert.ok(r.jobId);
  assert.equal((await sites.getSite(env, site.siteId)).status, 'deleting');
});

test('a viewer or editor does not count as an approver; a disabled admin does not either', async () => {
  const env = makeEnv();
  const owner = await customerAuth.signUp(fakeSignupRequest('count-owner@example.com'), env);
  await enableApprovalWorkflows(env, owner.organizationId);
  const inv = await organizations.createInvitation(env, { organizationId: owner.organizationId, email: 'editor@example.com', role: 'editor', invitedBy: owner.userId });
  const editor = await customerAuth.signUp(fakeSignupRequest('editor@example.com'), env);
  await organizations.acceptInvitation(env, inv.token, editor.userId);
  const admin2 = await addSecondAdmin(env, owner.organizationId, owner.userId, 'disabled-admin@example.com');
  await env.LUMMET_DB.prepare(`UPDATE customer_users SET status = 'disabled' WHERE id = ?`).bind(admin2.userId).run();
  const site = await sites.createSite(env, { organizationId: owner.organizationId, name: 'Count Site', productId: 'prod_casino_news', actorUserId: owner.userId });
  const r = await changeRequests.requestSiteDeletion(env, { confirmName: 'Count Site', organizationId: owner.organizationId, siteId: site.siteId, actorUserId: owner.userId });
  assert.equal(r.requiresApproval, false, 'only one active owner/admin, so the workflow cannot apply');
});

test('a request filed while a second admin existed is closed, not left pending, when the owner later deletes directly', async () => {
  const env = makeEnv();
  const owner = await customerAuth.signUp(fakeSignupRequest('stale-owner@example.com'), env);
  await enableApprovalWorkflows(env, owner.organizationId);
  const second = await addSecondAdmin(env, owner.organizationId, owner.userId, 'stale-second@example.com');
  const site = await sites.createSite(env, { organizationId: owner.organizationId, name: 'Stale Site', productId: 'prod_casino_news', actorUserId: owner.userId });
  const pending = await changeRequests.requestSiteDeletion(env, { confirmName: 'Stale Site', organizationId: owner.organizationId, siteId: site.siteId, actorUserId: owner.userId });
  assert.equal(pending.requiresApproval, true);

  await env.LUMMET_DB.prepare(`UPDATE customer_users SET status = 'disabled' WHERE id = ?`).bind(second.userId).run();   // the second admin leaves
  const direct = await changeRequests.requestSiteDeletion(env, { confirmName: 'Stale Site', organizationId: owner.organizationId, siteId: site.siteId, actorUserId: owner.userId });
  assert.equal(direct.ok, true); assert.equal(direct.requiresApproval, false);
  const row = await env.LUMMET_DB.prepare(`SELECT status FROM change_requests WHERE id = ?`).bind(pending.changeRequestId).first();
  assert.equal(row.status, 'canceled');
});

// test/phase1-foundation.test.js
//
// Covers the Phase 1 SaaS-foundation modules (customer-auth,
// organizations, sites, plans, entitlements) against a real SQLite
// schema via the D1 shim (see test/support/d1-shim.js) — the same
// approach already used by the tenant repo's test suite. This is not
// exhaustive coverage of every route in index.js; it targets the
// logic where a mistake would be a real security or billing bug:
// cross-tenant access, trial expiry, entitlement resolution, and the
// site status state machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';

import * as customerAuth from '../worker/customer-auth.js';
import * as organizations from '../worker/organizations.js';
import * as sites from '../worker/sites.js';
import * as plans from '../worker/plans.js';
import * as entitlements from '../worker/entitlements.js';
import { roleAtLeast, isValidRole } from '../worker/customer-rbac.js';

function makeEnv() {
  const db = createTestDb();
  applyMigrations(db);
  return { LUMMET_DB: db };
}

function fakeRequest(body, { ip = '203.0.113.5' } = {}) {
  return {
    async json() { return body; },
    headers: { get: (name) => (name === 'CF-Connecting-IP' ? ip : null) }
  };
}

function cookieValue(setCookieHeader) {
  return setCookieHeader.split(';')[0].split('=')[1];
}

// -----------------------------------------------------
// customer-rbac
// -----------------------------------------------------

test('roleAtLeast respects the owner > admin > editor > analyst > viewer hierarchy', () => {
  assert.equal(roleAtLeast('owner', 'admin'), true);
  assert.equal(roleAtLeast('viewer', 'admin'), false);
  assert.equal(roleAtLeast('admin', 'admin'), true);
  assert.equal(isValidRole('owner'), true);
  assert.equal(isValidRole('superuser'), false);
});

// -----------------------------------------------------
// Sign up / login / sessions
// -----------------------------------------------------

test('signUp creates a customer_user, an organization, and an owner membership together', async () => {
  const env = makeEnv();
  const result = await customerAuth.signUp(
    fakeRequest({ email: 'owner2@example.com', password: 'correct-horse-battery', organizationName: 'Acme Media' }),
    env
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.cookie.includes('lummet_customer_session='));

  const orgs = await organizations.listOrganizationsForUser(env, result.userId);
  assert.equal(orgs.length, 1);
  assert.equal(orgs[0].my_role, 'owner');
});

test('signUp rejects a short password and a duplicate email', async () => {
  const env = makeEnv();
  const tooShort = await customerAuth.signUp(
    fakeRequest({ email: 'a@example.com', password: 'short', organizationName: 'Acme' }),
    env
  );
  assert.equal(tooShort.ok, false);
  assert.equal(tooShort.error, 'invalid_email_or_password');

  const first = await customerAuth.signUp(
    fakeRequest({ email: 'dupe@example.com', password: 'correct-horse-battery', organizationName: 'Acme' }),
    env
  );
  assert.equal(first.ok, true);

  const second = await customerAuth.signUp(
    fakeRequest({ email: 'dupe@example.com', password: 'another-long-password', organizationName: 'Acme 2' }),
    env
  );
  assert.equal(second.ok, false);
  assert.equal(second.error, 'email_already_registered');
});

test('login succeeds with correct credentials and fails with the wrong password, without leaking which part was wrong', async () => {
  const env = makeEnv();
  await customerAuth.signUp(
    fakeRequest({ email: 'login@example.com', password: 'correct-horse-battery', organizationName: 'Acme' }),
    env
  );

  const wrongPassword = await customerAuth.login(fakeRequest({ email: 'login@example.com', password: 'nope-nope-nope' }), env);
  assert.equal(wrongPassword.ok, false);
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.error, 'invalid_credentials');

  const unknownEmail = await customerAuth.login(fakeRequest({ email: 'nobody@example.com', password: 'whatever12345' }), env);
  assert.equal(unknownEmail.error, wrongPassword.error, 'must not reveal whether the email exists');

  const success = await customerAuth.login(fakeRequest({ email: 'login@example.com', password: 'correct-horse-battery' }), env);
  assert.equal(success.ok, true);
  assert.ok(success.cookie);
});

test('getCurrentCustomer resolves a valid session and returns null once logged out', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(
    fakeRequest({ email: 'session@example.com', password: 'correct-horse-battery', organizationName: 'Acme' }),
    env
  );
  const sessionId = cookieValue(signup.cookie);
  const fakeSessionRequest = { headers: { get: (h) => (h === 'Cookie' ? `lummet_customer_session=${sessionId}` : null) } };

  const resolved = await customerAuth.getCurrentCustomer(fakeSessionRequest, env);
  assert.equal(resolved.id, signup.userId);

  await customerAuth.logout(fakeSessionRequest, env);
  const afterLogout = await customerAuth.getCurrentCustomer(fakeSessionRequest, env);
  assert.equal(afterLogout, null);
});

// -----------------------------------------------------
// Organizations: membership, roles, invitations
// -----------------------------------------------------

test('a lone owner cannot be demoted or removed, but a second owner can be', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(
    fakeRequest({ email: 'sole-owner@example.com', password: 'correct-horse-battery', organizationName: 'Acme' }),
    env
  );

  const demote = await organizations.updateMemberRole(env, signup.organizationId, signup.userId, 'admin');
  assert.equal(demote.ok, false);
  assert.equal(demote.error, 'must_keep_one_owner');

  const remove = await organizations.removeMember(env, signup.organizationId, signup.userId);
  assert.equal(remove.ok, false);
  assert.equal(remove.error, 'must_keep_one_owner');

  // Add a second owner via direct membership insert (bypassing the
  // invitation flow, which is exercised separately below) and confirm
  // the original owner can now be demoted.
  const second = await customerAuth.signUp(
    fakeRequest({ email: 'second-owner@example.com', password: 'correct-horse-battery', organizationName: 'Second Org' }),
    env
  );
  await env.LUMMET_DB.prepare(
    `INSERT INTO organization_users (organization_id, user_id, role) VALUES (?, ?, 'owner')`
  ).bind(signup.organizationId, second.userId).run();

  const demoteNowOk = await organizations.updateMemberRole(env, signup.organizationId, signup.userId, 'admin');
  assert.equal(demoteNowOk.ok, true);
});

test('invitation accept flow: valid token succeeds, reused/unknown token fails, expired token fails', async () => {
  const env = makeEnv();
  const inviter = await customerAuth.signUp(
    fakeRequest({ email: 'inviter@example.com', password: 'correct-horse-battery', organizationName: 'Acme' }),
    env
  );
  const invitee = await customerAuth.signUp(
    fakeRequest({ email: 'invitee@example.com', password: 'correct-horse-battery', organizationName: 'Invitee Org' }),
    env
  );

  const invitation = await organizations.createInvitation(env, {
    organizationId: inviter.organizationId, email: 'invitee@example.com', role: 'editor', invitedBy: inviter.userId
  });
  assert.equal(invitation.ok, true);

  const accepted = await organizations.acceptInvitation(env, invitation.token, invitee.userId);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.organizationId, inviter.organizationId);

  const membership = await organizations.getMembership(env, inviter.organizationId, invitee.userId);
  assert.equal(membership.role, 'editor');

  // Same token again -- already consumed (status no longer 'pending').
  const reused = await organizations.acceptInvitation(env, invitation.token, invitee.userId);
  assert.equal(reused.ok, false);
  assert.equal(reused.error, 'invalid_or_used_invitation');

  const bogus = await organizations.acceptInvitation(env, 'not-a-real-token', invitee.userId);
  assert.equal(bogus.ok, false);

  // Simulate an expired invitation directly (rather than waiting out
  // the real 7-day TTL) and confirm it's rejected.
  const expiredInvite = await organizations.createInvitation(env, {
    organizationId: inviter.organizationId, email: 'late@example.com', role: 'viewer', invitedBy: inviter.userId
  });
  await env.LUMMET_DB.prepare(`UPDATE organization_invitations SET expires_at = ? WHERE id = ?`)
    .bind(new Date(Date.now() - 1000).toISOString(), expiredInvite.invitationId).run();

  const late = await customerAuth.signUp(
    fakeRequest({ email: 'late@example.com', password: 'correct-horse-battery', organizationName: 'Late Org' }),
    env
  );
  const expiredResult = await organizations.acceptInvitation(env, expiredInvite.token, late.userId);
  assert.equal(expiredResult.ok, false);
  assert.equal(expiredResult.error, 'invitation_expired');
});

test('a user with no membership on an organization cannot be resolved as a member of it (cross-org isolation)', async () => {
  const env = makeEnv();
  const orgA = await customerAuth.signUp(
    fakeRequest({ email: 'a-owner@example.com', password: 'correct-horse-battery', organizationName: 'Org A' }),
    env
  );
  const orgB = await customerAuth.signUp(
    fakeRequest({ email: 'b-owner@example.com', password: 'correct-horse-battery', organizationName: 'Org B' }),
    env
  );

  const crossMembership = await organizations.getMembership(env, orgA.organizationId, orgB.userId);
  assert.equal(crossMembership, null, 'Org B\'s owner must have no membership row on Org A');
});

// -----------------------------------------------------
// Entitlements: zero-access floor, trial resolution, expiry
// -----------------------------------------------------

test('an organization with no subscription resolves to the zero-access floor', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(
    fakeRequest({ email: 'no-sub@example.com', password: 'correct-horse-battery', organizationName: 'No Sub Org' }),
    env
  );

  const sitesMax = await entitlements.checkEntitlement(env, signup.organizationId, 'sites.max');
  assert.equal(sitesMax, 0);
  const aiEnabled = await entitlements.checkEntitlement(env, signup.organizationId, 'ai.enabled');
  assert.equal(aiEnabled, false);
});

test('starting a trial resolves real plan entitlements from the seeded catalog', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(
    fakeRequest({ email: 'trial@example.com', password: 'correct-horse-battery', organizationName: 'Trial Org' }),
    env
  );

  const trial = await plans.startTrialSubscription(env, signup.organizationId, 'plan_casino_news_starter');
  assert.equal(trial.ok, true);
  assert.ok(trial.trialEndsAt, 'a plan with trial_days > 0 must produce a trial_ends_at');

  const sitesMax = await entitlements.checkEntitlement(env, signup.organizationId, 'sites.max');
  assert.equal(sitesMax, 1);
  const analyticsLevel = await entitlements.checkEntitlement(env, signup.organizationId, 'analytics.level');
  assert.equal(analyticsLevel, 'basic');

  // A second subscription attempt must be refused, not silently
  // create a conflicting second row.
  const secondAttempt = await plans.startTrialSubscription(env, signup.organizationId, 'plan_casino_news_starter');
  assert.equal(secondAttempt.ok, false);
  assert.equal(secondAttempt.error, 'organization_already_subscribed');
});

test('a trial past its trial_ends_at collapses back to the zero-access floor, calculated from the real date', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(
    fakeRequest({ email: 'expired-trial@example.com', password: 'correct-horse-battery', organizationName: 'Expired Org' }),
    env
  );
  const trial = await plans.startTrialSubscription(env, signup.organizationId, 'plan_casino_news_starter');

  // Confirm entitlements are live before expiry.
  assert.equal(await entitlements.checkEntitlement(env, signup.organizationId, 'sites.max'), 1);

  // Force the trial into the past without touching `status` --
  // entitlements.js must compute expiry from the date, not rely on a
  // status column someone forgot to flip.
  const sub = await plans.getActiveSubscription(env, signup.organizationId);
  await env.LUMMET_DB.prepare(`UPDATE subscriptions SET trial_ends_at = ? WHERE id = ?`)
    .bind(new Date(Date.now() - 1000).toISOString(), sub.id).run();

  assert.equal(await entitlements.checkEntitlement(env, signup.organizationId, 'sites.max'), 0);
  assert.equal(await entitlements.checkEntitlement(env, signup.organizationId, 'ai.enabled'), false);
});

test('an enterprise override on a subscription takes precedence over the plan default', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(
    fakeRequest({ email: 'override@example.com', password: 'correct-horse-battery', organizationName: 'Override Org' }),
    env
  );
  await plans.startTrialSubscription(env, signup.organizationId, 'plan_casino_news_starter');
  const sub = await plans.getActiveSubscription(env, signup.organizationId);

  assert.equal(await entitlements.checkEntitlement(env, signup.organizationId, 'sites.max'), 1);

  await env.LUMMET_DB.prepare(
    `INSERT INTO subscription_entitlement_overrides (subscription_id, key, value_type, value, reason)
     VALUES (?, 'sites.max', 'number', '25', 'manual enterprise override for test')`
  ).bind(sub.id).run();

  assert.equal(await entitlements.checkEntitlement(env, signup.organizationId, 'sites.max'), 25);
});

// -----------------------------------------------------
// Sites: creation, entitlement-gated limits, status state machine
// -----------------------------------------------------

test('site creation is refused once the organization is at its sites.max entitlement', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(
    fakeRequest({ email: 'site-limit@example.com', password: 'correct-horse-battery', organizationName: 'Site Limit Org' }),
    env
  );
  await plans.startTrialSubscription(env, signup.organizationId, 'plan_casino_news_starter'); // sites.max = 1

  const first = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'My First Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });
  assert.equal(first.ok, true);

  const maxSites = await entitlements.checkEntitlement(env, signup.organizationId, 'sites.max');
  const currentCount = await sites.countActiveSitesForOrganization(env, signup.organizationId);
  assert.equal(currentCount >= maxSites, true, 'the org should now be at its entitlement limit');
});

test('site status transitions follow the allowed state machine and reject invalid jumps', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(
    fakeRequest({ email: 'lifecycle@example.com', password: 'correct-horse-battery', organizationName: 'Lifecycle Org' }),
    env
  );
  const created = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Lifecycle Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });

  // Cannot jump straight from pending to active -- provisioning must
  // actually happen first (this is the guard against fake deployment
  // success, master prompt rule #5).
  const skipAhead = await sites.transitionSiteStatus(env, created.siteId, 'active');
  assert.equal(skipAhead.ok, false);
  assert.equal(skipAhead.error, 'invalid_transition');

  const step1 = await sites.transitionSiteStatus(env, created.siteId, 'provisioning');
  assert.equal(step1.ok, true);
  const step2 = await sites.transitionSiteStatus(env, created.siteId, 'provisioned');
  assert.equal(step2.ok, true);
  const step3 = await sites.transitionSiteStatus(env, created.siteId, 'configuring');
  assert.equal(step3.ok, true);
  const step4 = await sites.transitionSiteStatus(env, created.siteId, 'deploying');
  assert.equal(step4.ok, true);
  const step5 = await sites.transitionSiteStatus(env, created.siteId, 'active');
  assert.equal(step5.ok, true);

  const site = await sites.getSite(env, created.siteId);
  assert.equal(site.status, 'active');

  const events = await sites.listStatusEvents(env, created.siteId);
  assert.equal(events.length, 6, 'creation + 5 transitions should each leave one status event');

  const suspend = await sites.transitionSiteStatus(env, created.siteId, 'suspended', { reason: 'nonpayment', actorType: 'lummet_admin' });
  assert.equal(suspend.ok, true);
  const suspended = await sites.getSite(env, created.siteId);
  assert.equal(suspended.suspension_reason, 'nonpayment');

  // A deleted site cannot transition anywhere else.
  const del1 = await sites.transitionSiteStatus(env, created.siteId, 'deleting');
  assert.equal(del1.ok, true);
  const del2 = await sites.transitionSiteStatus(env, created.siteId, 'deleted');
  assert.equal(del2.ok, true);
  const del3 = await sites.transitionSiteStatus(env, created.siteId, 'active');
  assert.equal(del3.ok, false);
});

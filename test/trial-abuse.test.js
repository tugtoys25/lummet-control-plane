// Roadmap 1.6: a partial, honestly-scoped mitigation — see plans.js's
// hasPriorTrialElsewhere header comment for exactly what this does and
// does not cover (email reuse is caught; a fresh email each time is not,
// and that deeper case needs a live payment provider this repo can't
// exercise, so it's flagged rather than faked).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import * as plans from '../worker/plans.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as organizations from '../worker/organizations.js';

function env() { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64') }; }
function fakeSignupRequest(email, organizationName) {
  return { async json() { return { email, password: 'correct-horse-battery', organizationName }; }, headers: { get: () => '203.0.113.30' } };
}

test('a brand-new email gets its trial normally', async () => {
  const e = env();
  const s = await customerAuth.signUp(fakeSignupRequest('fresh@example.com', 'Org'), e);
  const r = await plans.startTrialSubscription(e, s.organizationId, 'plan_casino_news_starter');
  assert.ok(r.ok, JSON.stringify(r));
});

test('same email, new organization, after the first trial: refused', async () => {
  const e = env();
  const s1 = await customerAuth.signUp(fakeSignupRequest('reuse@example.com', 'Org 1'), e);
  await plans.startTrialSubscription(e, s1.organizationId, 'plan_casino_news_starter');

  // Same person creates a second organization (e.g. accepted into one,
  // or created a fresh one manually) — still the same underlying email.
  const org2 = await organizations.createOrganization(e, { name: 'Org 2', ownerUserId: (await organizations.listMembers(e, s1.organizationId))[0].user_id });
  const r = await plans.startTrialSubscription(e, org2.organizationId, 'plan_casino_news_growth');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'trial_already_used');
});

test("a DIFFERENT email is unaffected by someone else's prior trial", async () => {
  const e = env();
  const s1 = await customerAuth.signUp(fakeSignupRequest('first@example.com', 'Org 1'), e);
  await plans.startTrialSubscription(e, s1.organizationId, 'plan_casino_news_starter');
  const s2 = await customerAuth.signUp(fakeSignupRequest('second@example.com', 'Org 2'), e);
  const r = await plans.startTrialSubscription(e, s2.organizationId, 'plan_casino_news_starter');
  assert.ok(r.ok, JSON.stringify(r));
});

test('no-trial plans (business/sales-assisted) are never gated by this check', async () => {
  const e = env();
  const s1 = await customerAuth.signUp(fakeSignupRequest('agency@example.com', 'Org 1'), e);
  await plans.startTrialSubscription(e, s1.organizationId, 'plan_agency_30'); // trial_days = 0
  const org2 = await organizations.createOrganization(e, { name: 'Org 2', ownerUserId: (await organizations.listMembers(e, s1.organizationId))[0].user_id });
  const r = await plans.startTrialSubscription(e, org2.organizationId, 'plan_agency_30');
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.trialEndsAt, null);
});

test('a cancelled/expired prior subscription still counts as "already used a trial" for this mitigation', async () => {
  const e = env();
  const s1 = await customerAuth.signUp(fakeSignupRequest('cancelled@example.com', 'Org 1'), e);
  const first = await plans.startTrialSubscription(e, s1.organizationId, 'plan_casino_news_starter');
  await e.LUMMET_DB.prepare(`UPDATE subscriptions SET status = 'canceled' WHERE id = ?`).bind(first.subscriptionId).run();
  const org2 = await organizations.createOrganization(e, { name: 'Org 2', ownerUserId: (await organizations.listMembers(e, s1.organizationId))[0].user_id });
  const r = await plans.startTrialSubscription(e, org2.organizationId, 'plan_casino_news_starter');
  assert.equal(r.error, 'trial_already_used');
});

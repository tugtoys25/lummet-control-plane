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

// ---- v7G: trivially different spellings of the same address ----
import { emailKey } from '../worker/email-key.js';
import { readFileSync } from 'node:fs';
import { splitSqlStatements } from './support/d1-shim.js';

const CASES = [
  ['Person@Example.com', 'person@example.com'], ['person+trial2@example.com', 'person@example.com'], ['  PERSON+x+y@EXAMPLE.COM ', 'person@example.com'],
  ['first.last@example.com', 'first.last@example.com'], ['f.i.r.s.t+z@gmail.com', 'first@gmail.com'], ['First.Last@GoogleMail.com', 'firstlast@gmail.com'],
  ['+weird@example.com', '+weird@example.com'], ['a@b', 'a@b'], ['nodomain', 'nodomain'], ['', '']
];

test('emailKey: lower case, +tag removed, Gmail dots and googlemail unified, other dots kept', () => {
  for (const [input, expected] of CASES) assert.equal(emailKey(input), expected, input);
});

test('the SQL backfill in the migration computes exactly what emailKey() does', async () => {
  const e = env(); const db = e.LUMMET_DB;
  // Use real rows: addresses as typed, key cleared, then run the migration's UPDATE statements again.
  await db.prepare(`DELETE FROM customer_users`).run();
  const inputs = CASES.map((c) => c[0]).filter((i) => i.trim() && i.includes('@') && !i.startsWith('+'));
  for (const input of inputs) await db.prepare(`INSERT INTO customer_users (id, email, password_hash) VALUES (?, ?, 'x')`).bind(crypto.randomUUID(), input).run();
  const sql = readFileSync(new URL('../migrations/0042_customer_email_key.sql', import.meta.url), 'utf8');
  for (const stmt of splitSqlStatements(sql).filter((s) => s.trim().toUpperCase().startsWith('UPDATE'))) await db.prepare(stmt).run();
  for (const input of inputs) {
    const row = await db.prepare(`SELECT email_key k FROM customer_users WHERE email = ?`).bind(input).first();
    assert.equal(row.k, emailKey(input), input);
  }
});

test('a +tag or Gmail-dot variant of an address that already had a trial is refused; a different mailbox is not', async () => {
  const e = env();
  const first = await customerAuth.signUp(fakeSignupRequest('Some.One@Gmail.com', 'Org 1'), e);
  assert.ok((await plans.startTrialSubscription(e, first.organizationId, 'plan_casino_news_starter')).ok);
  for (const variant of ['someone@gmail.com', 'some.one+promo@gmail.com', 'S.o.m.e.O.n.e@googlemail.com']) {
    const s = await customerAuth.signUp(fakeSignupRequest(variant, 'Org ' + variant), e);
    assert.equal(s.ok, true, variant);
    const r = await plans.startTrialSubscription(e, s.organizationId, 'plan_casino_news_starter');
    assert.equal(r.ok, false, variant); assert.equal(r.error, 'trial_already_used', variant);
  }
  const other = await customerAuth.signUp(fakeSignupRequest('someone.else@gmail.com', 'Other'), e);
  assert.ok((await plans.startTrialSubscription(e, other.organizationId, 'plan_casino_news_starter')).ok);
});

test('a +tag on a non-Gmail address is also the same person; dots elsewhere are significant', async () => {
  const e = env();
  const a = await customerAuth.signUp(fakeSignupRequest('jo.hn@company.example', 'A'), e);
  await plans.startTrialSubscription(e, a.organizationId, 'plan_casino_news_starter');
  const tagged = await customerAuth.signUp(fakeSignupRequest('jo.hn+two@company.example', 'B'), e);
  assert.equal((await plans.startTrialSubscription(e, tagged.organizationId, 'plan_casino_news_starter')).error, 'trial_already_used');
  const dotless = await customerAuth.signUp(fakeSignupRequest('john@company.example', 'C'), e);
  assert.ok((await plans.startTrialSubscription(e, dotless.organizationId, 'plan_casino_news_starter')).ok, 'outside Gmail, dots can be a different mailbox');
});

test('new accounts always get a key (signup stores it)', async () => {
  const e = env();
  await customerAuth.signUp(fakeSignupRequest('Key.Test+1@Example.com', 'Org'), e);
  assert.equal((await e.LUMMET_DB.prepare(`SELECT email_key k FROM customer_users`).first()).k, 'key.test@example.com');
});

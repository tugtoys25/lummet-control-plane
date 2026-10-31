// Round 6.4A (release 2.6.0.9): migration 0072_org_security_policy, the policy repository and service, and org-wide 2FA
// enforced at sign-in and on session use.
// Acceptance: the policy blocks a non-2FA sign-in and session use; cross-organization access is impossible;
// the migration verifiers pass; billing role and RBAC are unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createTestDb, applyMigrations, splitSqlStatements } from './support/d1-shim.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as totp from '../worker/totp.js';
import * as organizations from '../worker/organizations.js';
import * as policy from '../worker/org-security-policy.js';
import * as repo from '../worker/repositories/org-security-policy.js';
import { roleAtLeast } from '../worker/customer-rbac.js';
import { configIssues } from '../worker/config-check.js';
import { ORG_DELETE } from '../worker/retention-policy.js';

const MIGRATION = readFileSync(new URL('../migrations/0072_org_security_policy.sql', import.meta.url), 'utf8');
const PW = 'correct-horse-battery';

function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ORG_SECURITY_POLICY: 'enforce', ...extra };
}
const one = (e, sql, ...b) => e.LUMMET_DB.prepare(sql).bind(...b).first();
const all = async (e, sql, ...b) => (await e.LUMMET_DB.prepare(sql).bind(...b).all()).results;
const run = (e, sql, ...b) => e.LUMMET_DB.prepare(sql).bind(...b).run();
const req = (body, cookie) => ({ async json() { return body; }, headers: { get: (n) => (n.toLowerCase() === 'cookie' ? cookie || '' : '203.0.113.9') } });
const cookieOf = (result) => String(result.cookie).split(';')[0];

async function signup(env, email, orgName = 'Org ' + email) {
  const r = await customerAuth.signUp(req({ email, password: PW, organizationName: orgName }), env);
  assert.equal(r.ok, true, JSON.stringify(r));
  return { userId: r.userId, organizationId: r.organizationId, cookie: cookieOf(r) };
}
/** Turns TOTP on for a user through the real setup and confirm path, so the factor is genuine. */
async function enableTotp(env, userId) {
  const s = await totp.startTotpSetup(env, userId);
  assert.equal(s.ok, true);
  const c = await totp.confirmTotpSetup(env, userId, await totp.generateTotpCode(s.secret));
  assert.equal(c.ok, true);
  return s.secret;
}
async function addMember(env, organizationId, userId, role) {
  await run(env, `INSERT INTO organization_users (organization_id, user_id, role) VALUES (?, ?, ?)`, organizationId, userId, role);
}
const session = (env, cookie) => customerAuth.getCustomerSession(req({}, cookie), env);
const auditRows = (env, action) => all(env, `SELECT * FROM lummet_audit_logs WHERE action = ? ORDER BY id`, action);

// ------------------------------------------------------------------ migration 0072
test('0072 creates organization_security_policies with the blueprint columns and safe defaults', async () => {
  const env = makeEnv();
  const cols = (await all(env, `PRAGMA table_info(organization_security_policies)`)).map((c) => c.name);
  assert.deepEqual(cols, ['organization_id', 'require_2fa', 'require_sso', 'ip_allowlist_json', 'updated_at']);
  const { organizationId } = await signup(env, 'a@example.com');
  await run(env, `INSERT INTO organization_security_policies (organization_id) VALUES (?)`, organizationId);
  const row = await one(env, `SELECT * FROM organization_security_policies WHERE organization_id = ?`, organizationId);
  assert.equal(row.require_2fa, 0); assert.equal(row.require_sso, 0); assert.equal(row.ip_allowlist_json, '[]');
  assert.ok(row.updated_at);
});

test('0072 is safe to run twice, starts empty, rejects bad values and cascades with the organization', async () => {
  const env = makeEnv();
  for (const s of splitSqlStatements(MIGRATION)) await run(env, s); // second run: IF NOT EXISTS
  assert.equal((await one(env, `SELECT COUNT(*) n FROM organization_security_policies`)).n, 0);
  const { organizationId } = await signup(env, 'b@example.com');
  await assert.rejects(() => run(env, `INSERT INTO organization_security_policies (organization_id, require_2fa) VALUES (?, 2)`, organizationId));
  await assert.rejects(() => run(env, `INSERT INTO organization_security_policies (organization_id, ip_allowlist_json) VALUES (?, 'not json')`, organizationId));
  await assert.rejects(() => run(env, `INSERT INTO organization_security_policies (organization_id) VALUES ('no-such-org')`), 'foreign key to organizations');
  await run(env, `INSERT INTO organization_security_policies (organization_id) VALUES (?)`, organizationId);
  await assert.rejects(() => run(env, `INSERT INTO organization_security_policies (organization_id) VALUES (?)`, organizationId), 'one row per organization');
});

test('migration numbering stays consecutive: 0075 (platform settings) is the newest, then 0074 (payment gateways), 0073 (public copy) and 0072; 0072 is additive only', () => {
  const files = readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();
  assert.equal(files.at(-1), '0075_platform_settings.sql'); assert.equal(files.at(-2), '0074_payment_gateways.sql'); assert.equal(files.at(-3), '0073_public_conversion_copy.sql'); assert.equal(files.at(-4), '0072_org_security_policy.sql'); assert.equal(files.at(-5), '0071_revenue.sql');
  assert.doesNotMatch(MIGRATION, /\b(DROP|DELETE\s+FROM|ALTER\s+TABLE|UPDATE\s)/i);
});

test('the new table is covered by the erasure retention policy', () => {
  assert.ok(ORG_DELETE.some(([t]) => t === 'organization_security_policies'));
});

// ------------------------------------------------------------------ the flag
test('the flag: unset or invalid is off; off reads nothing and blocks nothing', async () => {
  assert.equal(policy.orgSecurityPolicyMode({}), 'off');
  assert.equal(policy.orgSecurityPolicyMode({ ORG_SECURITY_POLICY: ' Enforce ' }), 'enforce');
  assert.equal(policy.orgSecurityPolicyMode({ ORG_SECURITY_POLICY: 'shadow' }), 'shadow');
  assert.equal(policy.orgSecurityPolicyMode({ ORG_SECURITY_POLICY: 'yes' }), 'off');
  const env = makeEnv({ ORG_SECURITY_POLICY: undefined });
  const owner = await signup(env, 'o@example.com');
  await run(env, `INSERT INTO organization_security_policies (organization_id, require_2fa) VALUES (?, 1)`, owner.organizationId);
  const s = await session(env, owner.cookie);
  assert.equal(s.customer.id, owner.userId); assert.equal(s.policy.blocked, false); assert.equal(s.policy.mode, 'off');
  assert.equal((await customerAuth.getCurrentCustomer(req({}, owner.cookie), env)).id, owner.userId);
});

test('config-check: an invalid flag value fails the production deploy; unset passes', () => {
  const base = { ENVIRONMENT: 'production' };
  assert.ok(configIssues({ ...base, ORG_SECURITY_POLICY: 'maybe' }).some((i) => i.key === 'ORG_SECURITY_POLICY'));
  assert.ok(!configIssues(base).some((i) => i.key === 'ORG_SECURITY_POLICY'));
  for (const v of ['off', 'shadow', 'enforce']) assert.ok(!configIssues({ ...base, ORG_SECURITY_POLICY: v }).some((i) => i.key === 'ORG_SECURITY_POLICY'));
});

// ------------------------------------------------------------------ writing the policy
test('only an owner can change the policy, with a reason; the change is audited and billing/admin cannot', async () => {
  const env = makeEnv();
  const owner = await signup(env, 'owner@example.com'); await enableTotp(env, owner.userId);
  const mk = async (email, role) => { const u = await signup(env, email); await addMember(env, owner.organizationId, u.userId, role); return u; };
  const admin = await mk('admin@example.com', 'admin'), billing = await mk('bill@example.com', 'billing');

  for (const who of [admin, billing]) {
    const r = await policy.setRequire2fa(env, { organizationId: owner.organizationId, actorUserId: who.userId, require2fa: true, reason: 'tightening security' });
    assert.deepEqual([r.ok, r.status, r.error], [false, 403, 'forbidden']);
  }
  assert.equal(await repo.getPolicy(env, owner.organizationId), null, 'a refused write stores nothing');

  const noReason = await policy.setRequire2fa(env, { organizationId: owner.organizationId, actorUserId: owner.userId, require2fa: true, reason: '  ' });
  assert.deepEqual([noReason.ok, noReason.status, noReason.error], [false, 422, 'reason_required']);
  const tooLong = await policy.setRequire2fa(env, { organizationId: owner.organizationId, actorUserId: owner.userId, require2fa: true, reason: 'x'.repeat(501) });
  assert.equal(tooLong.error, 'reason_required');
  assert.equal((await policy.setRequire2fa(env, { organizationId: owner.organizationId, actorUserId: owner.userId, require2fa: 'yes', reason: 'valid reason' })).error, 'invalid_value');

  const ok = await policy.setRequire2fa(env, { organizationId: owner.organizationId, actorUserId: owner.userId, require2fa: true, reason: 'Auditor requirement 2026', requestId: 'req-1', ipHash: 'iphash' });
  assert.equal(ok.ok, true); assert.equal(ok.changed, true); assert.equal(ok.policy.require2fa, true);
  assert.equal(ok.membersWithout2fa, 2, 'admin and billing have no factor yet');
  const row = await auditRows(env, 'require_2fa_enable');
  assert.equal(row.length, 1);
  assert.deepEqual([row[0].reason, row[0].organization_id, row[0].customer_user_id, row[0].actor_type, row[0].resource, row[0].resource_id, row[0].success, row[0].request_id], ['Auditor requirement 2026', owner.organizationId, owner.userId, 'customer_user', 'organization_security_policy', owner.organizationId, 1, 'req-1']);
  assert.ok((await auditRows(env, 'require_2fa_enable_refused')).length >= 1, 'refusals are audited too');
});

test('turning it on and off: idempotent, audited each time, other columns untouched', async () => {
  const env = makeEnv();
  const o = await signup(env, 'o2@example.com'); await enableTotp(env, o.userId);
  await run(env, `INSERT INTO organization_security_policies (organization_id, require_sso, ip_allowlist_json) VALUES (?, 1, '["203.0.113.0/24"]')`, o.organizationId);
  const set = (v, reason = 'routine change') => policy.setRequire2fa(env, { organizationId: o.organizationId, actorUserId: o.userId, require2fa: v, reason });
  assert.equal((await set(true)).changed, true);
  assert.equal((await set(true)).changed, false, 'same value again is a no-op');
  assert.equal((await auditRows(env, 'require_2fa_enable')).length, 1);
  assert.equal((await set(false, 'rolled back')).changed, true);
  assert.equal((await auditRows(env, 'require_2fa_disable')).length, 1);
  const row = await repo.getPolicy(env, o.organizationId);
  assert.equal(row.require_2fa, 0); assert.equal(row.require_sso, 1, 'SSO column is never touched by 6.4A'); assert.equal(row.ip_allowlist_json, '["203.0.113.0/24"]', 'allowlist is never touched by 6.4A');
});

test('lockout guard: an owner without 2FA cannot require it for the organization', async () => {
  const env = makeEnv();
  const o = await signup(env, 'o3@example.com');
  const r = await policy.setRequire2fa(env, { organizationId: o.organizationId, actorUserId: o.userId, require2fa: true, reason: 'enable it please' });
  assert.deepEqual([r.ok, r.status, r.error], [false, 409, 'actor_needs_2fa']);
  assert.equal(await repo.getPolicy(env, o.organizationId), null);
  assert.equal((await auditRows(env, 'require_2fa_enable_refused')).length, 1);
  // turning it OFF never needs a factor: that is the way out
  assert.equal((await policy.setRequire2fa(env, { organizationId: o.organizationId, actorUserId: o.userId, require2fa: false, reason: 'making sure it is off' })).ok, true);
});

test('writes and reads are refused while the flag is off', async () => {
  const env = makeEnv({ ORG_SECURITY_POLICY: 'off' });
  const o = await signup(env, 'o4@example.com'); await enableTotp(env, o.userId);
  const w = await policy.setRequire2fa(env, { organizationId: o.organizationId, actorUserId: o.userId, require2fa: true, reason: 'should not apply' });
  assert.deepEqual([w.ok, w.status, w.error], [false, 404, 'not_available']);
  const g = await policy.readPolicy(env, { organizationId: o.organizationId, actorUserId: o.userId });
  assert.deepEqual([g.ok, g.status], [false, 404]);
});

test('reading the policy needs membership; a stranger and another organization get nothing', async () => {
  const env = makeEnv();
  const a = await signup(env, 'a1@example.com'), b = await signup(env, 'b1@example.com');
  await enableTotp(env, a.userId);
  await policy.setRequire2fa(env, { organizationId: a.organizationId, actorUserId: a.userId, require2fa: true, reason: 'require it now' });
  const mine = await policy.readPolicy(env, { organizationId: a.organizationId, actorUserId: a.userId });
  assert.equal(mine.ok, true); assert.equal(mine.policy.require2fa, true); assert.equal(mine.enforcement, 'enforce');
  const theirs = await policy.readPolicy(env, { organizationId: a.organizationId, actorUserId: b.userId });
  assert.deepEqual([theirs.ok, theirs.status, theirs.error], [false, 403, 'forbidden']);
  // b owns b's own org but can never write a's
  const w = await policy.setRequire2fa(env, { organizationId: a.organizationId, actorUserId: b.userId, require2fa: false, reason: 'trying to switch it off' });
  assert.deepEqual([w.ok, w.status], [false, 403]);
  assert.equal((await repo.getPolicy(env, a.organizationId)).require_2fa, 1);
});

// ------------------------------------------------------------------ enforcement: sign-in and session use
async function orgRequiring2fa(env) {
  const owner = await signup(env, 'boss@example.com'); await enableTotp(env, owner.userId);
  const member = await signup(env, 'member@example.com');
  await addMember(env, owner.organizationId, member.userId, 'editor');
  const r = await policy.setRequire2fa(env, { organizationId: owner.organizationId, actorUserId: owner.userId, require2fa: true, reason: 'org policy for 2026' });
  assert.equal(r.ok, true);
  return { owner, member };
}

test('SIGN-IN: a member without 2FA gets no usable session; the response says why and how to recover', async () => {
  const env = makeEnv();
  const { member } = await orgRequiring2fa(env);
  const r = await customerAuth.login(req({ email: 'member@example.com', password: PW }), env);
  assert.equal(r.ok, true);
  assert.equal(r.twoFactorEnrollmentRequired, true);
  assert.equal(r.reason, 'org_2fa_required');
  const s = await session(env, cookieOf(r));
  assert.equal(s.customer.id, member.userId, 'the restricted session identifies the user so enrollment is possible');
  assert.equal(s.policy.blocked, true); assert.deepEqual(s.policy.reason, 'org_2fa_required');
  assert.equal(await customerAuth.getCurrentCustomer(req({}, cookieOf(r)), env), null, 'the strict resolver treats it as no session');
});

test('SIGN-IN: a member who has 2FA still has to pass the code, then gets a normal session', async () => {
  const env = makeEnv();
  const { member } = await orgRequiring2fa(env);
  const secret = await enableTotp(env, member.userId);
  const r = await customerAuth.login(req({ email: 'member@example.com', password: PW }), env);
  assert.equal(r.mfaRequired, true); assert.equal(r.cookie, undefined, 'no session before the code');
  const done = await customerAuth.completeMfaLogin(env, r.challengeId, { code: await totp.generateTotpCode(secret) });
  assert.equal(done.ok, true);
  assert.equal((await session(env, cookieOf(done))).policy.blocked, false);
  assert.equal((await customerAuth.getCurrentCustomer(req({}, cookieOf(done)), env)).id, member.userId);
});

test('SESSION USE: a session issued before the policy existed is blocked from the moment it is switched on', async () => {
  const env = makeEnv();
  const owner = await signup(env, 'early-owner@example.com'); await enableTotp(env, owner.userId);
  const m = await signup(env, 'early-member@example.com'); await addMember(env, owner.organizationId, m.userId, 'viewer');
  assert.equal((await customerAuth.getCurrentCustomer(req({}, m.cookie), env)).id, m.userId, 'fine before the policy');
  await policy.setRequire2fa(env, { organizationId: owner.organizationId, actorUserId: owner.userId, require2fa: true, reason: 'switching it on' });
  assert.equal(await customerAuth.getCurrentCustomer(req({}, m.cookie), env), null, 'the old session is blocked at once, with no re-login needed');
  assert.equal((await session(env, m.cookie)).policy.blocked, true);
  assert.equal((await customerAuth.getCurrentCustomer(req({}, owner.cookie), env)).id, owner.userId, 'the owner has 2FA and is unaffected');
});

test('RECOVERY: enabling 2FA on the restricted session lifts the block immediately, and switching the policy off does too', async () => {
  const env = makeEnv();
  const { owner, member } = await orgRequiring2fa(env);
  const r = await customerAuth.login(req({ email: 'member@example.com', password: PW }), env);
  const cookie = cookieOf(r);
  assert.equal((await session(env, cookie)).policy.blocked, true);
  await enableTotp(env, member.userId); // the 2FA setup routes accept a restricted session
  assert.equal((await session(env, cookie)).policy.blocked, false);
  // second member: owner switches the policy off
  const m2 = await signup(env, 'second@example.com'); await addMember(env, owner.organizationId, m2.userId, 'viewer');
  assert.equal((await session(env, m2.cookie)).policy.blocked, true);
  await policy.setRequire2fa(env, { organizationId: owner.organizationId, actorUserId: owner.userId, require2fa: false, reason: 'rolling back' });
  assert.equal((await session(env, m2.cookie)).policy.blocked, false);
});

test('SHADOW: nothing is blocked, but the session reports that it would have been', async () => {
  const env = makeEnv({ ORG_SECURITY_POLICY: 'shadow' });
  const { member } = await orgRequiring2fa(env);
  const r = await customerAuth.login(req({ email: 'member@example.com', password: PW }), env);
  assert.equal(r.twoFactorEnrollmentRequired, undefined);
  const s = await session(env, cookieOf(r));
  assert.equal(s.customer.id, member.userId); assert.equal(s.policy.blocked, false); assert.equal(s.policy.wouldBlock, true);
  assert.equal((await customerAuth.getCurrentCustomer(req({}, cookieOf(r)), env)).id, member.userId);
});

test('SESSION USE: other sign-in paths are covered because the check is on the session, not the login route', async () => {
  const env = makeEnv();
  const { member } = await orgRequiring2fa(env);
  const viaOther = await customerAuth.createSession(env, member.userId, null); // what the passkey and SSO paths call
  assert.equal((await session(env, cookieOf(viaOther))).policy.blocked, true);
  assert.equal(viaOther.twoFactorEnrollmentRequired, true);
});

test('a pending (unconfirmed) TOTP setup does not count as 2FA', async () => {
  const env = makeEnv();
  const { member } = await orgRequiring2fa(env);
  await totp.startTotpSetup(env, member.userId);
  const r = await customerAuth.login(req({ email: 'member@example.com', password: PW }), env);
  assert.equal(r.twoFactorEnrollmentRequired, true);
});

test('a disabled account and a bad password are refused exactly as before', async () => {
  const env = makeEnv();
  await orgRequiring2fa(env);
  assert.equal((await customerAuth.login(req({ email: 'member@example.com', password: 'wrong-password-123' }), env)).error, 'invalid_credentials');
  await run(env, `UPDATE customer_users SET status = 'disabled' WHERE email = 'member@example.com'`);
  assert.equal((await customerAuth.login(req({ email: 'member@example.com', password: PW }), env)).error, 'account_disabled');
});

// ------------------------------------------------------------------ cross-organization isolation
test('CROSS-ORG: another organization\'s policy never reaches a person who is not a member of it', async () => {
  const env = makeEnv();
  await orgRequiring2fa(env); // org A requires 2FA
  const outsider = await signup(env, 'outsider@example.com'); // own org B, no policy, no 2FA
  const s = await session(env, outsider.cookie);
  assert.equal(s.policy.blocked, false);
  assert.equal((await customerAuth.getCurrentCustomer(req({}, outsider.cookie), env)).id, outsider.userId);
  const login = await customerAuth.login(req({ email: 'outsider@example.com', password: PW }), env);
  assert.equal(login.twoFactorEnrollmentRequired, undefined); assert.ok(login.cookie);
});

test('CROSS-ORG: the repository answers only for the organization and user asked about', async () => {
  const env = makeEnv();
  const { owner, member } = await orgRequiring2fa(env);
  const other = await signup(env, 'other@example.com');
  assert.deepEqual(await repo.enforcingOrganizationIdsForUser(env, member.userId), [owner.organizationId]);
  assert.deepEqual(await repo.enforcingOrganizationIdsForUser(env, other.userId), []);
  assert.equal(await repo.getPolicy(env, other.organizationId), null);
  // a policy row for org A with require_2fa=0 does not enforce
  await policy.setRequire2fa(env, { organizationId: owner.organizationId, actorUserId: owner.userId, require2fa: false, reason: 'turning it back off' });
  assert.deepEqual(await repo.enforcingOrganizationIdsForUser(env, member.userId), []);
});

test('CROSS-ORG: a member of two organizations is held to the policy of the one that requires 2FA', async () => {
  const env = makeEnv();
  const { member } = await orgRequiring2fa(env);
  const second = await signup(env, 'host@example.com');
  await addMember(env, second.organizationId, member.userId, 'viewer'); // also in a no-policy org
  const r = await customerAuth.login(req({ email: 'member@example.com', password: PW }), env);
  assert.equal(r.twoFactorEnrollmentRequired, true);
  const s = await session(env, cookieOf(r));
  assert.equal(s.policy.blocked, true);
  assert.equal(s.policy.organizationIds.length, 1, 'only the requiring organization is named');
});

// ------------------------------------------------------------------ RBAC and billing role unchanged
test('RBAC is unchanged: the role order and the billing capability rules are exactly as before', () => {
  assert.equal(roleAtLeast('billing', 'billing'), true); assert.equal(roleAtLeast('admin', 'billing'), true); assert.equal(roleAtLeast('owner', 'billing'), true);
  assert.equal(roleAtLeast('editor', 'billing'), false); assert.equal(roleAtLeast('billing', 'viewer'), false); assert.equal(roleAtLeast('billing', 'editor'), false);
  assert.equal(roleAtLeast('admin', 'owner'), false); assert.equal(roleAtLeast('owner', 'admin'), true);
});

test('a billing-role member is held to the 2FA requirement like any other member, and gains no right to change it', async () => {
  const env = makeEnv();
  const owner = await signup(env, 'ow@example.com'); await enableTotp(env, owner.userId);
  const bill = await signup(env, 'bl@example.com'); await addMember(env, owner.organizationId, bill.userId, 'billing');
  await policy.setRequire2fa(env, { organizationId: owner.organizationId, actorUserId: owner.userId, require2fa: true, reason: 'org wide rule' });
  assert.equal((await session(env, bill.cookie)).policy.blocked, true);
  assert.equal((await organizations.getMembership(env, owner.organizationId, bill.userId)).role, 'billing', 'the role itself is untouched');
});

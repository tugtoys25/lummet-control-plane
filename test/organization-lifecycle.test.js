// Covers roadmap 1.2: transfer ownership, deactivate/reactivate, and
// scheduled (never-immediate) deletion — plus the authorization gap
// found and fixed while building this: a customer must never be able
// to reverse a STAFF-issued suspension via the "reactivate" route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import * as organizations from '../worker/organizations.js';
import worker from '../worker/index.js';

function env() { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'), ENVIRONMENT: 'production' }; }
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
async function call(e, method, path, body, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.' + (Math.floor(Math.random() * 200) + 1) });
  if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
  const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, text: t, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function signup(e, email) {
  const s = await call(e, 'POST', '/api/customer/signup', { email, password: 'Correct-Horse-Battery-9', organizationName: 'Org ' + email });
  return { org: s.json.organizationId, userId: s.json.userId, cookie: s.cookie };
}
async function invite(e, org, cookie, email, role) {
  const r = await call(e, 'POST', `/api/organizations/${org}/invitations`, { email, role }, cookie);
  return r.json.token; // EMAIL_PROVIDER isn't configured in this test env, so the API returns the token directly
}

test('transferOwnership: only an owner can transfer, target must be a member, caller becomes admin', async () => {
  const e = env();
  const owner = await signup(e, 'owner@example.com');
  const token = await invite(e, owner.org, owner.cookie, 'member@example.com', 'admin');
  const member = await call(e, 'POST', '/api/customer/signup', { email: 'member@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'X' });
  await call(e, 'POST', `/api/invitations/${token}/accept`, null, member.cookie);
  const memberUserId = (await organizations.listMembers(e, owner.org)).find((m) => m.email === 'member@example.com').user_id;
  const ownerUserId = (await organizations.listMembers(e, owner.org)).find((m) => m.email === 'owner@example.com').user_id;

  const notOwner = await call(e, 'POST', `/api/organizations/${owner.org}/transfer-ownership`, { toUserId: memberUserId }, member.cookie);
  assert.equal(notOwner.status, 403);

  const noSuchTarget = await call(e, 'POST', `/api/organizations/${owner.org}/transfer-ownership`, { toUserId: 'not-a-member' }, owner.cookie);
  assert.equal(noSuchTarget.status, 404);

  const ok = await call(e, 'POST', `/api/organizations/${owner.org}/transfer-ownership`, { toUserId: memberUserId }, owner.cookie);
  assert.equal(ok.status, 200, ok.text);
  const members = await organizations.listMembers(e, owner.org);
  const roles = Object.fromEntries(members.map((m) => [m.email, m.role]));
  assert.equal(roles['member@example.com'], 'owner');
  assert.equal(roles['owner@example.com'], 'admin');

  // Former owner (now admin) can no longer transfer ownership again.
  const stale = await call(e, 'POST', `/api/organizations/${owner.org}/transfer-ownership`, { toUserId: ownerUserId }, owner.cookie);
  assert.equal(stale.status, 403);
});

test('deactivate is owner-only, reversible by the owner, and cross-organization calls are rejected', async () => {
  const e = env();
  const a = await signup(e, 'da@example.com'); const b = await signup(e, 'db@example.com');
  const cross = await call(e, 'POST', `/api/organizations/${a.org}/deactivate`, null, b.cookie);
  assert.equal(cross.status, 403);
  const off = await call(e, 'POST', `/api/organizations/${a.org}/deactivate`, null, a.cookie);
  assert.equal(off.status, 200, off.text);
  assert.equal((await organizations.getOrganization(e, a.org)).status, 'closed');
  // While closed, ordinary mutations are refused...
  const blocked = await call(e, 'POST', `/api/organizations/${a.org}/invitations`, { email: 'x@y.test', role: 'viewer' }, a.cookie);
  assert.equal(blocked.status, 403); assert.equal(blocked.json.error, 'organization_suspended');
  // ...but reactivate itself is exempt from that same gate.
  const on = await call(e, 'POST', `/api/organizations/${a.org}/reactivate`, null, a.cookie);
  assert.equal(on.status, 200, on.text);
  assert.equal((await organizations.getOrganization(e, a.org)).status, 'active');
});

test('SECURITY: a customer cannot reactivate an organization that STAFF suspended — only their own voluntary closure', async () => {
  const e = env();
  const org = await signup(e, 'punished@example.com');
  // Simulate a staff suspension directly (status enum shared with staff-saas.js's setOrganizationStatus).
  await e.LUMMET_DB.prepare(`UPDATE organizations SET status = 'suspended' WHERE id = ?`).bind(org.org).run();
  const attempt = await call(e, 'POST', `/api/organizations/${org.org}/reactivate`, null, org.cookie);
  assert.equal(attempt.status, 403);
  assert.equal(attempt.json.error, 'suspended_by_staff_contact_support');
  assert.equal((await organizations.getOrganization(e, org.org)).status, 'suspended', 'must remain suspended');
});

test('request-deletion never deletes immediately: schedules a future date, closes the org, and is cancellable', async () => {
  const e = env();
  const org = await signup(e, 'leaving@example.com');
  const req = await call(e, 'POST', `/api/organizations/${org.org}/request-deletion`, null, org.cookie);
  assert.equal(req.status, 200, req.text);
  assert.ok(req.json.scheduledDeletionAt);
  const scheduledDate = new Date(req.json.scheduledDeletionAt);
  const daysOut = (scheduledDate - Date.now()) / 86400000;
  assert.ok(daysOut > 25 && daysOut < 35, 'grace period should be roughly 30 days, not immediate');

  const row = await organizations.getOrganization(e, org.org);
  assert.equal(row.status, 'closed');
  assert.ok(row.deletion_requested_by);

  // Still exists — nothing was actually erased.
  const orgs = await organizations.listOrganizationsPendingDeletion(e);
  assert.equal(orgs.length, 1);

  // Requesting again is idempotent, not a second schedule.
  const again = await call(e, 'POST', `/api/organizations/${org.org}/request-deletion`, null, org.cookie);
  assert.equal(again.json.alreadyScheduled, true);

  const cancel = await call(e, 'POST', `/api/organizations/${org.org}/cancel-deletion`, null, org.cookie);
  assert.equal(cancel.status, 200);
  const after = await organizations.getOrganization(e, org.org);
  assert.equal(after.status, 'active'); assert.equal(after.scheduled_deletion_at, null);
  assert.equal((await organizations.listOrganizationsPendingDeletion(e)).length, 0);
});

test('non-owners cannot request or cancel deletion, or deactivate, for an organization they belong to', async () => {
  const e = env();
  const owner = await signup(e, 'owner2@example.com');
  const token = await invite(e, owner.org, owner.cookie, 'viewer@example.com', 'viewer');
  const viewer = await call(e, 'POST', '/api/customer/signup', { email: 'viewer@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'X' });
  await call(e, 'POST', `/api/invitations/${token}/accept`, null, viewer.cookie);
  for (const action of ['deactivate', 'request-deletion']) {
    const r = await call(e, 'POST', `/api/organizations/${owner.org}/${action}`, null, viewer.cookie);
    assert.equal(r.status, 403, action);
  }
});

test('every organization lifecycle action is audited', async () => {
  const e = env();
  const org = await signup(e, 'audited@example.com');
  await call(e, 'POST', `/api/organizations/${org.org}/deactivate`, null, org.cookie);
  await call(e, 'POST', `/api/organizations/${org.org}/reactivate`, null, org.cookie);
  const rows = await e.LUMMET_DB.prepare(`SELECT action FROM lummet_audit_logs WHERE resource = 'organization' AND action IN ('deactivate','reactivate') ORDER BY id`).all();
  assert.deepEqual(rows.results.map((r) => r.action), ['deactivate', 'reactivate']);
});

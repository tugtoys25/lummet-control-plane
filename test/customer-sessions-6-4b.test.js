// Round 6.4B (release 2.6.0.10), acceptance tests written BEFORE the code.
// Covers: the organization session list and immediate revoke (role-gated, org-scoped, reusable core for SCIM deprovision in 7.1C)
// and the customer audit-log CSV (org-scoped, role-gated, escaped, formula-injection safe, paginated).
// All requests go through the real Worker entry point against the migrated test database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as sessions from '../worker/customer-sessions.js';
import * as auditCsv from '../worker/customer-audit-csv.js';
import { csvCell } from '../worker/revenue-analytics.js';
import { logAudit } from '../worker/audit.js';
import { createTestDb, applyMigrations } from './support/d1-shim.js';

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
const PW = 'Correct-Horse-Battery-9';

function env(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), CUSTOMER_SESSION_ADMIN: 'on', CUSTOMER_AUDIT_CSV: 'on', PORTAL_BASE_URL: 'https://app.example.test',
    EMAIL_FETCH: async () => new Response(JSON.stringify({ id: 'fake-email' }), { status: 200 }), ...extra };
}
let ipCounter = 0;   // sign-up is rate limited per address, so every sign-up in a test comes from its own documentation-range address
async function call(e, method, path, body, cookie, ip = '198.51.100.77') {
  const h = new Headers({ 'CF-Connecting-IP': ip });
  if (cookie) h.set('Cookie', cookie);
  if (body != null) h.set('Content-Type', 'application/json');
  const response = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body == null ? undefined : JSON.stringify(body), redirect: 'manual' }), e, ctx);
  const text = await response.text(); let json = null; try { json = JSON.parse(text); } catch (err) { json = null; }
  return { status: response.status, json, text, headers: response.headers, cookie: (response.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function signup(e, email) {
  const r = await call(e, 'POST', '/api/customer/signup', { email, password: PW, organizationName: 'Org ' + email }, null, `203.0.113.${(++ipCounter % 250) + 1}`);
  assert.equal(r.status, 200, r.text);
  const userId = (await e.LUMMET_DB.prepare('SELECT id FROM customer_users WHERE email = ?').bind(email).first()).id;
  return { cookie: r.cookie, organizationId: r.json.organizationId, userId };
}
// A person added to someone else's organization with a role, holding a live session whose active organization is that one.
async function member(e, org, email, role) {
  const u = await signup(e, email);
  await e.LUMMET_DB.prepare('INSERT INTO organization_users (organization_id, user_id, role) VALUES (?, ?, ?)').bind(org.organizationId, u.userId, role).run();
  const s = await customerAuth.createSession(e, u.userId, org.organizationId);
  return { ...u, cookie: s.cookie.split(';')[0], sessionId: s.sessionId, role };
}
async function world(e) {
  const owner = await signup(e, 'owner@example.test');
  const admin = await member(e, owner, 'admin@example.test', 'admin');
  const editor = await member(e, owner, 'editor@example.test', 'editor');
  const billing = await member(e, owner, 'billing@example.test', 'billing');
  const viewer = await member(e, owner, 'viewer@example.test', 'viewer');
  return { owner, admin, editor, billing, viewer, base: `/api/organizations/${owner.organizationId}` };
}
const sessionRowCount = async (e, sessionId) => (await e.LUMMET_DB.prepare('SELECT COUNT(*) n FROM customer_sessions WHERE id = ?').bind(sessionId).first()).n;

// ---------- Revoke ends the session immediately ----------

test('ACCEPTANCE: revoke ends the session immediately (the very next request with that cookie is unauthenticated)', async () => {
  const e = env(); const w = await world(e);
  assert.equal((await call(e, 'GET', '/api/organizations', null, w.editor.cookie)).status, 200, 'the editor session works before the revoke');
  const list = await call(e, 'GET', `${w.base}/sessions`, null, w.admin.cookie);
  assert.equal(list.status, 200, list.text);
  const target = list.json.data.find((s) => s.userId === w.editor.userId);
  assert.ok(target && target.handle, 'the editor session is listed with a handle');
  const rev = await call(e, 'POST', `${w.base}/sessions/revoke`, { handle: target.handle, reason: 'Laptop reported lost by the editor' }, w.admin.cookie);
  assert.equal(rev.status, 200, rev.text); assert.equal(rev.json.revoked, 1);
  assert.equal(await sessionRowCount(e, w.editor.sessionId), 0, 'the row is gone');
  assert.equal((await call(e, 'GET', '/api/organizations', null, w.editor.cookie)).status, 401, 'the same cookie is now rejected');
  assert.equal((await call(e, 'GET', `${w.base}/members`, null, w.editor.cookie)).status, 401);
  const audit = (await e.LUMMET_DB.prepare(`SELECT reason, organization_id, customer_user_id, success, endpoint, method FROM lummet_audit_logs WHERE action = 'customer_session_revoke'`).all()).results;
  assert.equal(audit.length, 1); assert.equal(audit[0].reason, 'Laptop reported lost by the editor'); assert.equal(audit[0].organization_id, w.owner.organizationId);
  assert.equal(audit[0].customer_user_id, w.admin.userId); assert.equal(audit[0].success, 1); assert.equal(audit[0].method, 'POST');
});

test('revoking by userId ends every in-scope session of that member at once; other members are untouched', async () => {
  const e = env(); const w = await world(e);
  const second = await customerAuth.createSession(e, w.editor.userId, w.owner.organizationId);
  const rev = await call(e, 'POST', `${w.base}/sessions/revoke`, { userId: w.editor.userId, reason: 'Offboarding the editor today' }, w.owner.cookie);
  assert.equal(rev.status, 200, rev.text); assert.equal(rev.json.revoked, 2);
  assert.equal(await sessionRowCount(e, w.editor.sessionId), 0); assert.equal(await sessionRowCount(e, second.sessionId), 0);
  assert.equal((await call(e, 'GET', '/api/organizations', null, w.viewer.cookie)).status, 200, 'the viewer is untouched');
  assert.equal((await call(e, 'GET', '/api/organizations', null, w.admin.cookie)).status, 200);
});

test('revoke rules: reason required, own current session refused, admin cannot revoke an owner, unknown handle is 404, malformed body is 422', async () => {
  const e = env(); const w = await world(e);
  const mine = (await call(e, 'GET', `${w.base}/sessions`, null, w.admin.cookie)).json.data;
  const own = mine.find((s) => s.current === true);
  assert.ok(own && own.userId === w.admin.userId, 'the caller current session is marked current');
  const ownerSessionHandle = await sessions.sessionHandle(w.owner.userId, (await customerAuth.createSession(e, w.owner.userId, w.owner.organizationId)).sessionId);

  assert.equal((await call(e, 'POST', `${w.base}/sessions/revoke`, { handle: mine[0].handle }, w.admin.cookie)).status, 422, 'no reason');
  assert.equal((await call(e, 'POST', `${w.base}/sessions/revoke`, { handle: mine[0].handle, reason: 'abc' }, w.admin.cookie)).status, 422, 'reason too short');
  assert.equal((await call(e, 'POST', `${w.base}/sessions/revoke`, { reason: 'No target given at all' }, w.admin.cookie)).status, 422, 'no target');
  assert.equal((await call(e, 'POST', `${w.base}/sessions/revoke`, { handle: own.handle, reason: 'Trying to end my own' }, w.admin.cookie)).status, 409, 'own session: use logout');
  const o = await call(e, 'POST', `${w.base}/sessions/revoke`, { handle: ownerSessionHandle, reason: 'Admin tries to end an owner' }, w.admin.cookie);
  assert.equal(o.status, 403); assert.equal(o.json.error, 'cannot_revoke_owner_session');
  assert.equal((await call(e, 'POST', `${w.base}/sessions/revoke`, { handle: `${w.editor.userId}.deadbeefdeadbeefdeadbeef`, reason: 'A handle that matches nothing' }, w.admin.cookie)).status, 404);
  assert.equal((await call(e, 'POST', `${w.base}/sessions/revoke`, { handle: 12345, reason: 'Handle is not a string here' }, w.admin.cookie)).status, 422);
  const owner = await call(e, 'POST', `${w.base}/sessions/revoke`, { handle: ownerSessionHandle, reason: 'Owner ends their own other session' }, w.owner.cookie);
  assert.equal(owner.status, 200, 'an owner may revoke an owner session');
  const refused = (await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM lummet_audit_logs WHERE action = 'customer_session_revoke_refused'`).first()).n;
  assert.ok(refused >= 3, `refused attempts are audited too (${refused})`);
});

// ---------- Role gating ----------

test('ROLE GATE: only admin and owner may list or revoke; editor, viewer and billing get 403; no cookie is 401', async () => {
  const e = env(); const w = await world(e);
  for (const who of [w.editor, w.viewer, w.billing]) {
    assert.equal((await call(e, 'GET', `${w.base}/sessions`, null, who.cookie)).status, 403, `${who.role} list`);
    assert.equal((await call(e, 'POST', `${w.base}/sessions/revoke`, { userId: w.viewer.userId, reason: 'Role should block this' }, who.cookie)).status, 403, `${who.role} revoke`);
    assert.equal((await call(e, 'GET', `${w.base}/audit-log.csv`, null, who.cookie)).status, 403, `${who.role} csv`);
  }
  assert.equal((await call(e, 'GET', `${w.base}/sessions`)).status, 401);
  assert.equal((await call(e, 'GET', `${w.base}/audit-log.csv`)).status, 401);
  assert.equal((await call(e, 'GET', `${w.base}/sessions`, null, w.admin.cookie)).status, 200);
  assert.equal((await call(e, 'GET', `${w.base}/sessions`, null, w.owner.cookie)).status, 200);
  assert.equal(await sessionRowCount(e, w.viewer.sessionId), 1, 'the refused revokes changed nothing');
});

// ---------- Cross-organization access is impossible ----------

test('ACCEPTANCE: cross-organization access is impossible (list, revoke by handle, revoke by userId, CSV)', async () => {
  const e = env(); const a = await world(e);
  const b = await signup(e, 'owner-b@example.test');
  const bMember = await member(e, b, 'member-b@example.test', 'editor');
  const bBase = `/api/organizations/${b.organizationId}`;

  // The owner of A is not a member of B: every B route is refused, and the refusal does not reveal whether B exists.
  assert.equal((await call(e, 'GET', `${bBase}/sessions`, null, a.owner.cookie)).status, 403);
  assert.equal((await call(e, 'POST', `${bBase}/sessions/revoke`, { userId: bMember.userId, reason: 'Reaching into another org' }, a.owner.cookie)).status, 403);
  assert.equal((await call(e, 'GET', `${bBase}/audit-log.csv`, null, a.owner.cookie)).status, 403);

  // Using A's own route with B's person or B's handle finds nothing.
  const bHandle = await sessions.sessionHandle(bMember.userId, bMember.sessionId);
  const byHandle = await call(e, 'POST', `${a.base}/sessions/revoke`, { handle: bHandle, reason: 'Handle from another org' }, a.owner.cookie);
  assert.equal(byHandle.status, 404);
  const byUser = await call(e, 'POST', `${a.base}/sessions/revoke`, { userId: bMember.userId, reason: 'User from another org' }, a.owner.cookie);
  assert.equal(byUser.status, 404);
  assert.equal(await sessionRowCount(e, bMember.sessionId), 1, 'B session still stands');

  // A's list never shows B's people.
  const list = (await call(e, 'GET', `${a.base}/sessions`, null, a.owner.cookie)).json.data;
  assert.ok(!list.some((s) => s.userId === bMember.userId || s.userId === b.userId));

  // A person in BOTH organizations whose session is active in B is not visible to, or revocable by, A.
  const both = await member(e, a.owner, 'both@example.test', 'editor');
  await e.LUMMET_DB.prepare('INSERT INTO organization_users (organization_id, user_id, role) VALUES (?, ?, ?)').bind(b.organizationId, both.userId, 'viewer').run();
  const inB = await customerAuth.createSession(e, both.userId, b.organizationId);
  const aList = (await call(e, 'GET', `${a.base}/sessions`, null, a.owner.cookie)).json.data.filter((s) => s.userId === both.userId);
  assert.equal(aList.length, 1, 'only the session active in A is listed for A');
  const bList = (await call(e, 'GET', `${bBase}/sessions`, null, b.cookie)).json.data.filter((s) => s.userId === both.userId);
  assert.equal(bList.length, 1, 'only the session active in B is listed for B');
  const stray = await call(e, 'POST', `${a.base}/sessions/revoke`, { handle: await sessions.sessionHandle(both.userId, inB.sessionId), reason: 'Session that lives in B' }, a.owner.cookie);
  assert.equal(stray.status, 404, 'A cannot reach the session that is active in B');
  assert.equal(await sessionRowCount(e, inB.sessionId), 1);
  assert.equal(await sessionRowCount(e, both.sessionId), 1);

  // A removed member is no longer reachable either (membership is checked at query time).
  await e.LUMMET_DB.prepare('DELETE FROM organization_users WHERE organization_id = ? AND user_id = ?').bind(a.owner.organizationId, a.viewer.userId).run();
  assert.ok(!(await call(e, 'GET', `${a.base}/sessions`, null, a.owner.cookie)).json.data.some((s) => s.userId === a.viewer.userId));
});

// ---------- List shape, secrecy, pagination ----------

test('the list never contains a session id or cookie value, hides expired sessions, and is paginated by an opaque cursor', async () => {
  const e = env(); const w = await world(e);
  const extra = [];
  for (let i = 0; i < 4; i++) extra.push(await customerAuth.createSession(e, w.viewer.userId, w.owner.organizationId));
  await e.LUMMET_DB.prepare('INSERT INTO customer_sessions (id, user_id, active_organization_id, expires_at) VALUES (?, ?, ?, ?)')
    .bind('expired-session-id-0000', w.viewer.userId, w.owner.organizationId, new Date(Date.now() - 1000).toISOString()).run();

  const all = [];
  let cursor = null; let pages = 0;
  do {
    const r = await call(e, 'GET', `${w.base}/sessions?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, null, w.owner.cookie);
    assert.equal(r.status, 200, r.text); assert.ok(r.json.data.length <= 3);
    all.push(...r.json.data); cursor = r.json.nextCursor || null; pages++;
    assert.ok(pages < 10, 'cursor must terminate');
  } while (cursor);
  assert.ok(pages >= 2, 'more than one page was needed');
  const handles = all.map((s) => s.handle); assert.equal(new Set(handles).size, handles.length, 'no session repeated across pages');
  assert.equal(all.length, 4 + 5, 'four created here + the sign-up sessions of owner, and the admin, editor, billing and viewer sessions');
  assert.ok(!all.some((s) => /expired/i.test(JSON.stringify(s))), 'expired session is not listed');

  const raw = (await e.LUMMET_DB.prepare('SELECT id FROM customer_sessions').all()).results.map((r) => r.id);
  const body = JSON.stringify(all);
  for (const id of raw) assert.ok(!body.includes(id), 'no raw session id appears in the response');
  const one = all[0];
  assert.deepEqual(Object.keys(one).sort(), ['createdAt', 'current', 'email', 'expiresAt', 'fullName', 'handle', 'role', 'userId']);
  assert.equal((await call(e, 'GET', `${w.base}/sessions?limit=abc`, null, w.owner.cookie)).status, 200, 'a bad limit falls back to the default');
  assert.equal((await call(e, 'GET', `${w.base}/sessions?cursor=not-a-number`, null, w.owner.cookie)).status, 422);
  const big = await call(e, 'GET', `${w.base}/sessions?limit=100000`, null, w.owner.cookie);
  assert.equal(big.status, 200); assert.ok(big.json.data.length <= sessions.MAX_PAGE);
});

// ---------- Rollout flag ----------

test('FLAG: off (default) answers 404 on every new route and changes nothing; shadow lists but revoke is a dry run', async () => {
  const off = env({ CUSTOMER_SESSION_ADMIN: undefined, CUSTOMER_AUDIT_CSV: undefined }); const w = await world(off);
  assert.equal((await call(off, 'GET', `${w.base}/sessions`, null, w.owner.cookie)).status, 404);
  assert.equal((await call(off, 'POST', `${w.base}/sessions/revoke`, { userId: w.viewer.userId, reason: 'Flag is off here' }, w.owner.cookie)).status, 404);
  assert.equal((await call(off, 'GET', `${w.base}/audit-log.csv`, null, w.owner.cookie)).status, 404);
  assert.equal(sessions.sessionAdminMode({}), 'off'); assert.equal(sessions.sessionAdminMode({ CUSTOMER_SESSION_ADMIN: 'bogus' }), 'off');
  assert.equal(auditCsv.auditCsvMode({}), 'off'); assert.equal(auditCsv.auditCsvMode({ CUSTOMER_AUDIT_CSV: 'bogus' }), 'off');

  const sh = env({ CUSTOMER_SESSION_ADMIN: 'shadow' }); const s = await world(sh);
  assert.equal((await call(sh, 'GET', `${s.base}/sessions`, null, s.owner.cookie)).status, 200);
  const dry = await call(sh, 'POST', `${s.base}/sessions/revoke`, { userId: s.viewer.userId, reason: 'Shadow mode dry run' }, s.owner.cookie);
  assert.equal(dry.status, 200, dry.text); assert.equal(dry.json.revoked, 0); assert.equal(dry.json.wouldRevoke, 1); assert.equal(dry.json.shadow, true);
  assert.equal(await sessionRowCount(sh, s.viewer.sessionId), 1, 'shadow deletes nothing');
  assert.equal((await call(sh, 'GET', '/api/organizations', null, s.viewer.cookie)).status, 200);
  assert.equal((await sh.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM lummet_audit_logs WHERE action = 'customer_session_revoke_shadow'`).first()).n, 1);
});

test('revoke is still possible while the organization is suspended (it only removes access)', async () => {
  const e = env(); const w = await world(e);
  await e.LUMMET_DB.prepare(`UPDATE organizations SET status = 'suspended' WHERE id = ?`).bind(w.owner.organizationId).run();
  const rev = await call(e, 'POST', `${w.base}/sessions/revoke`, { userId: w.viewer.userId, reason: 'Contain the incident now' }, w.owner.cookie);
  assert.equal(rev.status, 200, rev.text); assert.equal(rev.json.revoked, 1);
});

// ---------- The reusable core (SCIM deprovision in 7.1C) ----------

test('REUSE: revokeAllSessionsForUser ends every session of a person, optionally keeps one, and audits as the given actor', async () => {
  const e = env(); const w = await world(e);
  const u = w.editor.userId;
  const other = await customerAuth.createSession(e, u, null);       // a session with no active organization
  const elsewhere = await signup(e, 'solo@example.test');
  const r = await sessions.revokeAllSessionsForUser(e, { userId: u, reason: 'scim deactivate', actorType: 'system', requestId: 'req-1' });
  assert.deepEqual([r.ok, r.revoked], [true, 3], 'sign-up session, organization session and the session with no organization');
  assert.equal(await sessionRowCount(e, w.editor.sessionId), 0); assert.equal(await sessionRowCount(e, other.sessionId), 0);
  assert.equal((await call(e, 'GET', '/api/organizations', null, elsewhere.cookie)).status, 200, 'an unrelated person is untouched');
  const row = await e.LUMMET_DB.prepare(`SELECT actor_type, reason, resource_id, request_id FROM lummet_audit_logs WHERE action = 'customer_sessions_revoke_user'`).first();
  assert.deepEqual([row.actor_type, row.reason, row.resource_id, row.request_id], ['system', 'scim deactivate', u, 'req-1']);

  const keep = await customerAuth.createSession(e, w.viewer.userId, w.owner.organizationId);
  const r2 = await sessions.revokeAllSessionsForUser(e, { userId: w.viewer.userId, reason: 'keep the current one', exceptSessionId: keep.sessionId, actorType: 'customer_user', actorId: w.owner.userId });
  assert.equal(r2.revoked, 2, 'sign-up session and organization session go; the kept one stays'); assert.equal(await sessionRowCount(e, keep.sessionId), 1);
  const r3 = await sessions.revokeAllSessionsForUser(e, { userId: u, reason: 'nothing left to revoke' });
  assert.deepEqual([r3.ok, r3.revoked], [true, 0], 'idempotent: a replay revokes nothing and still succeeds');
  const bad = await sessions.revokeAllSessionsForUser(e, { userId: '', reason: 'missing user' });
  assert.equal(bad.ok, false);
});

test('the opaque handle is stable, bound to the user, and does not contain the session id', async () => {
  const h1 = await sessions.sessionHandle('user-1', 'sess-secret-aaaaaaaa'); const h2 = await sessions.sessionHandle('user-1', 'sess-secret-aaaaaaaa');
  assert.equal(h1, h2); assert.ok(h1.startsWith('user-1.')); assert.ok(!h1.includes('sess-secret'));
  assert.notEqual(h1, await sessions.sessionHandle('user-1', 'sess-secret-bbbbbbbb'));
  assert.match(h1.split('.')[1], /^[0-9a-f]{24}$/);
});

// ---------- Audit-log CSV ----------

const csvPath = (w, q = '') => `${w.base}/audit-log.csv${q}`;
function parseCsv(text) {            // small RFC 4180 reader, enough to prove the output round-trips
  const rows = []; let row = []; let cell = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') inQ = false; else cell += c; }
    else if (c === '"') inQ = true; else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r') { /* skip */ } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
async function seed(e, organizationId, userId, n, extra = {}) {
  for (let i = 0; i < n; i++) await logAudit(e, { actorType: 'customer_user', customerUserId: userId, organizationId, endpoint: '/x', method: 'POST', resource: 'site', resourceId: `r${i}`, action: `act_${i}`, success: true, statusCode: 200, ...extra });
}

test('CSV: headers, content type, no-store, attachment filename; every row is in the caller organization; the export is itself audited', async () => {
  const e = env(); const w = await world(e); const b = await signup(e, 'other-org@example.test');
  await seed(e, w.owner.organizationId, w.owner.userId, 3); await seed(e, b.organizationId, b.userId, 5, { action: 'OTHER_ORG_SECRET_ACTION' });
  const r = await call(e, 'GET', csvPath(w), null, w.admin.cookie);
  assert.equal(r.status, 200, r.text);
  assert.match(r.headers.get('Content-Type'), /^text\/csv; charset=utf-8/); assert.equal(r.headers.get('Cache-Control'), 'no-store'); assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(r.headers.get('Content-Disposition'), /^attachment; filename="lummet-audit-log-[A-Za-z0-9-]+\.csv"$/);
  assert.ok(!r.text.includes('OTHER_ORG_SECRET_ACTION'), 'nothing from another organization');
  const rows = parseCsv(r.text);
  assert.deepEqual(rows[0], auditCsv.CSV_HEADERS);
  assert.ok(rows.length > 4, 'seeded rows are present');
  const orgIdx = rows[0].indexOf('organization_id'); assert.equal(orgIdx, -1, 'organization id is implied by the route and is not repeated per row');
  for (const banned of ['ip_hash', 'admin_id', 'tenant_id']) assert.ok(!rows[0].includes(banned), `${banned} is not exported`);
  assert.equal((await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM lummet_audit_logs WHERE action = 'audit_log_export_csv' AND organization_id = ? AND customer_user_id = ?`).bind(w.owner.organizationId, w.admin.userId).first()).n, 1, 'one audit row for the export');
});

test('ACCEPTANCE: CSV injection cases are neutralized, quotes and line breaks cannot break the row structure', async () => {
  const e = env(); const w = await world(e);
  const evil = ['=HYPERLINK("http://evil.test","x")', '+1+1', '-2+3', '@SUM(1+1)', '\t=cmd|\' /C calc\'!A0', ' =1+1', '\r=1+1', '\u0000=1+1', '=1+1\n=2+2', 'plain, with "quotes"', 'multi\nline\r\nvalue'];
  for (const v of evil) await logAudit(e, { actorType: 'customer_user', customerUserId: w.owner.userId, organizationId: w.owner.organizationId, endpoint: '/x', method: 'POST', resource: 'site', resourceId: v, action: 'inject', success: false, statusCode: 422, errorMessage: v, reason: v });
  const r = await call(e, 'GET', csvPath(w, '?limit=500'), null, w.owner.cookie);
  assert.equal(r.status, 200);
  const rows = parseCsv(r.text); const h = rows[0];
  const injected = rows.slice(1).filter((x) => x[h.indexOf('action')] === 'inject');
  assert.equal(injected.length, evil.length, 'every hostile row is exactly one CSV record');
  for (const rec of injected) {
    assert.equal(rec.length, h.length, 'column count is intact');
    for (const col of ['resource_id', 'error_message', 'reason']) {
      const cell = rec[h.indexOf(col)];
      assert.ok(!/^[\s\u0000-\u001f]*[=+\-@]/.test(cell), `${col} cell starts with a formula character: ${JSON.stringify(cell)}`);
    }
  }
  assert.ok(injected.some((rec) => rec[h.indexOf('error_message')] === `'=HYPERLINK("http://evil.test","x")`));
  assert.ok(injected.some((rec) => rec[h.indexOf('error_message')] === "'+1+1"));
  assert.ok(injected.some((rec) => rec[h.indexOf('error_message')] === 'plain, with "quotes"'), 'commas and quotes round-trip');
  assert.ok(!/\n(?!\r)/.test(r.text.replace(/\r\n/g, '')), 'no bare line break survives inside a cell');
});

test('csvCell unit cases (shared helper): formula starters, whitespace and control prefixes, numbers, null, quotes', () => {
  assert.equal(csvCell('=1+1'), `"'=1+1"`); assert.equal(csvCell('+1'), `"'+1"`); assert.equal(csvCell('-1'), `"'-1"`); assert.equal(csvCell('@A1'), `"'@A1"`);
  assert.equal(csvCell('\t=1'), `"'\t=1"`); assert.equal(csvCell('  =1'), `"'  =1"`); assert.equal(csvCell('\u0001@x'), `"'\u0001@x"`);
  assert.equal(csvCell('a=b'), '"a=b"'); assert.equal(csvCell(null), '""'); assert.equal(csvCell(undefined), '""'); assert.equal(csvCell(42), '"42"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""'); assert.equal(csvCell('a\nb\r\nc'), '"a b  c"');
});

test('CSV pagination: pages are disjoint, ordered newest first, complete, and the cursor is a plain id; bad cursor is 422; limit is clamped', async () => {
  const e = env(); const w = await world(e);
  await seed(e, w.owner.organizationId, w.owner.userId, 25);
  const seen = []; let cursor = null; let pages = 0;
  do {
    const r = await call(e, 'GET', csvPath(w, `?limit=10${cursor ? `&cursor=${cursor}` : ''}`), null, w.owner.cookie);
    assert.equal(r.status, 200, r.text);
    const rows = parseCsv(r.text); const idIdx = rows[0].indexOf('id');
    for (const rec of rows.slice(1)) seen.push(Number(rec[idIdx]));
    cursor = r.headers.get('X-Next-Cursor'); pages++;
    assert.equal(r.headers.get('X-Has-More'), cursor ? 'true' : 'false');
    assert.ok(pages < 20);
  } while (cursor);
  assert.ok(pages >= 3);
  assert.equal(new Set(seen).size, seen.length, 'no row twice');
  assert.deepEqual([...seen].sort((a, b) => b - a), seen, 'strictly newest first across pages');
  const dbCount = (await e.LUMMET_DB.prepare('SELECT COUNT(*) n FROM lummet_audit_logs WHERE organization_id = ? AND action != ?').bind(w.owner.organizationId, 'audit_log_export_csv').first()).n;
  assert.ok(seen.length >= dbCount, 'every pre-existing row was exported (export rows themselves may appear on later pages)');
  assert.equal((await call(e, 'GET', csvPath(w, '?cursor=1;DROP'), null, w.owner.cookie)).status, 422);
  assert.equal((await call(e, 'GET', csvPath(w, '?cursor=-5'), null, w.owner.cookie)).status, 422);
  const huge = await call(e, 'GET', csvPath(w, '?limit=99999999'), null, w.owner.cookie);
  assert.equal(huge.status, 200); assert.ok(parseCsv(huge.text).length - 1 <= auditCsv.MAX_ROWS);
  const zero = await call(e, 'GET', csvPath(w, '?limit=0'), null, w.owner.cookie);
  assert.equal(zero.status, 200); assert.ok(parseCsv(zero.text).length - 1 >= 1, 'limit 0 falls back to the default, not an empty file');
});

test('CSV is dark and audited correctly when refused: a non-admin attempt writes a refusal audit row and no data', async () => {
  const e = env(); const w = await world(e);
  await seed(e, w.owner.organizationId, w.owner.userId, 2, { action: 'VISIBLE_ONLY_TO_ADMINS' });
  const r = await call(e, 'GET', csvPath(w), null, w.editor.cookie);
  assert.equal(r.status, 403); assert.ok(!r.text.includes('VISIBLE_ONLY_TO_ADMINS'));
  assert.equal((await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM lummet_audit_logs WHERE action = 'audit_log_export_csv_refused' AND customer_user_id = ?`).bind(w.editor.userId).first()).n, 1);
});

test('the existing JSON audit-log route is unchanged and still org-scoped', async () => {
  const e = env(); const w = await world(e); const b = await signup(e, 'other2@example.test');
  await seed(e, w.owner.organizationId, w.owner.userId, 2); await seed(e, b.organizationId, b.userId, 2, { action: 'B_ONLY' });
  const r = await call(e, 'GET', `${w.base}/audit-log`, null, w.owner.cookie);
  assert.equal(r.status, 200); assert.ok(Array.isArray(r.json.data)); assert.ok(!r.text.includes('B_ONLY'));
  assert.equal((await call(e, 'GET', `${w.base}/audit-log`, null, w.editor.cookie)).status, 403);
});

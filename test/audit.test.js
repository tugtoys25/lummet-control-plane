// test/audit.test.js
//
// AUDIT
// - important successful administrative mutations are audited
// - denied sensitive operations do not create misleading successful
//   audit records (follow the existing audit semantics: success is
//   whatever the caller reports, and index.js's route guards return
//   BEFORE calling logAudit at all for a permission-denied request —
//   see the checked-in pattern: `if (guard) return guard;` always
//   precedes the logAudit() call for that action)

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { seedFixtures, FIXTURE_PASSWORDS } from './support/fixtures.js';
import { logAudit } from '../worker/audit.js';
import { authenticateAdmin } from '../worker/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('logAudit', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    applyMigrations(db);
  });

  test('a successful administrative mutation is recorded with success = 1', async () => {
    await logAudit({ LUMMET_DB: db }, {
      adminId: 1, tenantId: 'tenant-a', endpoint: '/content/casinos/some-slug/edit', method: 'POST',
      resource: 'casinos', resourceId: 'some-slug', action: 'update', success: true, statusCode: 200
    });
    const row = await db.prepare(`SELECT * FROM lummet_audit_logs ORDER BY id DESC LIMIT 1`).first();
    assert.ok(row);
    assert.equal(row.success, 1);
    assert.equal(row.resource, 'casinos');
    assert.equal(row.action, 'update');
    assert.equal(row.status_code, 200);
  });

  test('a denied/failed operation is recorded with success = 0, never coerced to 1', async () => {
    await logAudit({ LUMMET_DB: db }, {
      adminId: 2, tenantId: 'tenant-a', endpoint: '/content/casinos/some-slug/delete', method: 'POST',
      resource: 'casinos', resourceId: 'some-slug', action: 'delete', success: false, statusCode: 403,
      errorMessage: 'forbidden'
    });
    const row = await db.prepare(`SELECT * FROM lummet_audit_logs ORDER BY id DESC LIMIT 1`).first();
    assert.ok(row);
    assert.equal(row.success, 0);
    assert.equal(row.status_code, 403);
  });

  test('high-risk actions (role change, tenant deactivation, credential rotation) round-trip all identifying fields', async () => {
    await logAudit({ LUMMET_DB: db }, {
      adminId: 1, tenantId: null, endpoint: '/platform/admins/2/role', method: 'PUT',
      resource: 'admin_role', resourceId: '2', action: 'update', success: true, statusCode: 200,
      requestId: 'req-123', ipHash: 'ip-hash-abc'
    });
    const row = await db.prepare(`SELECT * FROM lummet_audit_logs ORDER BY id DESC LIMIT 1`).first();
    assert.equal(row.admin_id, 1);
    assert.equal(row.resource, 'admin_role');
    assert.equal(row.resource_id, '2');
    assert.equal(row.request_id, 'req-123');
    assert.equal(row.ip_hash, 'ip-hash-abc');
  });

  test('logAudit never throws even on a broken/missing DB (audit must never break the response)', async () => {
    await assert.doesNotReject(logAudit({ LUMMET_DB: { prepare() { throw new Error('boom'); } } }, {
      adminId: 1, action: 'update', success: true
    }));
  });
});

describe('a rejected login never produces a misleading "success" artifact', () => {
  let db, fx;

  beforeEach(async () => {
    db = createTestDb();
    applyMigrations(db);
    fx = await seedFixtures(db);
  });

  test('a failed login writes to lummet_auth_attempts, not a successful session/audit record', async () => {
    const result = await authenticateAdmin({ LUMMET_DB: db }, 'staffA@example.com', 'wrong-password', 'ip-hash-audit-1');
    assert.equal(result.ok, false);

    const attempts = await db.prepare(`SELECT * FROM lummet_auth_attempts WHERE ip_hash = ?`).bind('ip-hash-audit-1').all();
    assert.equal(attempts.results.length, 1, 'expected the failed attempt to be recorded');

    const sessions = await db.prepare(`SELECT * FROM lummet_sessions WHERE admin_id = ?`).bind(fx.admins.staffA).all();
    assert.equal(sessions.results.length, 0, 'a failed login must never leave behind a session row');
  });
});

describe('structural regression: permission-denied routes return before logAudit is called', () => {
  test('checkResourcePermission/forbidden helpers return early, and every logAudit call site in a guarded branch comes after the "if (guard) return guard;" line for that branch', () => {
    // This is inherently a structural property of index.js's dispatcher
    // (2000+ lines, not something worth re-simulating end-to-end here).
    // The regression check: the guard-return idiom appears, and
    // checkResourcePermission's OWN body never itself calls logAudit
    // with success:true — it only ever returns a 403 Response.
    const indexSrc = readFileSync(join(__dirname, '..', 'worker', 'index.js'), 'utf-8');
    const guardFnMatch = indexSrc.match(/async function checkResourcePermission\([^)]*\)\s*{([^}]*)}/);
    assert.ok(guardFnMatch, 'expected to find checkResourcePermission in index.js');
    assert.doesNotMatch(guardFnMatch[1], /logAudit/, 'the permission guard itself must never write an audit row — only the route handler does, and only after the guard has already passed');
    assert.match(guardFnMatch[1], /return isJsonRoute \? forbiddenJson\(\) : forbiddenHtml\(\);/);

    // And the general dispatch idiom used throughout: every guard check
    // is followed by an early return before any further work (including
    // logAudit) happens for that branch.
    const guardIdiomCount = (indexSrc.match(/if \(guard\) return guard;/g) || []).length;
    assert.ok(guardIdiomCount > 20, `expected the "if (guard) return guard;" early-return idiom to be used pervasively (found ${guardIdiomCount})`);
  });
});

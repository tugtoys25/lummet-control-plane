// test/auth-password.test.js
//
// AUTHENTICATION
// - correct password succeeds
// - incorrect password fails
// - malformed credentials fail safely
// - password comparison uses the intended constant-time path

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { seedFixtures, FIXTURE_PASSWORDS } from './support/fixtures.js';
import {
  hashPassword,
  verifyPassword,
  authenticateAdmin,
  constantTimeEqual
} from '../worker/auth.js';

describe('hashPassword / verifyPassword (PBKDF2 scheme unchanged)', () => {
  test('correct password verifies successfully', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    assert.equal(await verifyPassword('correct-horse-battery-staple', hash), true);
  });

  test('incorrect password fails', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    assert.equal(await verifyPassword('wrong-password', hash), false);
  });

  test('hash format is unchanged: "<saltHex>:<hashHex>", PBKDF2-SHA256', async () => {
    const hash = await hashPassword('anything');
    const parts = hash.split(':');
    assert.equal(parts.length, 2);
    assert.match(parts[0], /^[0-9a-f]{32}$/); // 16-byte salt, hex
    assert.match(parts[1], /^[0-9a-f]{64}$/); // 256-bit derived key, hex
  });

  test('malformed stored hash (missing colon) fails safely, does not throw', async () => {
    assert.equal(await verifyPassword('anything', 'not-a-valid-hash'), false);
  });

  test('malformed stored hash (empty string) fails safely, does not throw', async () => {
    assert.equal(await verifyPassword('anything', ''), false);
  });

  test('malformed stored hash (null) fails safely, does not throw', async () => {
    assert.equal(await verifyPassword('anything', null), false);
  });

  test('malformed stored hash (non-hex garbage after colon) fails safely, does not throw', async () => {
    assert.equal(await verifyPassword('anything', 'zzzz:zzzz'), false);
  });
});

describe('constantTimeEqual (helper behavior, tested directly — no production hook involved)', () => {
  test('equal strings compare true', () => {
    assert.equal(constantTimeEqual('abc123', 'abc123'), true);
  });

  test('different strings of the same length compare false', () => {
    assert.equal(constantTimeEqual('abc123', 'abc124'), false);
  });

  test('different-length strings compare false without throwing', () => {
    assert.equal(constantTimeEqual('short', 'a-lot-longer-string'), false);
  });

  test('non-string inputs compare false without throwing', () => {
    assert.equal(constantTimeEqual(undefined, 'abc'), false);
    assert.equal(constantTimeEqual('abc', undefined), false);
    assert.equal(constantTimeEqual(null, null), false);
  });
});

describe('verifyPassword — observable security behavior of the real comparison path', () => {
  // These exercise verifyPassword() itself (never the helper directly),
  // so they pass or fail based only on production behavior — there is
  // no test-only hook in the call path being verified here.

  test('correct password still verifies successfully through the real path', async () => {
    const hash = await hashPassword('probe-password');
    assert.equal(await verifyPassword('probe-password', hash), true);
  });

  test('a stored hash whose hex portion is a different length than the computed hash fails safely (exercises the comparison\'s length-mismatch branch via the real call path, not just the helper in isolation)', async () => {
    const hash = await hashPassword('probe-password');
    const [saltHex, hashHex] = hash.split(':');
    const truncated = `${saltHex}:${hashHex.slice(0, 20)}`; // valid salt, wrong-length digest
    assert.equal(await verifyPassword('probe-password', truncated), false);
  });

  test('a stored hash of the correct length but wrong content fails (same-length branch via the real call path)', async () => {
    const hash = await hashPassword('probe-password');
    const [saltHex, hashHex] = hash.split(':');
    const flippedLastChar = hashHex.slice(0, -1) + (hashHex.at(-1) === '0' ? '1' : '0');
    assert.equal(await verifyPassword('probe-password', `${saltHex}:${flippedLastChar}`), false);
  });
});

describe('authenticateAdmin (full login flow)', () => {
  let db, fx;

  beforeEach(async () => {
    db = createTestDb();
    applyMigrations(db);
    fx = await seedFixtures(db);
  });

  const env = () => ({ LUMMET_DB: db });

  test('correct email + password succeeds and creates a session', async () => {
    const result = await authenticateAdmin(env(), 'staffA@example.com', FIXTURE_PASSWORDS.staffA, 'ip-hash-1');
    assert.equal(result.ok, true);
    assert.ok(result.sessionId);
    const session = await db.prepare(`SELECT * FROM lummet_sessions WHERE id = ?`).bind(result.sessionId).first();
    assert.ok(session, 'expected a session row to be created on success');
    assert.equal(session.admin_id, fx.admins.staffA);
  });

  test('correct email + wrong password fails, no session created', async () => {
    const result = await authenticateAdmin(env(), 'staffA@example.com', 'totally-wrong', 'ip-hash-2');
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    const sessions = await db.prepare(`SELECT * FROM lummet_sessions WHERE admin_id = ?`).bind(fx.admins.staffA).all();
    assert.equal(sessions.results.length, 0);
  });

  test('unknown email fails with the same generic error as wrong password (no user enumeration)', async () => {
    const result = await authenticateAdmin(env(), 'nobody@example.com', 'whatever', 'ip-hash-3');
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(result.error, 'invalid_credentials');
  });

  test('malformed credentials (empty email/password) fail safely with 400, not a crash', async () => {
    assert.equal((await authenticateAdmin(env(), '', '', 'ip-hash-4')).status, 400);
    assert.equal((await authenticateAdmin(env(), 'staffA@example.com', '', 'ip-hash-4')).status, 400);
    assert.equal((await authenticateAdmin(env(), '', 'somepassword', 'ip-hash-4')).status, 400);
  });

  test('disabled admin account is rejected even with the correct password', async () => {
    const result = await authenticateAdmin(env(), 'disabledAdmin@example.com', FIXTURE_PASSWORDS.disabledAdmin, 'ip-hash-5');
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(result.error, 'account_disabled');
  });

  test('repeated failed logins from the same IP are rate-limited (5 per 15 min)', async () => {
    const ipHash = 'ip-hash-ratelimit';
    for (let i = 0; i < 5; i++) {
      const r = await authenticateAdmin(env(), 'staffA@example.com', 'wrong', ipHash);
      assert.equal(r.status, 401, `attempt ${i + 1} should be a plain auth failure`);
    }
    const sixth = await authenticateAdmin(env(), 'staffA@example.com', 'wrong', ipHash);
    assert.equal(sixth.status, 429, '6th attempt within the window should be rate-limited');

    // Rate limiting is applied even to a CORRECT password once the IP has
    // exhausted attempts — otherwise it would be a pure enumeration/lockout
    // bypass, not a real defense.
    const withCorrectPassword = await authenticateAdmin(env(), 'staffA@example.com', FIXTURE_PASSWORDS.staffA, ipHash);
    assert.equal(withCorrectPassword.status, 429);
  });
});

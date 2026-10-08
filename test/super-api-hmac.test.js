// test/super-api-hmac.test.js
//
// SUPER API
// - valid HMAC request succeeds
// - invalid signature fails
// - expired timestamp fails
// - nonce replay fails
// - body/path/method alteration invalidates the signature
// - tenant credentials are not exposed to browser responses
//
// This exercises the control plane's REAL signer (worker/signing.js's
// buildSuperApiHeaders) against the tenant's REAL verifier
// (lummet-tenant/en/worker/super/auth.js's verifySuperApiRequest) —
// proving wire compatibility end-to-end, not just that each side's
// own algorithm is internally consistent.
//
// This assumes both repositories are checked out as sibling
// directories (as they were provided for this task: .../lummet-control-plane
// and .../lummet-tenant side by side). If the sibling tenant repo
// isn't present in a given environment, these tests report SKIPPED
// rather than failing the whole suite — everything else in this
// directory has no such dependency.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildSuperApiHeaders } from '../worker/signing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TENANT_AUTH_PATH = join(__dirname, '..', '..', 'lummet-tenant', 'en', 'worker', 'super', 'auth.js');
const TENANT_REPO_AVAILABLE = existsSync(TENANT_AUTH_PATH);

// Mirrors migration 0017_super_api.sql (super_api_nonces,
// super_api_rate_limits) exactly — the two tables verifySuperApiRequest
// reads/writes. Not the tenant's full schema; only what this
// function touches.
function createFakeTenantDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE super_api_nonces (
      nonce TEXT NOT NULL, credential_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (credential_id, nonce)
    );
    CREATE TABLE super_api_rate_limits (
      credential_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (credential_id, created_at)
    );
  `);
  return {
    prepare(sql) {
      return {
        bind(...params) {
          const stmt = db.prepare(sql);
          const bound = params.map(p => (p === undefined ? null : p));
          return {
            async all() { return { results: stmt.all(...bound), success: true }; },
            async first() { const row = stmt.get(...bound); return row === undefined ? null : row; },
            async run() { const r = stmt.run(...bound); return { success: true, meta: { changes: r.changes } }; }
          };
        }
      };
    }
  };
}

const CREDENTIAL_ID = 'cred_test_001';
const SECRET = 'test-shared-hmac-secret-value';

function fakeTenantRequest({ method, path, headers }) {
  const map = new Map(Object.entries(headers));
  return {
    method,
    headers: { get: (name) => map.get(name) ?? null }
  };
}

describe('Super API HMAC — real signer vs real tenant verifier', { skip: !TENANT_REPO_AVAILABLE && 'sibling lummet-tenant repo not found next to this repo' }, () => {
  let verifySuperApiRequest;
  let db;
  let tenantEnv;

  beforeEach(async () => {
    if (!TENANT_REPO_AVAILABLE) return;
    ({ verifySuperApiRequest } = await import(TENANT_AUTH_PATH));
    db = createFakeTenantDb();
    tenantEnv = { DB: db, SUPER_API_CREDENTIAL_ID: CREDENTIAL_ID, SUPER_API_SECRET: SECRET };
  });

  test('a validly-signed request succeeds', async () => {
    const path = '/en/api/super/casinos';
    const bodyText = '';
    const headers = await buildSuperApiHeaders({ credentialId: CREDENTIAL_ID, secret: SECRET, method: 'GET', path, bodyText });
    const request = fakeTenantRequest({ method: 'GET', path, headers });
    const result = await verifySuperApiRequest(request, tenantEnv, path, bodyText);
    assert.equal(result.ok, true);
    assert.equal(result.credentialId, CREDENTIAL_ID);
  });

  test('a validly-signed POST with a real body succeeds', async () => {
    const path = '/en/api/super/casinos';
    const bodyText = JSON.stringify({ name: 'Test Casino', slug: 'test-casino' });
    const headers = await buildSuperApiHeaders({ credentialId: CREDENTIAL_ID, secret: SECRET, method: 'POST', path, bodyText });
    const request = fakeTenantRequest({ method: 'POST', path, headers });
    const result = await verifySuperApiRequest(request, tenantEnv, path, bodyText);
    assert.equal(result.ok, true);
  });

  test('an invalid signature is rejected', async () => {
    const path = '/en/api/super/casinos';
    const bodyText = '';
    const headers = await buildSuperApiHeaders({ credentialId: CREDENTIAL_ID, secret: SECRET, method: 'GET', path, bodyText });
    headers['X-Lummet-Signature'] = 'deadbeef'.repeat(8); // same length family, wrong value
    const request = fakeTenantRequest({ method: 'GET', path, headers });
    const result = await verifySuperApiRequest(request, tenantEnv, path, bodyText);
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(result.reason, 'bad_signature');
  });

  test('signing with the WRONG secret produces a request the tenant rejects', async () => {
    const path = '/en/api/super/casinos';
    const bodyText = '';
    const headers = await buildSuperApiHeaders({ credentialId: CREDENTIAL_ID, secret: 'not-the-real-secret', method: 'GET', path, bodyText });
    const request = fakeTenantRequest({ method: 'GET', path, headers });
    const result = await verifySuperApiRequest(request, tenantEnv, path, bodyText);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'bad_signature');
  });

  test('an expired timestamp fails, even with an otherwise-correct signature', async () => {
    // Build headers, then hand-roll a stale timestamp signed the same way
    // buildSuperApiHeaders would, 10 minutes old (outside the 5-minute window).
    const path = '/en/api/super/casinos';
    const bodyText = '';
    const staleTimestamp = Date.now() - 10 * 60 * 1000;
    const nonce = 'a'.repeat(32);
    const encoder = new TextEncoder();
    const bodyHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(bodyText)))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    const canonical = ['GET', path, String(staleTimestamp), nonce, bodyHash].join('\n');
    const key = await crypto.subtle.importKey('raw', encoder.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sigBuf = await crypto.subtle.sign('HMAC', key, encoder.encode(canonical));
    const signature = [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2, '0')).join('');

    const headers = {
      Authorization: `Bearer ${CREDENTIAL_ID}`,
      'X-Lummet-Timestamp': String(staleTimestamp),
      'X-Lummet-Nonce': nonce,
      'X-Lummet-Signature': signature
    };
    const request = fakeTenantRequest({ method: 'GET', path, headers });
    const result = await verifySuperApiRequest(request, tenantEnv, path, bodyText);
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(result.reason, 'stale_timestamp');
  });

  test('nonce replay is rejected on the second use of the same signed request', async () => {
    const path = '/en/api/super/casinos';
    const bodyText = '';
    const headers = await buildSuperApiHeaders({ credentialId: CREDENTIAL_ID, secret: SECRET, method: 'GET', path, bodyText });

    const first = await verifySuperApiRequest(fakeTenantRequest({ method: 'GET', path, headers }), tenantEnv, path, bodyText);
    assert.equal(first.ok, true, 'first use of the nonce should succeed');

    const replay = await verifySuperApiRequest(fakeTenantRequest({ method: 'GET', path, headers }), tenantEnv, path, bodyText);
    assert.equal(replay.ok, false);
    assert.equal(replay.status, 401);
    assert.equal(replay.reason, 'replayed_nonce');
  });

  test('altering the body after signing invalidates the signature', async () => {
    const path = '/en/api/super/casinos';
    const signedBody = JSON.stringify({ name: 'Original' });
    const tamperedBody = JSON.stringify({ name: 'Tampered' });
    const headers = await buildSuperApiHeaders({ credentialId: CREDENTIAL_ID, secret: SECRET, method: 'POST', path, bodyText: signedBody });
    const request = fakeTenantRequest({ method: 'POST', path, headers });
    const result = await verifySuperApiRequest(request, tenantEnv, path, tamperedBody);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'bad_signature');
  });

  test('altering the path after signing invalidates the signature', async () => {
    const signedPath = '/en/api/super/casinos';
    const requestedPath = '/en/api/super/users'; // e.g. an attacker replaying a casinos-scoped signature against a different route
    const bodyText = '';
    const headers = await buildSuperApiHeaders({ credentialId: CREDENTIAL_ID, secret: SECRET, method: 'GET', path: signedPath, bodyText });
    const request = fakeTenantRequest({ method: 'GET', path: requestedPath, headers });
    const result = await verifySuperApiRequest(request, tenantEnv, requestedPath, bodyText);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'bad_signature');
  });

  test('altering the method after signing invalidates the signature', async () => {
    const path = '/en/api/super/casinos/some-slug';
    const bodyText = '';
    const headers = await buildSuperApiHeaders({ credentialId: CREDENTIAL_ID, secret: SECRET, method: 'GET', path, bodyText });
    const request = fakeTenantRequest({ method: 'DELETE', path, headers }); // signed as GET, replayed as DELETE
    const result = await verifySuperApiRequest(request, tenantEnv, path, bodyText);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'bad_signature');
  });

  test('an unknown credential id is rejected before signature verification even runs', async () => {
    const path = '/en/api/super/casinos';
    const bodyText = '';
    const headers = await buildSuperApiHeaders({ credentialId: 'cred_someone_elses', secret: SECRET, method: 'GET', path, bodyText });
    const request = fakeTenantRequest({ method: 'GET', path, headers });
    const result = await verifySuperApiRequest(request, tenantEnv, path, bodyText);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unknown_credential');
  });

  test('missing signature headers are rejected safely, not treated as an empty-but-valid signature', async () => {
    const path = '/en/api/super/casinos';
    const request = fakeTenantRequest({ method: 'GET', path, headers: { Authorization: `Bearer ${CREDENTIAL_ID}` } });
    const result = await verifySuperApiRequest(request, tenantEnv, path, '');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing_credentials');
  });
});

describe('tenant credentials are never exposed to browser responses', () => {
  test('the credentials list page query selects only non-secret columns', async () => {
    // Static check on the exact SQL used by renderCredentialsPage
    // (views/pages/platform.js): it must never select
    // encrypted_secret or secret_iv.
    const { readFileSync } = await import('node:fs');
    const platformSrc = readFileSync(join(__dirname, '..', 'worker', 'views', 'pages', 'platform.js'), 'utf-8');
    const queryMatch = platformSrc.match(/SELECT c\.credential_id[^`]*FROM tenant_api_credentials/s);
    assert.ok(queryMatch, 'expected to find the credentials list query');
    assert.doesNotMatch(queryMatch[0], /encrypted_secret/);
    assert.doesNotMatch(queryMatch[0], /secret_iv/);
  });

  test('renderCredentialsPage never emits the secret material into its HTML output', async () => {
    const { createTestDb, applyMigrations } = await import('./support/d1-shim.js');
    const { seedFixtures } = await import('./support/fixtures.js');
    const { renderCredentialsPage } = await import('../worker/views/pages/platform.js');

    const db = createTestDb();
    applyMigrations(db);
    await seedFixtures(db);
    const env = { LUMMET_DB: db };

    const admin = await db.prepare(`SELECT * FROM lummet_admins WHERE role = 'super_admin'`).first();
    const html = await renderCredentialsPage(env, { ...admin, activeTenantId: null });

    assert.doesNotMatch(html, /ENCRYPTED_SECRET_SHOULD_NEVER_LEAK/);
    assert.doesNotMatch(html, /fake_iv_should_never_leak/);
    // Sanity: the page did render real data (proves this isn't a
    // false negative from an empty/broken query).
    assert.match(html, /cred_tenant_a_001/);
  });
});

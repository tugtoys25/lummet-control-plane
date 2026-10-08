// test/totp.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';

import * as totp from '../worker/totp.js';
import * as customerAuth from '../worker/customer-auth.js';

function makeTestKek() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString('base64');
}

function makeEnv() {
  const db = createTestDb();
  applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: makeTestKek() };
}

function fakeSignupRequest(email) {
  return {
    async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org' }; },
    headers: { get: () => '203.0.113.100' }
  };
}

// -----------------------------------------------------
// Core TOTP algorithm
// -----------------------------------------------------

test('generateTotpCode/verifyTotpCode round-trip, and reject a wrong code', async () => {
  const secret = totp.generateBase32Secret();
  const code = await totp.generateTotpCode(secret);
  assert.match(code, /^\d{6}$/);
  assert.equal(await totp.verifyTotpCode(secret, code), true);

  const wrongCode = code === '000000' ? '111111' : '000000';
  assert.equal(await totp.verifyTotpCode(secret, wrongCode), false);
});

test('verifyTotpCode tolerates a small clock drift but not a large one', async () => {
  const secret = totp.generateBase32Secret();
  const now = Date.now();
  const code = await totp.generateTotpCode(secret, now);

  assert.equal(await totp.verifyTotpCode(secret, code, now + 25 * 1000), true, 'within one 30s step should still verify');
  assert.equal(await totp.verifyTotpCode(secret, code, now + 10 * 60 * 1000), false, '10 minutes off must not verify');
});

test('verifyTotpCode rejects malformed input without throwing', async () => {
  const secret = totp.generateBase32Secret();
  assert.equal(await totp.verifyTotpCode(secret, ''), false);
  assert.equal(await totp.verifyTotpCode(secret, 'abcdef'), false);
  assert.equal(await totp.verifyTotpCode(secret, null), false);
});

// -----------------------------------------------------
// Setup / confirm / disable service
// -----------------------------------------------------

test('startTotpSetup then confirmTotpSetup with the real generated code enables 2FA and issues backup codes', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('totp-setup@example.com'), env);

  const setup = await totp.startTotpSetup(env, signup.userId);
  assert.equal(setup.ok, true);
  assert.ok(setup.otpauthUrl.startsWith('otpauth://totp/'));

  const statusBefore = await totp.getTotpStatus(env, signup.userId);
  assert.equal(statusBefore.enabled, false, 'must not be enabled until confirmed');

  const realCode = await totp.generateTotpCode(setup.secret);
  const confirmed = await totp.confirmTotpSetup(env, signup.userId, realCode);
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.backupCodes.length, 8);

  const statusAfter = await totp.getTotpStatus(env, signup.userId);
  assert.equal(statusAfter.enabled, true);
});

test('confirmTotpSetup rejects a wrong code and leaves 2FA disabled', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('totp-wrong-confirm@example.com'), env);
  await totp.startTotpSetup(env, signup.userId);

  const result = await totp.confirmTotpSetup(env, signup.userId, '000000');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_code');
  assert.equal((await totp.getTotpStatus(env, signup.userId)).enabled, false);
});

test('disableTotp requires a valid code or backup code, and a used backup code cannot be reused', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('totp-disable@example.com'), env);
  const setup = await totp.startTotpSetup(env, signup.userId);
  const confirmed = await totp.confirmTotpSetup(env, signup.userId, await totp.generateTotpCode(setup.secret));

  const wrongAttempt = await totp.disableTotp(env, signup.userId, { code: '000000' });
  assert.equal(wrongAttempt.ok, false);
  assert.equal((await totp.getTotpStatus(env, signup.userId)).enabled, true, 'a failed disable attempt must not disable it');

  const usedBackupCode = confirmed.backupCodes[0];
  const loginCheck = await totp.verifyFactorForLogin(env, signup.userId, { backupCode: usedBackupCode });
  assert.equal(loginCheck.ok, true);
  const reuseAttempt = await totp.verifyFactorForLogin(env, signup.userId, { backupCode: usedBackupCode });
  assert.equal(reuseAttempt.ok, false, 'a backup code must be single-use');

  const disableWithCode = await totp.disableTotp(env, signup.userId, { code: await totp.generateTotpCode(setup.secret) });
  assert.equal(disableWithCode.ok, true);
  assert.equal((await totp.getTotpStatus(env, signup.userId)).enabled, false);
});

// -----------------------------------------------------
// Login integration
// -----------------------------------------------------

test('login for a user WITHOUT 2FA issues a session immediately, exactly as before', async () => {
  const env = makeEnv();
  await customerAuth.signUp(fakeSignupRequest('no-2fa@example.com'), env);

  const result = await customerAuth.login(
    { async json() { return { email: 'no-2fa@example.com', password: 'correct-horse-battery' }; }, headers: { get: () => '203.0.113.101' } },
    env
  );
  assert.equal(result.ok, true);
  assert.equal(result.mfaRequired, undefined);
  assert.ok(result.cookie.includes('lummet_customer_session='));
});

test('login for a user WITH active 2FA returns a challenge instead of a session, and completeMfaLogin finishes it', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('has-2fa@example.com'), env);
  const setup = await totp.startTotpSetup(env, signup.userId);
  await totp.confirmTotpSetup(env, signup.userId, await totp.generateTotpCode(setup.secret));

  const loginResult = await customerAuth.login(
    { async json() { return { email: 'has-2fa@example.com', password: 'correct-horse-battery' }; }, headers: { get: () => '203.0.113.102' } },
    env
  );
  assert.equal(loginResult.ok, true);
  assert.equal(loginResult.mfaRequired, true);
  assert.ok(loginResult.challengeId);
  assert.equal(loginResult.cookie, undefined, 'no session cookie until the MFA step completes');

  const wrongCode = await customerAuth.completeMfaLogin(env, loginResult.challengeId, { code: '000000' });
  assert.equal(wrongCode.ok, false);

  const rightCode = await customerAuth.completeMfaLogin(env, loginResult.challengeId, { code: await totp.generateTotpCode(setup.secret) });
  assert.equal(rightCode.ok, true);
  assert.ok(rightCode.cookie.includes('lummet_customer_session='));

  const reuse = await customerAuth.completeMfaLogin(env, loginResult.challengeId, { code: await totp.generateTotpCode(setup.secret) });
  assert.equal(reuse.ok, false);
  assert.equal(reuse.error, 'invalid_challenge');
});

test('completeMfaLogin rejects an expired challenge', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('expired-challenge@example.com'), env);
  const setup = await totp.startTotpSetup(env, signup.userId);
  await totp.confirmTotpSetup(env, signup.userId, await totp.generateTotpCode(setup.secret));

  const loginResult = await customerAuth.login(
    { async json() { return { email: 'expired-challenge@example.com', password: 'correct-horse-battery' }; }, headers: { get: () => '203.0.113.103' } },
    env
  );

  await env.LUMMET_DB.prepare(`UPDATE customer_mfa_challenges SET expires_at = ? WHERE id = ?`)
    .bind(new Date(Date.now() - 1000).toISOString(), loginResult.challengeId)
    .run();

  const result = await customerAuth.completeMfaLogin(env, loginResult.challengeId, { code: await totp.generateTotpCode(setup.secret) });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'challenge_expired');
});

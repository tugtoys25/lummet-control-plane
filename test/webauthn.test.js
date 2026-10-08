// test/webauthn.test.js
//
// Builds COMPLETE, spec-correct ceremony data by hand -- a real P-256
// keypair (Web Crypto), a hand-assembled authenticatorData byte
// layout (RFC-correct field offsets), a hand-encoded CBOR
// attestationObject/COSE key (this codebase has no CBOR encoder, so
// these are assembled directly from bytes per RFC 8949, independent
// of the decoder under test), and a hand-DER-encoded ECDSA signature
// (the inverse of the DER-to-raw conversion webauthn.js performs,
// which validates both directions of that logic). Same
// "construct real, independently-derived test vectors" approach used
// for TOTP (RFC 6238) and the CBOR decoder (RFC 8949) -- see
// webauthn.js's own header comment for what this does and doesn't
// prove.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';

import * as webauthn from '../worker/webauthn.js';
import * as customerAuth from '../worker/customer-auth.js';

function makeTestKek() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString('base64');
}

const RP_ID = 'app.example.test';
const ORIGIN = 'https://app.example.test';

function makeEnv() {
  const db = createTestDb();
  applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: makeTestKek(), WEBAUTHN_RP_ID: RP_ID, WEBAUTHN_ORIGIN: ORIGIN };
}

function fakeSignupRequest(email) {
  return {
    async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org' }; },
    headers: { get: () => '203.0.113.150' }
  };
}

// -----------------------------------------------------
// Byte-level test fixture builders
// -----------------------------------------------------

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return Buffer.from(binary, 'binary').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function concatBytes(...chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

function u16be(n) { return new Uint8Array([(n >> 8) & 0xff, n & 0xff]); }
function u32be(n) { return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]); }

function cborEncodeUint(n) {
  if (n < 24) return new Uint8Array([n]);
  if (n < 256) return new Uint8Array([24, n]);
  throw new Error('test helper only supports small uints');
}
function cborEncodeNegInt(n) {
  const magnitude = -1 - n;
  if (magnitude < 24) return new Uint8Array([0x20 | magnitude]);
  throw new Error('test helper only supports small negative ints');
}
function cborEncodeBytes(bytes) {
  if (bytes.length < 24) return concatBytes(new Uint8Array([0x40 | bytes.length]), bytes);
  if (bytes.length < 256) return concatBytes(new Uint8Array([0x58, bytes.length]), bytes);
  throw new Error('test helper only supports byte strings under 256 bytes');
}
function cborEncodeEmptyMap() {
  return new Uint8Array([0xa0]);
}
function cborEncodeText(str) {
  const bytes = new TextEncoder().encode(str);
  return concatBytes(new Uint8Array([0x60 | bytes.length]), bytes);
}

function encodeCoseP256Key(x, y) {
  return concatBytes(
    new Uint8Array([0xa5]),
    cborEncodeUint(1), cborEncodeUint(2),
    cborEncodeUint(3), cborEncodeNegInt(-7),
    cborEncodeNegInt(-1), cborEncodeUint(1),
    cborEncodeNegInt(-2), cborEncodeBytes(x),
    cborEncodeNegInt(-3), cborEncodeBytes(y)
  );
}

async function buildAuthData({ rpId, counter, includeAttestedCredentialData, credentialId, cosePublicKeyBytes }) {
  const rpIdHash = await sha256(new TextEncoder().encode(rpId));
  const flags = includeAttestedCredentialData ? 0x41 : 0x01;
  const parts = [rpIdHash, new Uint8Array([flags]), u32be(counter)];

  if (includeAttestedCredentialData) {
    const aaguid = new Uint8Array(16);
    parts.push(aaguid, u16be(credentialId.length), credentialId, cosePublicKeyBytes);
  }

  return concatBytes(...parts);
}

function buildAttestationObject(authData) {
  return concatBytes(
    new Uint8Array([0xa3]),
    cborEncodeText('fmt'), cborEncodeText('none'),
    cborEncodeText('attStmt'), cborEncodeEmptyMap(),
    cborEncodeText('authData'), cborEncodeBytes(authData)
  );
}

function buildClientDataJSON(type, challenge, origin) {
  return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

function derEncodeEcdsaSignature(raw64) {
  const r = raw64.slice(0, 32);
  const s = raw64.slice(32, 64);
  function encodeInt(bytes) {
    let b = bytes;
    let i = 0;
    while (i < b.length - 1 && b[i] === 0 && (b[i + 1] & 0x80) === 0) i++;
    b = b.slice(i);
    if (b[0] & 0x80) b = concatBytes(new Uint8Array([0]), b);
    return concatBytes(new Uint8Array([0x02, b.length]), b);
  }
  const rEnc = encodeInt(r);
  const sEnc = encodeInt(s);
  const body = concatBytes(rEnc, sEnc);
  return concatBytes(new Uint8Array([0x30, body.length]), body);
}

async function generateKeyPair() {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
}

async function exportRawXY(publicKey) {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
  return { x: raw.slice(1, 33), y: raw.slice(33, 65) };
}

// -----------------------------------------------------
// Full registration ceremony
// -----------------------------------------------------

async function buildRegistrationCredential({ challenge, rpId = RP_ID, origin = ORIGIN, counter = 0 }) {
  const keyPair = await generateKeyPair();
  const { x, y } = await exportRawXY(keyPair.publicKey);
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const cosePublicKeyBytes = encodeCoseP256Key(x, y);
  const authData = await buildAuthData({ rpId, counter, includeAttestedCredentialData: true, credentialId, cosePublicKeyBytes });
  const attestationObject = buildAttestationObject(authData);
  const clientDataJSON = buildClientDataJSON('webauthn.create', challenge, origin);

  return {
    keyPair,
    credentialId,
    credential: {
      id: bytesToBase64Url(credentialId),
      response: {
        clientDataJSON: bytesToBase64Url(clientDataJSON),
        attestationObject: bytesToBase64Url(attestationObject)
      }
    }
  };
}

test('a full registration ceremony with correct data succeeds and stores the credential', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('webauthn-register@example.com'), env);

  const optionsResult = await webauthn.generateRegistrationOptions(env, signup.userId);
  assert.equal(optionsResult.ok, true);

  const { credential } = await buildRegistrationCredential({ challenge: optionsResult.options.challenge });
  const result = await webauthn.verifyRegistration(env, signup.userId, credential, 'My YubiKey');
  assert.equal(result.ok, true, JSON.stringify(result));

  const creds = await webauthn.listCredentials(env, signup.userId);
  assert.equal(creds.length, 1);
  assert.equal(creds[0].nickname, 'My YubiKey');
});

test('registration rejects a mismatched challenge and a wrong origin', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('webauthn-reject@example.com'), env);
  const optionsResult = await webauthn.generateRegistrationOptions(env, signup.userId);

  const { credential: wrongChallengeCred } = await buildRegistrationCredential({ challenge: 'not-the-real-challenge' });
  const wrongChallenge = await webauthn.verifyRegistration(env, signup.userId, wrongChallengeCred);
  assert.equal(wrongChallenge.ok, false);
  assert.equal(wrongChallenge.error, 'invalid_challenge');

  const { credential: wrongOriginCred } = await buildRegistrationCredential({
    challenge: optionsResult.options.challenge, origin: 'https://evil.example'
  });
  const wrongOrigin = await webauthn.verifyRegistration(env, signup.userId, wrongOriginCred);
  assert.equal(wrongOrigin.ok, false);
  assert.equal(wrongOrigin.error, 'origin_mismatch');
});

test('registration rejects a credential signed for the wrong RP ID', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('webauthn-wrong-rp@example.com'), env);
  const optionsResult = await webauthn.generateRegistrationOptions(env, signup.userId);

  const { credential } = await buildRegistrationCredential({
    challenge: optionsResult.options.challenge, rpId: 'attacker.example'
  });
  const result = await webauthn.verifyRegistration(env, signup.userId, credential);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'rp_id_mismatch');
});

test('the same credential cannot be registered twice', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('webauthn-dupe@example.com'), env);

  const options1 = await webauthn.generateRegistrationOptions(env, signup.userId);
  const built = await buildRegistrationCredential({ challenge: options1.options.challenge });
  const first = await webauthn.verifyRegistration(env, signup.userId, built.credential);
  assert.equal(first.ok, true);

  const { x, y } = await exportRawXY(built.keyPair.publicKey);
  const options2 = await webauthn.generateRegistrationOptions(env, signup.userId);
  const authData2 = await buildAuthData({
    rpId: RP_ID, counter: 0, includeAttestedCredentialData: true,
    credentialId: built.credentialId,
    cosePublicKeyBytes: encodeCoseP256Key(x, y)
  });
  const credential2 = {
    id: bytesToBase64Url(built.credentialId),
    response: {
      clientDataJSON: bytesToBase64Url(buildClientDataJSON('webauthn.create', options2.options.challenge, ORIGIN)),
      attestationObject: bytesToBase64Url(buildAttestationObject(authData2))
    }
  };
  const second = await webauthn.verifyRegistration(env, signup.userId, credential2);
  assert.equal(second.ok, false);
  assert.equal(second.error, 'credential_already_registered');
});

// -----------------------------------------------------
// Full authentication / passwordless login ceremony
// -----------------------------------------------------

async function buildAuthenticationAssertion({ keyPair, credentialId, challenge, rpId = RP_ID, origin = ORIGIN, counter = 1 }) {
  const authenticatorData = await buildAuthData({ rpId, counter, includeAttestedCredentialData: false });
  const clientDataJSON = buildClientDataJSON('webauthn.get', challenge, origin);
  const clientDataHash = await sha256(clientDataJSON);
  const signedData = concatBytes(authenticatorData, clientDataHash);

  const rawSignature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, signedData)
  );
  const derSignature = derEncodeEcdsaSignature(rawSignature);

  return {
    id: bytesToBase64Url(credentialId),
    response: {
      clientDataJSON: bytesToBase64Url(clientDataJSON),
      authenticatorData: bytesToBase64Url(authenticatorData),
      signature: bytesToBase64Url(derSignature)
    }
  };
}

async function registerAndReturnKeyPair(env, userId, counter = 0) {
  const options = await webauthn.generateRegistrationOptions(env, userId);
  const built = await buildRegistrationCredential({ challenge: options.options.challenge, counter });
  const result = await webauthn.verifyRegistration(env, userId, built.credential);
  assert.equal(result.ok, true);
  return { keyPair: built.keyPair, credentialId: built.credentialId };
}

test('a full authentication ceremony with a correctly signed assertion succeeds and creates a real session', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('webauthn-auth@example.com'), env);
  const { keyPair, credentialId } = await registerAndReturnKeyPair(env, signup.userId);

  const options = await webauthn.generateAuthenticationOptions(env, signup.userId);
  assert.equal(options.ok, true);

  const assertion = await buildAuthenticationAssertion({ keyPair, credentialId, challenge: options.options.challenge, counter: 1 });
  const result = await webauthn.completePasswordlessLogin(env, assertion);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.cookie.includes('lummet_customer_session='));
});

test('authentication rejects a signature from the wrong key (impersonation attempt)', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('webauthn-impersonate@example.com'), env);
  const { credentialId } = await registerAndReturnKeyPair(env, signup.userId);

  const options = await webauthn.generateAuthenticationOptions(env, signup.userId);
  const attackerKeyPair = await generateKeyPair();
  const assertion = await buildAuthenticationAssertion({ keyPair: attackerKeyPair, credentialId, challenge: options.options.challenge, counter: 1 });

  const result = await webauthn.verifyAuthentication(env, assertion);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_signature');
});

test('authentication rejects a tampered clientDataJSON even though a valid signature exists for the original data', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('webauthn-tamper@example.com'), env);
  const { keyPair, credentialId } = await registerAndReturnKeyPair(env, signup.userId);
  const options = await webauthn.generateAuthenticationOptions(env, signup.userId);

  const assertion = await buildAuthenticationAssertion({ keyPair, credentialId, challenge: options.options.challenge, counter: 1 });
  const tamperedClientData = buildClientDataJSON('webauthn.get', 'a-different-challenge-entirely', ORIGIN);
  assertion.response.clientDataJSON = bytesToBase64Url(tamperedClientData);

  const result = await webauthn.verifyAuthentication(env, assertion);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_challenge');
});

test('a replayed (reused) assertion is rejected the second time', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('webauthn-replay@example.com'), env);
  const { keyPair, credentialId } = await registerAndReturnKeyPair(env, signup.userId);
  const options = await webauthn.generateAuthenticationOptions(env, signup.userId);
  const assertion = await buildAuthenticationAssertion({ keyPair, credentialId, challenge: options.options.challenge, counter: 1 });

  const first = await webauthn.verifyAuthentication(env, assertion);
  assert.equal(first.ok, true);

  const replay = await webauthn.verifyAuthentication(env, assertion);
  assert.equal(replay.ok, false);
  assert.equal(replay.error, 'invalid_challenge', 'the challenge was already consumed by the first verification');
});

test('a non-increasing counter on a second login is treated as a possible cloned authenticator', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('webauthn-clone@example.com'), env);
  const { keyPair, credentialId } = await registerAndReturnKeyPair(env, signup.userId, 5);

  const options = await webauthn.generateAuthenticationOptions(env, signup.userId);
  const assertion = await buildAuthenticationAssertion({ keyPair, credentialId, challenge: options.options.challenge, counter: 5 });

  const result = await webauthn.verifyAuthentication(env, assertion);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'possible_cloned_authenticator');
});

test('generateLoginOptions does not reveal whether an email exists or merely has no passkey', async () => {
  const env = makeEnv();
  await customerAuth.signUp(fakeSignupRequest('webauthn-no-passkey@example.com'), env);

  const forExistingUserNoPasskey = await webauthn.generateLoginOptions(env, 'webauthn-no-passkey@example.com');
  const forUnknownEmail = await webauthn.generateLoginOptions(env, 'does-not-exist@example.com');

  assert.equal(forExistingUserNoPasskey.ok, false);
  assert.equal(forUnknownEmail.ok, false);
  assert.equal(forExistingUserNoPasskey.error, forUnknownEmail.error);
  assert.equal(forExistingUserNoPasskey.status, forUnknownEmail.status);
});

test('listCredentials and deleteCredential are scoped to the owning user', async () => {
  const env = makeEnv();
  const userA = await customerAuth.signUp(fakeSignupRequest('webauthn-owner-a@example.com'), env);
  const userB = await customerAuth.signUp(fakeSignupRequest('webauthn-owner-b@example.com'), env);
  const optionsA = await webauthn.generateRegistrationOptions(env, userA.userId);
  const builtA = await buildRegistrationCredential({ challenge: optionsA.options.challenge });
  await webauthn.verifyRegistration(env, userA.userId, builtA.credential);

  const credsA = await webauthn.listCredentials(env, userA.userId);
  const deleteAsWrongUser = await webauthn.deleteCredential(env, userB.userId, credsA[0].id);
  assert.equal(deleteAsWrongUser.ok, false);
  assert.equal(deleteAsWrongUser.error, 'not_found');

  const deleteAsOwner = await webauthn.deleteCredential(env, userA.userId, credsA[0].id);
  assert.equal(deleteAsOwner.ok, true);
  assert.equal((await webauthn.listCredentials(env, userA.userId)).length, 0);
});

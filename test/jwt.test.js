// test/jwt.test.js
//
// Builds REAL JWTs signed with real Web Crypto RSA/EC keys, exports
// the public half as a JWK (Web Crypto does this natively), and
// verifies against that -- the same "construct a real, independently
// derived artifact and check the implementation accepts/rejects it
// correctly" approach used throughout this codebase's cryptography
// (TOTP against RFC 6238, CBOR against RFC 8949, WebAuthn against
// hand-built ceremony data).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyJwt, decodeJwtUnverified } from '../worker/jwt.js';

function base64UrlEncode(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return Buffer.from(binary, 'binary').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlEncodeString(str) {
  return base64UrlEncode(new TextEncoder().encode(str));
}

async function signJwt(privateKey, alg, header, payload) {
  const headerB64 = base64UrlEncodeString(JSON.stringify({ alg, typ: 'JWT', ...header }));
  const payloadB64 = base64UrlEncodeString(JSON.stringify(payload));
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

  const algoParam = alg === 'RS256' ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'ECDSA', hash: 'SHA-256' };
  const signature = new Uint8Array(await crypto.subtle.sign(algoParam, privateKey, signingInput));
  return `${headerB64}.${payloadB64}.${base64UrlEncode(signature)}`;
}

async function generateRsaKeyPair() {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']
  );
}
async function generateEcKeyPair() {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
}

function nowSeconds() { return Math.floor(Date.now() / 1000); }

test('a valid RS256-signed JWT verifies successfully against its own JWKS', async () => {
  const { publicKey, privateKey } = await generateRsaKeyPair();
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  jwk.kid = 'test-key-1';
  const jwks = { keys: [jwk] };

  const token = await signJwt(privateKey, 'RS256', { kid: 'test-key-1' },
    { iss: 'https://idp.example.test', aud: 'my-client-id', sub: 'user-123', email: 'person@example.test', exp: nowSeconds() + 300, nonce: 'abc123' });

  const result = await verifyJwt(token, jwks, { issuer: 'https://idp.example.test', audience: 'my-client-id', nonce: 'abc123' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.claims.email, 'person@example.test');
});

test('RS256 verification rejects a token signed by a DIFFERENT RSA key entirely (forgery attempt)', async () => {
  const { publicKey } = await generateRsaKeyPair();
  const { privateKey: attackerPrivateKey } = await generateRsaKeyPair();
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  jwk.kid = 'test-key-1';
  const jwks = { keys: [jwk] };

  const forgedToken = await signJwt(attackerPrivateKey, 'RS256', { kid: 'test-key-1' },
    { iss: 'https://idp.example.test', aud: 'my-client-id', exp: nowSeconds() + 300, email: 'attacker@evil.test' });

  const result = await verifyJwt(forgedToken, jwks, { issuer: 'https://idp.example.test', audience: 'my-client-id' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_signature');
});

test('RS256 verification rejects a tampered payload (claims modified after signing)', async () => {
  const { publicKey, privateKey } = await generateRsaKeyPair();
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  jwk.kid = 'k1';
  const jwks = { keys: [jwk] };

  const token = await signJwt(privateKey, 'RS256', { kid: 'k1' },
    { iss: 'https://idp.example.test', aud: 'client', exp: nowSeconds() + 300, email: 'real-user@example.test' });

  const [headerB64, , signatureB64] = token.split('.');
  const forgedPayloadB64 = base64UrlEncodeString(JSON.stringify({
    iss: 'https://idp.example.test', aud: 'client', exp: nowSeconds() + 300, email: 'admin@example.test'
  }));
  const tamperedToken = `${headerB64}.${forgedPayloadB64}.${signatureB64}`;

  const result = await verifyJwt(tamperedToken, jwks, { issuer: 'https://idp.example.test', audience: 'client' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_signature');
});

test('a valid ES256-signed JWT verifies successfully (raw r||s per RFC 7518, no DER conversion)', async () => {
  const { publicKey, privateKey } = await generateEcKeyPair();
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  jwk.kid = 'ec-key-1';
  const jwks = { keys: [jwk] };

  const token = await signJwt(privateKey, 'ES256', { kid: 'ec-key-1' },
    { iss: 'https://idp.example.test', aud: 'my-client-id', email: 'person@example.test', exp: nowSeconds() + 300 });

  const result = await verifyJwt(token, jwks, { issuer: 'https://idp.example.test', audience: 'my-client-id' });
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('rejects an expired token', async () => {
  const { publicKey, privateKey } = await generateRsaKeyPair();
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  jwk.kid = 'k1';
  const token = await signJwt(privateKey, 'RS256', { kid: 'k1' },
    { iss: 'https://idp.example.test', aud: 'client', exp: nowSeconds() - 3600 });

  const result = await verifyJwt(token, { keys: [jwk] }, { issuer: 'https://idp.example.test', audience: 'client' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'token_expired');
});

test('rejects a wrong issuer, a wrong audience, and a wrong nonce independently', async () => {
  const { publicKey, privateKey } = await generateRsaKeyPair();
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  jwk.kid = 'k1';
  const jwks = { keys: [jwk] };

  const token = await signJwt(privateKey, 'RS256', { kid: 'k1' },
    { iss: 'https://real-idp.example.test', aud: 'my-client', exp: nowSeconds() + 300, nonce: 'expected-nonce' });

  const wrongIssuer = await verifyJwt(token, jwks, { issuer: 'https://different-idp.example.test', audience: 'my-client' });
  assert.equal(wrongIssuer.error, 'issuer_mismatch');

  const wrongAudience = await verifyJwt(token, jwks, { issuer: 'https://real-idp.example.test', audience: 'someone-elses-client' });
  assert.equal(wrongAudience.error, 'audience_mismatch');

  const wrongNonce = await verifyJwt(token, jwks, { issuer: 'https://real-idp.example.test', audience: 'my-client', nonce: 'attacker-supplied-nonce' });
  assert.equal(wrongNonce.error, 'nonce_mismatch');
});

test('rejects a token whose kid matches no key in the JWKS', async () => {
  const { privateKey } = await generateRsaKeyPair();
  const token = await signJwt(privateKey, 'RS256', { kid: 'unknown-key' }, { iss: 'x', aud: 'y', exp: nowSeconds() + 300 });

  const result = await verifyJwt(token, { keys: [] }, { issuer: 'x', audience: 'y' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unknown_signing_key');
});

test('rejects a malformed token and an unsupported algorithm without throwing', async () => {
  const notEvenThreeParts = await verifyJwt('garbage', { keys: [] }, {});
  assert.equal(notEvenThreeParts.ok, false);
  assert.equal(notEvenThreeParts.error, 'malformed_token');

  const headerB64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify({ iss: 'x' })).toString('base64url');
  const hs256Token = `${headerB64}.${payloadB64}.fakesignature`;
  const result = await verifyJwt(hs256Token, { keys: [] }, {});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unsupported_algorithm');
});

test('decodeJwtUnverified reads header/payload without checking the signature', () => {
  const headerB64 = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'abc' })).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify({ sub: 'someone' })).toString('base64url');
  const { header, payload } = decodeJwtUnverified(`${headerB64}.${payloadB64}.anything`);
  assert.equal(header.kid, 'abc');
  assert.equal(payload.sub, 'someone');
});

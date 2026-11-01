// Byte-level WebAuthn fixtures (registration and authentication assertions signed with real Web Crypto keys), shared by tests.
// The builders mirror test/webauthn.test.js; the one addition is `userVerified`, which sets the authenticator-data UV flag (0x04).
export function bytesToBase64Url(bytes) {
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


export const RP_ID = 'app.example.test';
export const ORIGIN = 'https://app.example.test';

export async function buildAuthData({ rpId, counter, includeAttestedCredentialData, credentialId, cosePublicKeyBytes, userVerified = false }) {
  const rpIdHash = await sha256(new TextEncoder().encode(rpId));
  const flags = (includeAttestedCredentialData ? 0x41 : 0x01) | (userVerified ? 0x04 : 0);
  const parts = [rpIdHash, new Uint8Array([flags]), u32be(counter)];
  if (includeAttestedCredentialData) {
    const aaguid = new Uint8Array(16);
    parts.push(aaguid, u16be(credentialId.length), credentialId, cosePublicKeyBytes);
  }
  return concatBytes(...parts);
}

export async function buildRegistrationCredential({ challenge, rpId = RP_ID, origin = ORIGIN, counter = 0 }) {
  const keyPair = await generateKeyPair();
  const { x, y } = await exportRawXY(keyPair.publicKey);
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const cosePublicKeyBytes = encodeCoseP256Key(x, y);
  const authData = await buildAuthData({ rpId, counter, includeAttestedCredentialData: true, credentialId, cosePublicKeyBytes });
  const attestationObject = buildAttestationObject(authData);
  const clientDataJSON = buildClientDataJSON('webauthn.create', challenge, origin);
  return { keyPair, credentialId, credential: { id: bytesToBase64Url(credentialId), response: { clientDataJSON: bytesToBase64Url(clientDataJSON), attestationObject: bytesToBase64Url(attestationObject) } } };
}

export async function buildAuthenticationAssertion({ keyPair, credentialId, challenge, rpId = RP_ID, origin = ORIGIN, counter = 1, userVerified = false }) {
  const authenticatorData = await buildAuthData({ rpId, counter, includeAttestedCredentialData: false, userVerified });
  const clientDataJSON = buildClientDataJSON('webauthn.get', challenge, origin);
  const clientDataHash = await sha256(clientDataJSON);
  const signedData = concatBytes(authenticatorData, clientDataHash);
  const rawSignature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, signedData));
  const derSignature = derEncodeEcdsaSignature(rawSignature);
  return { id: bytesToBase64Url(credentialId), response: { clientDataJSON: bytesToBase64Url(clientDataJSON), authenticatorData: bytesToBase64Url(authenticatorData), signature: bytesToBase64Url(derSignature) } };
}

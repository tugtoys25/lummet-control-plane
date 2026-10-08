// =====================================================
// CREDENTIAL ENCRYPTION AT REST
// Tenant HMAC secrets are stored in D1 only as AES-GCM
// ciphertext. The key (KEK) lives solely as a Worker
// secret on this control-plane Worker — never in D1,
// never shipped to the dashboard frontend.
// =====================================================

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// -----------------------------------------------------
// KEY ROTATION SUPPORT (roadmap 2.4)
//
// Ciphertext written now is tagged with the id of the key that made it:
//   "<keyId>:<base64>"   (keyId = first 8 hex chars of SHA-256 of the raw key)
// Older ciphertext has no tag ("legacy"). Decrypting looks at the tag to pick
// the key, and for legacy values tries each configured key. Two keys can be
// configured at once:
//   CREDENTIAL_KEK           - the key used for ALL new encryption
//   CREDENTIAL_KEK_PREVIOUS  - an older key, kept only for reading until every
//                              value has been re-encrypted (key-rotation.js)
// Only key ids are ever shown anywhere, never key material.
// -----------------------------------------------------

function toHex(buf) { return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""); }

async function loadKey(kekB64) {
  const rawKey = base64ToBytes(kekB64);
  const id = toHex(await crypto.subtle.digest("SHA-256", rawKey)).slice(0, 8);
  const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return { id, key };
}

async function configuredKeys(env) {
  if (!env.CREDENTIAL_KEK) throw new Error("CREDENTIAL_KEK secret is not configured");
  const keys = [await loadKey(env.CREDENTIAL_KEK)];
  if (env.CREDENTIAL_KEK_PREVIOUS && env.CREDENTIAL_KEK_PREVIOUS !== env.CREDENTIAL_KEK) {
    keys.push(await loadKey(env.CREDENTIAL_KEK_PREVIOUS));
  }
  return keys;
}

/** Id of the key used for new encryption (safe to display). */
export async function activeKeyId(env) { return (await configuredKeys(env))[0].id; }

/** Id of CREDENTIAL_KEK_PREVIOUS, or null when it is not set. */
export async function previousKeyId(env) {
  const keys = await configuredKeys(env);
  return keys[1] ? keys[1].id : null;
}

const TAG = /^([0-9a-f]{8}):/;

/** The key id a stored ciphertext was written with, or null for legacy untagged values. */
export function keyIdOf(encryptedSecret) {
  const m = TAG.exec(encryptedSecret || "");
  return m ? m[1] : null;
}

/**
 * Encrypts a plaintext secret with the active key. Returns tagged base64
 * ciphertext + base64 iv.
 */
export async function encryptSecret(env, plaintext) {
  const { id, key } = (await configuredKeys(env))[0];
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );

  return {
    encryptedSecret: `${id}:${bytesToBase64(new Uint8Array(ciphertext))}`,
    secretIv: bytesToBase64(iv)
  };
}

/**
 * Decrypts a stored secret back to plaintext. Only ever called
 * server-side, immediately before using the secret; the plaintext is
 * never returned to a browser.
 */
export async function decryptSecret(env, encryptedSecretB64, secretIvB64) {
  const keys = await configuredKeys(env);
  const tagged = TAG.exec(encryptedSecretB64);
  const iv = base64ToBytes(secretIvB64);
  const ciphertext = base64ToBytes(tagged ? encryptedSecretB64.slice(tagged[0].length) : encryptedSecretB64);

  const candidates = tagged ? keys.filter((k) => k.id === tagged[1]) : keys;
  if (!candidates.length) throw new Error("no_key_for_ciphertext");

  let lastError;
  for (const { key } of candidates) {
    try {
      return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext));
    } catch (e) { lastError = e; }
  }
  throw lastError;
}

/**
 * Generates a new random HMAC secret (for tenant credential
 * creation/rotation). 32 random bytes, hex-encoded.
 */
export function generateSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

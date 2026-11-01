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

// -----------------------------------------------------
// KEY MATERIAL VALIDATION (Phase K, round K.1)
//
// Web Crypto accepts 16, 24 and 32-byte AES keys, so a weak or truncated key
// would be accepted silently. validateKekMaterial() is the single definition of
// "an acceptable CREDENTIAL_KEK": standard base64 of exactly 32 bytes that are
// not all zero and not a short block repeated. config-check always uses it;
// the runtime enforces it only when CREDENTIAL_KEK_STRICT=on, so data written
// under an existing 16 or 24-byte key stays readable until it is rotated.
// -----------------------------------------------------
export const KEK_BYTES = 32;

/** Returns { ok: true } or { ok: false, reason }. Never includes key material in the result. */
export function validateKekMaterial(kekB64) {
  const text = typeof kekB64 === "string" ? kekB64.trim() : "";
  if (!text) return { ok: false, reason: "empty" };
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return { ok: false, reason: "not_base64" };
  let bytes;
  try { bytes = base64ToBytes(text); } catch (_) { return { ok: false, reason: "not_base64" }; }
  if (bytes.length !== KEK_BYTES) return { ok: false, reason: "wrong_length" };
  if (bytes.every((b) => b === 0)) return { ok: false, reason: "all_zero" };
  for (const period of [1, 2, 4, 8, 16]) {
    if (bytes.every((b, i) => b === bytes[i % period])) return { ok: false, reason: "repeated_pattern" };
  }
  return { ok: true };
}

/** True when the runtime must refuse a key that fails validateKekMaterial (CREDENTIAL_KEK_STRICT=on). */
export function kekStrict(env) { return String(env?.CREDENTIAL_KEK_STRICT || "off").toLowerCase() === "on"; }

async function loadKey(kekB64, strict = false) {
  if (strict) {
    const check = validateKekMaterial(kekB64);
    if (!check.ok) throw new Error(`kek_invalid_${check.reason}`);
  }
  const rawKey = base64ToBytes(kekB64);
  const id = toHex(await crypto.subtle.digest("SHA-256", rawKey)).slice(0, 8);
  const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return { id, key };
}

async function configuredKeys(env) {
  if (!env.CREDENTIAL_KEK) throw new Error("CREDENTIAL_KEK secret is not configured");
  const strict = kekStrict(env);
  const keys = [await loadKey(env.CREDENTIAL_KEK, strict)];
  // The previous key is only ever read with, and may legitimately be a legacy
  // key that predates the 32-byte rule, so it is never held to the strict check.
  if (env.CREDENTIAL_KEK_PREVIOUS && env.CREDENTIAL_KEK_PREVIOUS !== env.CREDENTIAL_KEK) {
    keys.push(await loadKey(env.CREDENTIAL_KEK_PREVIOUS, false));
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
const V2_MARK = "v2:";

// -----------------------------------------------------
// CIPHERTEXT FORMATS (Phase K, round K.2)
//   v1  "<keyId>:<base64>"      AES-GCM, no authenticated data
//   v2  "<keyId>:v2:<base64>"   AES-GCM with authenticated data that names the
//                               table, the row and the column
// A v2 value only decrypts when the caller supplies the same location, so
// copying one row's ciphertext (and IV) into another row, or another column,
// makes decryption fail instead of yielding the other row's secret. The
// base64 alphabet has no ":", so "v2:" can never be confused with v1 data.
// Writing v2 is behind CREDENTIAL_ENCRYPTION_FORMAT=v2 (default v1); reading
// always accepts both, so turning the flag back off never strands data.
// -----------------------------------------------------

/** The authenticated-data string for one encrypted value. `bind` is the row's stable key. */
export function aadFor(table, bind, column) {
  if (!table || bind === null || bind === undefined || bind === "" || !column) throw new Error("aad_incomplete");
  return `lm2|${table}|${bind}|${column}`;
}

/** True when new values are written as v2 (when the caller supplies a location). */
export function writesV2(env) { return String(env?.CREDENTIAL_ENCRYPTION_FORMAT || "v1").toLowerCase() === "v2"; }

/** The key id a stored ciphertext was written with, or null for legacy untagged values. */
export function keyIdOf(encryptedSecret) {
  const m = TAG.exec(encryptedSecret || "");
  return m ? m[1] : null;
}

/** "v2" for a v2 value, otherwise "v1" (tagged or legacy untagged). */
export function formatOf(encryptedSecret) {
  const m = TAG.exec(encryptedSecret || "");
  return m && String(encryptedSecret).slice(m[0].length).startsWith(V2_MARK) ? "v2" : "v1";
}

/**
 * Encrypts a plaintext secret with the active key. Returns tagged base64
 * ciphertext + base64 iv. When `aad` (see aadFor) is given and
 * CREDENTIAL_ENCRYPTION_FORMAT=v2 (or opts.format === "v2"), the value is bound to that location.
 */
export async function encryptSecret(env, plaintext, aad = null, opts = {}) {
  const { id, key } = (await configuredKeys(env))[0];
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // opts.format === "v2" keeps an existing v2 value v2 when it is re-encrypted with the flag off.
  const useV2 = !!aad && (opts.format === "v2" || writesV2(env));
  const params = { name: "AES-GCM", iv };
  if (useV2) params.additionalData = new TextEncoder().encode(aad);

  const ciphertext = await crypto.subtle.encrypt(params, key, new TextEncoder().encode(plaintext));

  return {
    encryptedSecret: `${id}:${useV2 ? V2_MARK : ""}${bytesToBase64(new Uint8Array(ciphertext))}`,
    secretIv: bytesToBase64(iv)
  };
}

/**
 * Decrypts a stored secret back to plaintext. Only ever called
 * server-side, immediately before using the secret; the plaintext is
 * never returned to a browser. A v2 value needs the same `aad` it was
 * written with ("aad_required" when it is missing); v1 values ignore it.
 */
export async function decryptSecret(env, encryptedSecretB64, secretIvB64, aad = null) {
  const keys = await configuredKeys(env);
  const tagged = TAG.exec(encryptedSecretB64);
  const iv = base64ToBytes(secretIvB64);
  const afterTag = tagged ? encryptedSecretB64.slice(tagged[0].length) : encryptedSecretB64;
  const isV2 = !!tagged && afterTag.startsWith(V2_MARK);
  if (isV2 && !aad) throw new Error("aad_required");
  const ciphertext = base64ToBytes(isV2 ? afterTag.slice(V2_MARK.length) : afterTag);
  const params = { name: "AES-GCM", iv };
  if (isV2) params.additionalData = new TextEncoder().encode(aad);

  const candidates = tagged ? keys.filter((k) => k.id === tagged[1]) : keys;
  if (!candidates.length) throw new Error("no_key_for_ciphertext");

  let lastError;
  for (const { key } of candidates) {
    try {
      return new TextDecoder().decode(await crypto.subtle.decrypt(params, key, ciphertext));
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

// Password hashing with a versioned format and rehash-on-login (release 2.6.0.17).
//
// Two stored formats, both PBKDF2-HMAC-SHA256 with a 256-bit derived key:
//   legacy  "<saltHex>:<hashHex>"                          100,000 iterations, implied (every hash written before 2.6.0.17)
//   v2      "pbkdf2-sha256$<iterations>$<saltHex>$<hashHex>"  iterations are stored with the hash
//
// Flags (both optional; unset means the safe default and no behaviour change):
//   PASSWORD_HASH_FORMAT      legacy (default) | v2     what NEW hashes are written as. Verification ALWAYS accepts both.
//   PASSWORD_HASH_ITERATIONS  integer 10000..100000, default 100000   target cost for v2 hashes
//
// Rehash on login: only when PASSWORD_HASH_FORMAT=v2. After a correct password, a hash that is legacy or below the target
// cost is rewritten in the target format. A failed rewrite never blocks the login.
//
// Limit that matters: Cloudflare Workers' Web Crypto documents a ceiling of 100,000 PBKDF2 iterations, so the cost cannot be raised
// above today's value on Workers. This module makes the format and cost changeable later (a different algorithm or a
// higher cost where the runtime allows it) without another forced reset. It does not make hashes stronger by itself.
// Rollback hazard: once v2 hashes exist, a build older than 2.6.0.17 cannot verify them. Keep PASSWORD_HASH_FORMAT=legacy until
// 2.6.0.17 or later is the oldest build you could roll back to.
export const PBKDF2_MAX_ITERATIONS = 100000;
export const PBKDF2_MIN_ITERATIONS = 10000;
export const LEGACY_ITERATIONS = 100000;
const V2_PREFIX = "pbkdf2-sha256";

export function passwordHashSettings(env) {
  const format = String((env && env.PASSWORD_HASH_FORMAT) || "legacy").trim().toLowerCase() === "v2" ? "v2" : "legacy";
  const raw = Number.parseInt(String((env && env.PASSWORD_HASH_ITERATIONS) ?? ""), 10);
  const iterations = Number.isInteger(raw) && raw >= PBKDF2_MIN_ITERATIONS && raw <= PBKDF2_MAX_ITERATIONS ? raw : LEGACY_ITERATIONS;
  return { format, iterations };
}

const HEX = /^(?:[0-9a-f]{2})+$/;

/** Returns { format, iterations, saltHex, hashHex } or null for anything malformed or out of range. Never throws. */
export function parsePasswordHash(stored) {
  if (typeof stored !== "string" || stored.length > 512) return null;
  if (stored.startsWith(V2_PREFIX + "$")) {
    const [, it, saltHex, hashHex, extra] = stored.split("$");
    if (extra !== undefined) return null;
    const iterations = /^[0-9]{1,7}$/.test(it || "") ? Number.parseInt(it, 10) : 0;
    if (iterations < 1 || iterations > PBKDF2_MAX_ITERATIONS) return null;
    if (!HEX.test(saltHex || "") || saltHex.length < 16 || saltHex.length > 128 || !/^[0-9a-f]{64}$/.test(hashHex || "")) return null;
    return { format: "v2", iterations, saltHex, hashHex };
  }
  const parts = stored.split(":");
  if (parts.length !== 2) return null;
  const [saltHex, hashHex] = parts;
  if (!HEX.test(saltHex) || saltHex.length > 128 || !/^[0-9a-f]{64}$/.test(hashHex)) return null;
  return { format: "legacy", iterations: LEGACY_ITERATIONS, saltHex, hashHex };
}

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

async function derive(password, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, keyMaterial, 256);
  return toHex(new Uint8Array(bits));
}

/** Hash with an explicit format. With no options the output is the legacy format, byte-compatible with every earlier release. */
export async function hashPasswordWith(password, { format = "legacy", iterations = LEGACY_ITERATIONS } = {}) {
  const cost = format === "v2" ? Math.min(Math.max(iterations, PBKDF2_MIN_ITERATIONS), PBKDF2_MAX_ITERATIONS) : LEGACY_ITERATIONS;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hashHex = await derive(password, salt, cost);
  return format === "v2" ? `${V2_PREFIX}$${cost}$${toHex(salt)}$${hashHex}` : `${toHex(salt)}:${hashHex}`;
}

/** Hash in whatever format the environment currently selects (legacy unless PASSWORD_HASH_FORMAT=v2). */
export function hashPasswordForEnv(password, env) {
  return hashPasswordWith(password, passwordHashSettings(env));
}

/** Verify against either format. Malformed or out-of-range stored values return false without doing any derivation. */
export async function verifyPasswordHash(password, stored, constantTimeEqual) {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  const salt = new Uint8Array(parsed.saltHex.match(/.{2}/g).map((b) => Number.parseInt(b, 16)));
  const computed = await derive(password, salt, parsed.iterations);
  return constantTimeEqual(computed, parsed.hashHex);
}

/** True only when the environment selects v2 and the stored hash is legacy or below the target cost. */
export function passwordHashNeedsUpgrade(stored, env) {
  const settings = passwordHashSettings(env);
  if (settings.format !== "v2") return false;
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  return parsed.format === "legacy" || parsed.iterations < settings.iterations;
}

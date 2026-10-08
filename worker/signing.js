// =====================================================
// SUPER API REQUEST SIGNING
// Must exactly match the canonical-string scheme verified
// by the tenant's en/worker/super/auth.js:
//
//   {METHOD}\n{PATH}\n{TIMESTAMP}\n{NONCE}\n{SHA256_HEX(BODY)}
//
// signed with the shared HMAC secret, hex output.
// =====================================================

function toHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );
  return toHex(signature);
}

function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Builds the full set of Super API auth headers for an outbound
 * request to a tenant. `bodyText` must be the exact raw string that
 * will be sent as the request body ("" for bodyless requests).
 */
export async function buildSuperApiHeaders({
  credentialId,
  secret,
  method,
  path,
  bodyText
}) {
  const timestamp = Date.now();
  const nonce = randomNonce();
  const bodyHash = await sha256Hex(bodyText || "");

  const canonical = [
    method.toUpperCase(),
    path,
    String(timestamp),
    nonce,
    bodyHash
  ].join("\n");

  const signature = await hmacSha256Hex(secret, canonical);

  return {
    Authorization: `Bearer ${credentialId}`,
    "X-Lummet-Timestamp": String(timestamp),
    "X-Lummet-Nonce": nonce,
    "X-Lummet-Signature": signature,
    "Content-Type": "application/json"
  };
}

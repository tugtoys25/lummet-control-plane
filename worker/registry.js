// =====================================================
// TENANT REGISTRY
// Manages the control plane's own metadata about each
// tenant deployment: where it is, how to authenticate to
// it, what it supports, and whether it's reachable.
//
// This module NEVER touches a tenant's own D1. Deleting a
// registry row only removes control-plane metadata — the
// tenant's actual content is untouched (rule #5).
// =====================================================

import { encryptSecret, generateSecret } from "./crypto.js";
import { getTenant, getTenantByHost, getActiveCredential } from "./data.js";
import { requestTenant } from "./client.js";

export { getTenant, getTenantByHost, getActiveCredential };

const TEST_CONNECTION_TIMEOUT_MS = 8000;

function normalizeApiBaseUrl(host, providedBaseUrl) {
  if (providedBaseUrl) return providedBaseUrl.replace(/\/$/, "");
  return `https://${host}`;
}

// -----------------------------------------------------
// Basic CRUD
// -----------------------------------------------------

export async function listTenants(env) {
  const result = await env.LUMMET_DB.prepare(
    `SELECT t.*, h.status AS health_status, h.last_checked_at, h.api_version
     FROM tenants t
     LEFT JOIN tenant_health h ON h.tenant_id = t.id
     ORDER BY t.created_at DESC`
  ).all();

  return result.results || [];
}

/**
 * Registers a new tenant and issues its initial Super API
 * credential. Returns the credential_id + plaintext secret
 * ONCE — the caller must display it to the administrator so
 * it can be configured on the tenant Worker via
 * `wrangler secret put`. The plaintext is never stored or
 * returned again after this call.
 */
export async function createTenant(env, data) {
  const id = crypto.randomUUID();
  const host = (data.host || "").trim().toLowerCase();

  if (!host || !data.name) {
    return { ok: false, status: 422, error: "name_and_host_required" };
  }

  const existing = await getTenantByHost(env, host);
  if (existing) {
    return { ok: false, status: 409, error: "host_already_registered" };
  }

  // Generate + encrypt the credential FIRST, before writing anything.
  // If CREDENTIAL_KEK is missing or invalid, this throws here and no
  // tenant row is ever created — previously the tenant row was
  // inserted first, so a KEK failure left an orphaned tenant with
  // no credential at all (exactly the "no_active_credential" state
  // this guards against now).
  let material;
  try {
    material = await generateCredentialMaterial(env);
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: "credential_generation_failed",
      message: "Could not generate a credential — check that CREDENTIAL_KEK is configured on this Worker."
    };
  }

  const apiBaseUrl = normalizeApiBaseUrl(host, data.api_base_url);

  await env.LUMMET_DB.batch([
    env.LUMMET_DB.prepare(
      `INSERT INTO tenants (id, name, host, api_base_url, status, description, deployment_identifier)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`
    ).bind(id, data.name, host, apiBaseUrl, data.description || null, data.deployment_identifier || null),
    buildCredentialInsertStatement(env, id, material)
  ]);

  return {
    ok: true,
    tenant: await getTenant(env, id),
    credential: { credentialId: material.credentialId, secret: material.secret }
  };
}

export async function updateTenant(env, id, data) {
  const tenant = await getTenant(env, id);
  if (!tenant) return { ok: false, status: 404, error: "not_found" };

  const name = data.name ?? tenant.name;
  const apiBaseUrl = data.api_base_url ?? tenant.api_base_url;
  const description = data.description ?? tenant.description;
  const deploymentIdentifier =
    data.deployment_identifier ?? tenant.deployment_identifier;

  await env.LUMMET_DB.prepare(
    `UPDATE tenants
     SET name = ?, api_base_url = ?, description = ?, deployment_identifier = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  )
    .bind(name, apiBaseUrl, description, deploymentIdentifier, id)
    .run();

  return { ok: true, tenant: await getTenant(env, id) };
}

export async function setTenantStatus(env, id, status) {
  if (status !== "active" && status !== "disabled") {
    return { ok: false, status: 422, error: "invalid_status" };
  }

  const tenant = await getTenant(env, id);
  if (!tenant) return { ok: false, status: 404, error: "not_found" };

  await env.LUMMET_DB.prepare(
    `UPDATE tenants SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  )
    .bind(status, id)
    .run();

  return { ok: true, tenant: await getTenant(env, id) };
}

/**
 * Deletes only this control-plane's registry row (and, via
 * FK cascade, its cached credentials/capabilities/health rows).
 * The tenant's own D1 and deployment are completely untouched.
 */
export async function deleteTenant(env, id) {
  const tenant = await getTenant(env, id);
  if (!tenant) return { ok: false, status: 404, error: "not_found" };

  await env.LUMMET_DB.prepare(`DELETE FROM tenants WHERE id = ?`).bind(id).run();

  return { ok: true };
}

// -----------------------------------------------------
// Credentials
// -----------------------------------------------------

/**
 * Generates and encrypts new credential material without touching
 * D1. Deliberately separated from the insert so callers can
 * validate/encrypt FIRST — if CREDENTIAL_KEK is missing or invalid,
 * this throws before any row is written, instead of after (which
 * previously could leave a tenant or a rotation with zero active
 * credentials — see createTenant/rotateCredential below).
 */
async function generateCredentialMaterial(env) {
  const credentialId = crypto.randomUUID();
  const secret = generateSecret();
  const { encryptedSecret, secretIv } = await encryptSecret(env, secret);
  return { credentialId, secret, encryptedSecret, secretIv };
}

function buildCredentialInsertStatement(env, tenantId, material) {
  return env.LUMMET_DB.prepare(
    `INSERT INTO tenant_api_credentials
      (tenant_id, credential_id, encrypted_secret, secret_iv, status)
     VALUES (?, ?, ?, ?, 'active')`
  ).bind(tenantId, material.credentialId, material.encryptedSecret, material.secretIv);
}

/**
 * Rotates a tenant's credential: marks the old one 'rotated' and
 * issues a fresh credential_id + secret, as a single atomic D1
 * batch — either both writes land or neither does, so a tenant can
 * never end up with zero active credentials mid-rotation. The
 * administrator must then update the tenant Worker's secrets to
 * match, or the tenant will start rejecting Lummet's requests as
 * unauthorized.
 */
export async function rotateCredential(env, tenantId) {
  const tenant = await getTenant(env, tenantId);
  if (!tenant) return { ok: false, status: 404, error: "not_found" };

  let material;
  try {
    material = await generateCredentialMaterial(env);
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: "credential_generation_failed",
      message: "Could not generate a new credential — check that CREDENTIAL_KEK is configured on this Worker."
    };
  }

  await env.LUMMET_DB.batch([
    env.LUMMET_DB.prepare(
      `UPDATE tenant_api_credentials SET status = 'rotated', rotated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND status = 'active'`
    ).bind(tenantId),
    buildCredentialInsertStatement(env, tenantId, material)
  ]);

  return { ok: true, credential: { credentialId: material.credentialId, secret: material.secret } };
}

export async function revokeCredential(env, tenantId, credentialId) {
  await env.LUMMET_DB.prepare(
    `UPDATE tenant_api_credentials SET status = 'revoked'
     WHERE tenant_id = ? AND credential_id = ?`
  )
    .bind(tenantId, credentialId)
    .run();

  return { ok: true };
}

// -----------------------------------------------------
// Connection testing / capability + health refresh
// -----------------------------------------------------

/**
 * Calls the tenant's /en/api/super/handshake endpoint through the
 * shared client (client.js), records the result in tenant_health,
 * and (on success) caches reported capabilities. This is the only
 * caller-facing "is this tenant reachable" check in the registry —
 * it never constructs its own fetch(), per rule #23.
 */
export async function testConnection(env, tenantId) {
  const tenant = await getTenant(env, tenantId);
  if (!tenant) return { ok: false, status: 404, error: "not_found" };

  if (tenant.status === "disabled") {
    await writeHealth(env, tenantId, "Disabled", null);
    return { ok: false, status: 409, error: "tenant_disabled" };
  }

  const result = await requestTenant(env, tenant, {
    method: "GET",
    path: "/en/api/super/handshake",
    timeoutMs: TEST_CONNECTION_TIMEOUT_MS
  });

  if (!result.ok) {
    await writeHealth(env, tenantId, statusToHealthLabel(result.status, result.reason), result.reason);
    return { ok: false, status: result.status, error: result.reason };
  }

  const data = result.data;
  await writeHealth(env, tenantId, "Online", null, data.api_version);
  await cacheCapabilities(env, tenantId, data.capabilities || []);
  await touchLastSeen(env, tenantId);

  return { ok: true, data };
}

function statusToHealthLabel(status, reason) {
  if (
    reason === "no_active_credential" ||
    reason === "credential_decrypt_failed" ||
    reason === "tenant_not_configured"
  ) {
    return "Configuration Error";
  }
  if (status === 401 || status === 403) return "Unauthorized";
  if (status === 504) return "Timeout";
  if (status === 502) return "Unavailable";
  return "Unavailable";
}

async function writeHealth(env, tenantId, status, lastError, apiVersion = null) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO tenant_health (tenant_id, status, last_checked_at, last_error, api_version)
     VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       status = excluded.status,
       last_checked_at = excluded.last_checked_at,
       last_error = excluded.last_error,
       api_version = excluded.api_version`
  )
    .bind(tenantId, status, lastError, apiVersion)
    .run();
}

async function touchLastSeen(env, tenantId) {
  await env.LUMMET_DB.prepare(
    `UPDATE tenants SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?`
  )
    .bind(tenantId)
    .run();
}

async function cacheCapabilities(env, tenantId, capabilityNames) {
  // Reset to exactly what the tenant reports this call.
  await env.LUMMET_DB.prepare(`DELETE FROM tenant_capabilities WHERE tenant_id = ?`)
    .bind(tenantId)
    .run();

  for (const capability of capabilityNames) {
    await env.LUMMET_DB.prepare(
      `INSERT INTO tenant_capabilities (tenant_id, capability, enabled) VALUES (?, ?, 1)`
    )
      .bind(tenantId, capability)
      .run();
  }
}

export async function getTenantCapabilities(env, tenantId) {
  const result = await env.LUMMET_DB.prepare(
    `SELECT capability, enabled FROM tenant_capabilities WHERE tenant_id = ?`
  )
    .bind(tenantId)
    .all();

  return result.results || [];
}

export async function getTenantHealth(env, tenantId) {
  return env.LUMMET_DB.prepare(`SELECT * FROM tenant_health WHERE tenant_id = ?`)
    .bind(tenantId)
    .first();
}

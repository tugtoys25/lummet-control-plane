import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, applyMigrations } from "./support/d1-shim.js";
import { encryptSecret } from "../worker/crypto.js";
import { resolveAction } from "../worker/ai/resolver.js";
import { buildWritePreview } from "../worker/ai/write.js";
import { confirmPendingOperation } from "../worker/ai/confirm.js";
import { getPendingOperation } from "../worker/ai/pending-operations.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const API_BASE = "https://mock.tenant.test";

let db, env, originalFetch, tenantDb, fetchLog;

function makeFetchMock() {
  fetchLog = [];
  return async (url, options) => {
    fetchLog.push({ url: String(url), method: options?.method });
    const u = new URL(url);
    const method = options?.method || "GET";

    // GET /en/api/super/casinos/:slug
    const recordMatch = u.pathname.match(/^\/en\/api\/super\/casinos\/([^/]+)$/);
    if (recordMatch) {
      const slug = decodeURIComponent(recordMatch[1]);
      if (method === "GET") {
        const record = tenantDb.casinos[slug];
        if (!record) {
          return { ok: false, status: 404, json: async () => ({ success: false, error: "not_found" }) };
        }
        return { ok: true, status: 200, json: async () => ({ success: true, data: record }) };
      }
      if (method === "PUT") {
        const body = JSON.parse(options.body);
        tenantDb.casinos[slug] = { ...body, slug };
        return { ok: true, status: 200, json: async () => ({ success: true, data: tenantDb.casinos[slug] }) };
      }
      if (method === "DELETE") {
        const existed = !!tenantDb.casinos[slug];
        delete tenantDb.casinos[slug];
        return { ok: existed, status: existed ? 200 : 404, json: async () => ({ success: existed, data: null }) };
      }
    }

    // POST /en/api/super/casinos
    if (u.pathname === "/en/api/super/casinos" && method === "POST") {
      const body = JSON.parse(options.body);
      const slug = body.slug || `generated-${Object.keys(tenantDb.casinos).length + 1}`;
      tenantDb.casinos[slug] = { ...body, slug };
      return { ok: true, status: 200, json: async () => ({ success: true, data: tenantDb.casinos[slug] }) };
    }

    return { ok: false, status: 404, json: async () => ({ success: false, error: "unhandled_mock_path" }) };
  };
}

beforeEach(async () => {
  db = createTestDb();
  applyMigrations(db);

  const kek = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  env = { LUMMET_DB: db, CREDENTIAL_KEK: kek };

  await env.LUMMET_DB.prepare(
    `INSERT INTO tenants (id, name, host, api_base_url, status) VALUES (?, 'level.casino', 'level.casino', ?, 'active')`
  ).bind(TENANT_A, API_BASE).run();

  const { encryptedSecret, secretIv } = await encryptSecret(env, "test-hmac-secret");
  await env.LUMMET_DB.prepare(
    `INSERT INTO tenant_api_credentials (tenant_id, credential_id, encrypted_secret, secret_iv, status) VALUES (?, 'cred-1', ?, ?, 'active')`
  ).bind(TENANT_A, encryptedSecret, secretIv).run();

  await env.LUMMET_DB.prepare(`INSERT INTO lummet_admins (id, email, password_hash, role) VALUES (1, 'a@test.local', 'x', 'super_admin')`).run();

  tenantDb = {
    casinos: {
      "level-casino": {
        slug: "level-casino",
        name: "Level Casino",
        affiliate_url: "https://aff.example/level",
        rating: 4.5,
        status: "draft",
        featured: false
      }
    }
  };

  originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetchMock();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const superAdmin = { id: 1, role: "super_admin", activeTenantId: TENANT_A };

describe("Phase 2 end-to-end: preview -> confirm -> execute (real crypto/signing, mocked tenant HTTP)", () => {
  test("UPDATE: preview shows the real current value, confirm executes exactly the previewed change, other fields survive untouched", async () => {
    const resolved = await resolveAction(env, superAdmin, { resource: "casinos", operation: "update", tenantHint: null });
    assert.equal(resolved.ok, true);

    const preview = await buildWritePreview(env, superAdmin, resolved, {
      operation: "update",
      recordId: "level-casino",
      fields: { rating: 4.8 }
    });

    assert.equal(preview.ok, true);
    assert.equal(preview.kind, "write_preview");
    assert.deepEqual(preview.changes, [{ field: "rating", current: 4.5, proposed: 4.8 }]);

    const pendingBefore = await getPendingOperation(env, preview.pendingOperationId);
    assert.equal(pendingBefore.status, "pending");

    const confirmed = await confirmPendingOperation(env, superAdmin, preview.pendingOperationId, preview.payloadHash);

    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.result.data.rating, 4.8);
    // The field the admin never touched must survive the round trip.
    assert.equal(confirmed.result.data.name, "Level Casino");
    assert.equal(confirmed.result.data.affiliate_url, "https://aff.example/level");

    const pendingAfter = await getPendingOperation(env, preview.pendingOperationId);
    assert.equal(pendingAfter.status, "executed");

    // And the mock tenant's own store reflects it too.
    assert.equal(tenantDb.casinos["level-casino"].rating, 4.8);
    assert.equal(tenantDb.casinos["level-casino"].name, "Level Casino");
  });

  test("CREATE: a new record is created with exactly the specified fields", async () => {
    const resolved = await resolveAction(env, superAdmin, { resource: "casinos", operation: "create", tenantHint: null });
    const preview = await buildWritePreview(env, superAdmin, resolved, {
      operation: "create",
      fields: { slug: "new-casino", name: "New Casino", affiliate_url: "https://aff.example/new", website_url: "https://new.example" }
    });
    assert.equal(preview.ok, true);

    const confirmed = await confirmPendingOperation(env, superAdmin, preview.pendingOperationId, preview.payloadHash);
    assert.equal(confirmed.ok, true);
    assert.ok(tenantDb.casinos["new-casino"]);
    assert.equal(tenantDb.casinos["new-casino"].name, "New Casino");
  });

  test("CREATE: missing a required field is refused BEFORE any pending operation or tenant call is made", async () => {
    const resolved = await resolveAction(env, superAdmin, { resource: "casinos", operation: "create", tenantHint: null });
    const preview = await buildWritePreview(env, superAdmin, resolved, {
      operation: "create",
      fields: { name: "Missing slug and affiliate url" }
    });
    assert.equal(preview.ok, false);
    assert.equal(preview.error, "missing_required_fields");
    assert.equal(fetchLog.length, 0);
  });

  test("CREATE without website_url is refused at preview (it is NOT NULL on the tenant), before any tenant call", async () => {
    const resolved = await resolveAction(env, superAdmin, { resource: "casinos", operation: "create", tenantHint: null });
    const preview = await buildWritePreview(env, superAdmin, resolved, {
      operation: "create",
      fields: { slug: "no-site", name: "No Site", affiliate_url: "https://aff.example/x" }
    });
    assert.equal(preview.ok, false);
    assert.equal(preview.error, "missing_required_fields");
    assert.match(preview.message, /website_url/);
    assert.equal(fetchLog.length, 0);
  });

  test("TENANT MISMATCH: a preview targeting a tenant other than the active one is refused up front", async () => {
    const resolved = await resolveAction(env, superAdmin, { resource: "casinos", operation: "create", tenantHint: null });
    const elsewhere = { ...superAdmin, activeTenantId: "some-other-tenant" };
    const preview = await buildWritePreview(env, elsewhere, resolved, {
      operation: "create",
      fields: { slug: "x", name: "X", affiliate_url: "https://a.example", website_url: "https://x.example" }
    });
    assert.equal(preview.ok, false);
    assert.equal(preview.error, "active_tenant_mismatch");
    assert.equal(fetchLog.length, 0);
  });

  test("DELETE: destructive preview flags itself, confirm removes the record", async () => {
    const resolved = await resolveAction(env, superAdmin, { resource: "casinos", operation: "delete", tenantHint: null });
    const preview = await buildWritePreview(env, superAdmin, resolved, { operation: "delete", recordId: "level-casino", fields: {} });
    assert.equal(preview.ok, true);
    assert.equal(preview.destructive, true);
    assert.ok(preview.recordSnapshot);

    const confirmed = await confirmPendingOperation(env, superAdmin, preview.pendingOperationId, preview.payloadHash);
    assert.equal(confirmed.ok, true);
    assert.equal(tenantDb.casinos["level-casino"], undefined);
  });

  test("CONFLICT: the record changes between preview and confirm — execution is refused, nothing is written", async () => {
    const resolved = await resolveAction(env, superAdmin, { resource: "casinos", operation: "update", tenantHint: null });
    const preview = await buildWritePreview(env, superAdmin, resolved, {
      operation: "update",
      recordId: "level-casino",
      fields: { rating: 4.8 }
    });
    assert.equal(preview.ok, true);

    // Someone else changes the rating out from under this preview.
    tenantDb.casinos["level-casino"].rating = 3.9;

    const confirmed = await confirmPendingOperation(env, superAdmin, preview.pendingOperationId, preview.payloadHash);
    assert.equal(confirmed.ok, false);
    assert.equal(confirmed.error, "conflict");
    assert.deepEqual(confirmed.conflictingFields, ["rating"]);
    // The conflicting live value must NOT have been silently overwritten
    // by the stale 4.8 proposal.
    assert.equal(tenantDb.casinos["level-casino"].rating, 3.9);

    const pendingAfter = await getPendingOperation(env, preview.pendingOperationId);
    assert.equal(pendingAfter.status, "superseded");
  });

  test("EXPIRED: confirming after the TTL elapses is refused, nothing executes", async () => {
    const resolved = await resolveAction(env, superAdmin, { resource: "casinos", operation: "update", tenantHint: null });
    const preview = await buildWritePreview(env, superAdmin, resolved, {
      operation: "update",
      recordId: "level-casino",
      fields: { rating: 4.8 }
    });

    // Force it into the past directly (createPendingOperation's ttlMs
    // isn't exposed through buildWritePreview, so simulate elapsed
    // time the same way the real expiry check reads it: expires_at).
    await env.LUMMET_DB.prepare(`UPDATE lummet_ai_pending_operations SET expires_at = ? WHERE id = ?`)
      .bind(new Date(Date.now() - 1000).toISOString(), preview.pendingOperationId)
      .run();

    const confirmed = await confirmPendingOperation(env, superAdmin, preview.pendingOperationId, preview.payloadHash);
    assert.equal(confirmed.ok, false);
    assert.equal(confirmed.error, "expired");
    assert.equal(tenantDb.casinos["level-casino"].rating, 4.5); // untouched
  });

  test("HASH MISMATCH: confirming with a hash that doesn't match the stored preview is refused", async () => {
    const resolved = await resolveAction(env, superAdmin, { resource: "casinos", operation: "update", tenantHint: null });
    const preview = await buildWritePreview(env, superAdmin, resolved, {
      operation: "update",
      recordId: "level-casino",
      fields: { rating: 4.8 }
    });

    const confirmed = await confirmPendingOperation(env, superAdmin, preview.pendingOperationId, "not-the-real-hash");
    assert.equal(confirmed.ok, false);
    assert.equal(confirmed.error, "hash_mismatch");
    assert.equal(tenantDb.casinos["level-casino"].rating, 4.5);
  });

  test("DUPLICATE CONFIRM: confirming an already-executed operation a second time is refused, does not double-write", async () => {
    const resolved = await resolveAction(env, superAdmin, { resource: "casinos", operation: "update", tenantHint: null });
    const preview = await buildWritePreview(env, superAdmin, resolved, {
      operation: "update",
      recordId: "level-casino",
      fields: { rating: 4.8 }
    });
    const first = await confirmPendingOperation(env, superAdmin, preview.pendingOperationId, preview.payloadHash);
    assert.equal(first.ok, true);

    const second = await confirmPendingOperation(env, superAdmin, preview.pendingOperationId, preview.payloadHash);
    assert.equal(second.ok, false);
    assert.equal(second.error, "already_executed");
  });

  test("ACTIVE TENANT CHANGED: confirm refuses if the admin's active tenant no longer matches the previewed tenant", async () => {
    const resolved = await resolveAction(env, superAdmin, { resource: "casinos", operation: "update", tenantHint: null });
    const preview = await buildWritePreview(env, superAdmin, resolved, {
      operation: "update",
      recordId: "level-casino",
      fields: { rating: 4.8 }
    });

    const switchedAdmin = { ...superAdmin, activeTenantId: "some-other-tenant-id" };
    const confirmed = await confirmPendingOperation(env, switchedAdmin, preview.pendingOperationId, preview.payloadHash);
    assert.equal(confirmed.ok, false);
    assert.equal(confirmed.error, "active_tenant_changed");
    assert.equal(tenantDb.casinos["level-casino"].rating, 4.5);
  });

  test("PERMISSION REVOKED BETWEEN PREVIEW AND CONFIRM: staff admin loses the grant, confirm is refused", async () => {
    await env.LUMMET_DB.prepare(`INSERT INTO lummet_admins (id, email, password_hash, role) VALUES (2, 's@test.local', 'x', 'staff')`).run();
    await env.LUMMET_DB.prepare(`INSERT INTO lummet_admin_tenant_access (admin_id, tenant_id) VALUES (2, ?)`).bind(TENANT_A).run();
    await env.LUMMET_DB.prepare(
      `INSERT INTO lummet_admin_permissions (admin_id, area, resource, action, allowed) VALUES (2, 'tenant', 'casinos', 'update', 1)`
    ).run();
    const staffAdmin = { id: 2, role: "staff", activeTenantId: TENANT_A };

    const resolved = await resolveAction(env, staffAdmin, { resource: "casinos", operation: "update", tenantHint: null });
    assert.equal(resolved.ok, true);
    const preview = await buildWritePreview(env, staffAdmin, resolved, {
      operation: "update",
      recordId: "level-casino",
      fields: { rating: 4.8 }
    });
    assert.equal(preview.ok, true);

    // Revoke the grant after the preview was shown.
    await env.LUMMET_DB.prepare(`DELETE FROM lummet_admin_permissions WHERE admin_id = 2 AND resource = 'casinos'`).run();

    const confirmed = await confirmPendingOperation(env, staffAdmin, preview.pendingOperationId, preview.payloadHash);
    assert.equal(confirmed.ok, false);
    assert.equal(confirmed.error, "forbidden");
    assert.equal(tenantDb.casinos["level-casino"].rating, 4.5);
  });

  test("UPDATE targeting a record that no longer exists on the tenant is refused cleanly, not silently created", async () => {
    const resolved = await resolveAction(env, superAdmin, { resource: "casinos", operation: "update", tenantHint: null });
    const preview = await buildWritePreview(env, superAdmin, resolved, {
      operation: "update",
      recordId: "level-casino",
      fields: { rating: 4.8 }
    });

    delete tenantDb.casinos["level-casino"]; // deleted by someone else after preview

    const confirmed = await confirmPendingOperation(env, superAdmin, preview.pendingOperationId, preview.payloadHash);
    assert.equal(confirmed.ok, false);
    assert.notEqual(confirmed.error, undefined);
  });

  test("an unknown field the AI proposed is refused before any tenant call", async () => {
    const resolved = await resolveAction(env, superAdmin, { resource: "casinos", operation: "update", tenantHint: null });
    const preview = await buildWritePreview(env, superAdmin, resolved, {
      operation: "update",
      recordId: "level-casino",
      fields: { totally_made_up_field: "x" }
    });
    assert.equal(preview.ok, false);
    assert.equal(preview.error, "invalid_fields");
    assert.equal(fetchLog.length, 0);
  });

  test("TENANT REJECTION: the tenant's real reason survives client.js -> crud.js -> confirm.js, not just the generic masked message", async () => {
    const resolved = await resolveAction(env, superAdmin, { resource: "casinos", operation: "create", tenantHint: null });
    const preview = await buildWritePreview(env, superAdmin, resolved, {
      operation: "create",
      fields: { slug: "dup-casino", name: "Dup", affiliate_url: "https://aff.example/dup", website_url: "https://dup.example" }
    });
    assert.equal(preview.ok, true);

    // The tenant now rejects the create with a specific 422 reason.
    const baseMock = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const u = new URL(url);
      if (u.pathname === "/en/api/super/casinos" && (options?.method || "GET") === "POST") {
        return { ok: false, status: 422, json: async () => ({ success: false, error: "slug_already_exists" }) };
      }
      return baseMock(url, options);
    };

    const confirmed = await confirmPendingOperation(env, superAdmin, preview.pendingOperationId, preview.payloadHash);
    assert.equal(confirmed.ok, false);
    // Generic masked message is still what `message` says...
    assert.match(confirmed.message, /rejected this input as invalid/i);
    // ...but the tenant's actual reason is preserved in `error` so the chat can show it.
    assert.equal(confirmed.error, "slug_already_exists");
    // And nothing was created.
    assert.equal(tenantDb.casinos["dup-casino"], undefined);
  });
});

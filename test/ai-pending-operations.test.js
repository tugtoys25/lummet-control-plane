import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, applyMigrations } from "./support/d1-shim.js";
import {
  createPendingOperation,
  getPendingOperation,
  getOwnedPendingOperation,
  isExpired,
  markStatus,
  computePayloadHash
} from "../worker/ai/pending-operations.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
let db, env;

beforeEach(async () => {
  db = createTestDb();
  applyMigrations(db);
  env = { LUMMET_DB: db };
  await env.LUMMET_DB.prepare(
    `INSERT INTO tenants (id, name, host, api_base_url, status) VALUES (?, 'level.casino', 'level.casino', 'https://level.casino', 'active')`
  ).bind(TENANT_A).run();
  await env.LUMMET_DB.prepare(
    `INSERT INTO lummet_admins (id, email, password_hash, role) VALUES (1, 'a@test.local', 'x', 'super_admin')`
  ).run();
  await env.LUMMET_DB.prepare(
    `INSERT INTO lummet_admins (id, email, password_hash, role) VALUES (2, 'b@test.local', 'x', 'super_admin')`
  ).run();
});

const adminA = { id: 1 };
const adminB = { id: 2 };

describe("ai/pending-operations.js computePayloadHash", () => {
  test("is deterministic regardless of key order", async () => {
    const h1 = await computePayloadHash({ tenantId: "t1", resourceKey: "casinos", operation: "update", recordId: "1", proposedValues: { a: 1, b: 2 } });
    const h2 = await computePayloadHash({ tenantId: "t1", resourceKey: "casinos", operation: "update", recordId: "1", proposedValues: { b: 2, a: 1 } });
    assert.equal(h1, h2);
  });

  test("changes if the proposed value changes", async () => {
    const h1 = await computePayloadHash({ tenantId: "t1", resourceKey: "casinos", operation: "update", recordId: "1", proposedValues: { rating: 4.7 } });
    const h2 = await computePayloadHash({ tenantId: "t1", resourceKey: "casinos", operation: "update", recordId: "1", proposedValues: { rating: 4.8 } });
    assert.notEqual(h1, h2);
  });
});

describe("ai/pending-operations.js persistence", () => {
  test("create + get round-trips proposed/current values as real objects, not strings", async () => {
    const { id, payloadHash } = await createPendingOperation(env, {
      adminId: 1,
      tenantId: TENANT_A,
      resourceKey: "casinos",
      operation: "update",
      recordId: "123",
      currentValues: { rating: 4.5 },
      proposedValues: { rating: 4.8 }
    });

    const op = await getPendingOperation(env, id);
    assert.equal(op.payload_hash, payloadHash);
    assert.deepEqual(op.currentValues, { rating: 4.5 });
    assert.deepEqual(op.proposedValues, { rating: 4.8 });
    assert.equal(op.status, "pending");
  });

  test("ownership check: admin B cannot fetch admin A's pending operation", async () => {
    const { id } = await createPendingOperation(env, {
      adminId: 1,
      tenantId: TENANT_A,
      resourceKey: "casinos",
      operation: "update",
      recordId: "123",
      proposedValues: { rating: 4.8 }
    });
    assert.equal(await getOwnedPendingOperation(env, adminB, id), null);
    assert.ok(await getOwnedPendingOperation(env, adminA, id));
  });

  test("a freshly created operation is not expired; an old one is", async () => {
    const { id } = await createPendingOperation(env, {
      adminId: 1,
      tenantId: TENANT_A,
      resourceKey: "casinos",
      operation: "update",
      recordId: "123",
      proposedValues: { rating: 4.8 },
      ttlMs: 1 // effectively already expired
    });
    // small sleep to guarantee we're past the 1ms TTL
    await new Promise((r) => setTimeout(r, 5));
    const op = await getPendingOperation(env, id);
    assert.equal(isExpired(op), true);
  });

  test("markStatus updates status and stores the result JSON", async () => {
    const { id } = await createPendingOperation(env, {
      adminId: 1,
      tenantId: TENANT_A,
      resourceKey: "casinos",
      operation: "update",
      recordId: "123",
      proposedValues: { rating: 4.8 }
    });
    await markStatus(env, id, "executed", { id: 123, rating: 4.8 });
    const op = await getPendingOperation(env, id);
    assert.equal(op.status, "executed");
    assert.deepEqual(JSON.parse(op.result), { id: 123, rating: 4.8 });
    assert.ok(op.executed_at);
  });
});

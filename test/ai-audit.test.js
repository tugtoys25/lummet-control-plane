import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, applyMigrations } from "./support/d1-shim.js";
import { logAudit } from "../worker/audit.js";

let db, env;

beforeEach(() => {
  db = createTestDb();
  applyMigrations(db);
  env = { LUMMET_DB: db };
});

describe("worker/audit.js (regression: existing dashboard behavior preserved)", () => {
  test("a call site that omits initiatedBy (every pre-existing call site) still defaults to 'dashboard'", async () => {
    await logAudit(env, {
      adminId: 1,
      tenantId: null,
      endpoint: "/api/content/casinos",
      method: "PUT",
      resource: "casinos",
      resourceId: "123",
      action: "update",
      success: true,
      statusCode: 200,
      requestId: "req-1",
      ipHash: "hash1"
    });

    const row = await env.LUMMET_DB.prepare(`SELECT * FROM lummet_audit_logs WHERE request_id = ?`)
      .bind("req-1")
      .first();
    assert.ok(row);
    assert.equal(row.initiated_by, "dashboard");
    assert.equal(row.ai_conversation_id, null);
    // and every pre-existing column still populated correctly
    assert.equal(row.resource, "casinos");
    assert.equal(row.success, 1);
  });

  test("an AI-originated write is distinguishable in the SAME table", async () => {
    await logAudit(env, {
      adminId: 1,
      tenantId: "tenant-a",
      endpoint: "/api/ai/confirm/op-1",
      method: "POST",
      resource: "casinos",
      resourceId: "123",
      action: "update",
      success: true,
      statusCode: 200,
      requestId: "req-2",
      ipHash: "hash1",
      initiatedBy: "ai",
      aiConversationId: "conv-1"
    });

    const row = await env.LUMMET_DB.prepare(`SELECT * FROM lummet_audit_logs WHERE request_id = ?`)
      .bind("req-2")
      .first();
    assert.equal(row.initiated_by, "ai");
    assert.equal(row.ai_conversation_id, "conv-1");
  });

  test("logAudit never throws even if the DB call fails (must never break the response)", async () => {
    const brokenEnv = {
      LUMMET_DB: {
        prepare() {
          throw new Error("simulated DB outage");
        }
      }
    };
    await assert.doesNotReject(() => logAudit(brokenEnv, { adminId: 1, action: "update" }));
  });
});

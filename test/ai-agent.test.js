import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, applyMigrations } from "./support/d1-shim.js";
import { encryptSecret } from "../worker/crypto.js";
import { runAgent } from "../worker/ai/agent.js";
import { getPendingOperation } from "../worker/ai/pending-operations.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const API_BASE = "https://mock.tenant.test";

let db, env, originalFetch, tenantDb;

function makeFetchMock() {
  return async (url, options) => {
    const u = new URL(url);
    const method = options?.method || "GET";
    const recordMatch = u.pathname.match(/^\/en\/api\/super\/casinos\/([^/]+)$/);
    if (recordMatch && method === "GET") {
      const slug = decodeURIComponent(recordMatch[1]);
      const record = tenantDb.casinos[slug];
      if (!record) return { ok: false, status: 404, json: async () => ({ success: false }) };
      return { ok: true, status: 200, json: async () => ({ success: true, data: record }) };
    }
    if (u.pathname === "/en/api/super/casinos" && method === "GET") {
      return { ok: true, status: 200, json: async () => ({ success: true, data: Object.values(tenantDb.casinos) }) };
    }
    return { ok: false, status: 404, json: async () => ({ success: false }) };
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

  tenantDb = { casinos: { "level-casino": { slug: "level-casino", name: "Level Casino", rating: 4.5, status: "draft" } } };

  originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetchMock();
});

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

const superAdmin = { id: 1, role: "super_admin", activeTenantId: TENANT_A };
const staffAdminNoGrants = { id: 2, role: "staff", activeTenantId: TENANT_A };

describe("ai/agent.js — safety property: never writes, only ever proposes", () => {
  test("without env.AI, the agent finishes immediately rather than guessing or looping", async () => {
    const result = await runAgent(env, superAdmin, { conversationId: null, goal: "do something" });
    restoreFetch();
    assert.equal(result.kind, "agent_finished");
    assert.match(result.summary, /Workers AI binding/);
  });

  test("a model that keeps reading forever is stopped at the step limit, not left to run forever", async () => {
    env.AI = { run: async () => ({ response: JSON.stringify({ tool: "read", resource: "casinos", why: "checking" }) }) };
    const result = await runAgent(env, superAdmin, { conversationId: null, goal: "keep reading" });
    restoreFetch();
    assert.equal(result.kind, "agent_step_limit");
    assert.ok(result.steps.length <= 6);
    assert.ok(result.steps.every((s) => s.tool === "read"));
  });

  test("a read the admin isn't authorized for is denied inside the loop, not silently allowed", async () => {
    let call = 0;
    env.AI = {
      run: async () => {
        call++;
        if (call === 1) return { response: JSON.stringify({ tool: "read", resource: "casinos", why: "trying" }) };
        return { response: JSON.stringify({ tool: "finish", summary: "done" }) };
      }
    };
    const result = await runAgent(env, staffAdminNoGrants, { conversationId: null, goal: "read casinos" });
    restoreFetch();
    assert.equal(result.steps[0].tool, "read");
    assert.equal(result.steps[0].ok, false); // permission denied, not silently allowed
    assert.equal(result.kind, "agent_finished");
  });

  test("a model that decides to write STOPS the loop and returns a real preview — never executes", async () => {
    env.AI = {
      run: async () => ({
        response: JSON.stringify({
          tool: "propose_write",
          resource: "casinos",
          operation: "update",
          recordId: "level-casino",
          fields: { rating: 4.9 },
          why: "raising the rating"
        })
      })
    };
    const result = await runAgent(env, superAdmin, { conversationId: null, goal: "raise level-casino's rating" });
    restoreFetch();

    assert.equal(result.kind, "agent_write_proposed");
    assert.equal(result.preview.kind, "write_preview");
    assert.ok(result.preview.pendingOperationId);

    // Confirm it really is just a PENDING operation, unexecuted.
    const pending = await getPendingOperation(env, result.preview.pendingOperationId);
    assert.equal(pending.status, "pending");
    // The tenant's own data must be completely untouched.
    assert.equal(tenantDb.casinos["level-casino"].rating, 4.5);
  });

  test("an invalid write proposal (unknown field) is rejected inside the loop without ending it as a success", async () => {
    let call = 0;
    env.AI = {
      run: async () => {
        call++;
        if (call === 1) {
          return {
            response: JSON.stringify({
              tool: "propose_write",
              resource: "casinos",
              operation: "update",
              recordId: "level-casino",
              fields: { totally_made_up_field: "x" },
              why: "bad attempt"
            })
          };
        }
        return { response: JSON.stringify({ tool: "finish", summary: "gave up after invalid field" }) };
      }
    };
    const result = await runAgent(env, superAdmin, { conversationId: null, goal: "break something" });
    restoreFetch();
    assert.equal(result.kind, "agent_finished");
    assert.equal(result.steps[0].tool, "propose_write");
    assert.equal(result.steps[0].ok, false);
  });

  test("a malformed / non-JSON model response ends the run gracefully instead of crashing", async () => {
    env.AI = { run: async () => ({ response: "I dunno, do whatever seems right!" }) };
    const result = await runAgent(env, superAdmin, { conversationId: null, goal: "anything" });
    restoreFetch();
    assert.equal(result.kind, "agent_finished");
  });

  test("web_search without a configured key is reported to the agent as unavailable, not fabricated", async () => {
    let call = 0;
    env.AI = {
      run: async () => {
        call++;
        if (call === 1) return { response: JSON.stringify({ tool: "web_search", query: "casino license lookup", why: "checking a license" }) };
        return { response: JSON.stringify({ tool: "finish", summary: "could not verify, search unavailable" }) };
      }
    };
    const result = await runAgent(env, superAdmin, { conversationId: null, goal: "verify a license" });
    restoreFetch();
    assert.equal(result.steps[0].tool, "web_search");
    assert.equal(result.steps[0].ok, false);
  });
});

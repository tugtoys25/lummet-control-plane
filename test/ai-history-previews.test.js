import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, applyMigrations } from "./support/d1-shim.js";
import { createConversation, appendMessage, getMessages, attachPendingPreviews } from "../worker/ai/chat.js";
import { createPendingOperation, markStatus } from "../worker/ai/pending-operations.js";

let env;
const T = "11111111-1111-1111-1111-111111111111";
const adminA = { id: 1, role: "super_admin", activeTenantId: T };
const adminB = { id: 2, role: "super_admin", activeTenantId: T };

beforeEach(async () => {
  const db = createTestDb(); applyMigrations(db); env = { LUMMET_DB: db };
  await db.prepare(`INSERT INTO tenants (id,name,host,api_base_url,status) VALUES (?, 'FreeWin.xyz','freewin.xyz','https://freewin.xyz','active')`).bind(T).run();
  await db.prepare(`INSERT INTO lummet_admins (id,email,password_hash,role) VALUES (1,'a@x','x','super_admin')`).run();
  await db.prepare(`INSERT INTO lummet_admins (id,email,password_hash,role) VALUES (2,'b@x','x','super_admin')`).run();
});

async function seed(operation, extra = {}) {
  const conv = await createConversation(env, 1, T, "t");
  const { id } = await createPendingOperation(env, {
    adminId: 1, conversationId: conv, tenantId: T, resourceKey: "casinos", operation,
    recordId: operation === "create" ? null : "level-casino",
    currentValues: operation === "update" ? { rating: 4.5 } : operation === "delete" ? { slug: "level-casino", name: "L" } : null,
    proposedValues: operation === "update" ? { rating: 4.8 } : operation === "create" ? { slug: "n", name: "N" } : {},
    ...extra
  });
  await appendMessage(env, conv, "user", "do it");
  await appendMessage(env, conv, "assistant", "preview text", id);
  return { conv, id };
}

describe("ai/chat.js attachPendingPreviews (reopened conversations)", () => {
  test("update preview is rebuilt with current -> proposed and a live pending state", async () => {
    const { conv, id } = await seed("update");
    const msgs = await attachPendingPreviews(env, adminA, await getMessages(env, conv));
    const p = msgs.find((m) => m.pending).pending;
    assert.equal(p.pendingOperationId, id);
    assert.equal(p.state, "pending");
    assert.equal(p.tenant.name, "FreeWin.xyz");
    assert.deepEqual(p.changes, [{ field: "rating", current: 4.5, proposed: 4.8 }]);
    assert.ok(p.payloadHash);
  });

  test("create shows null -> proposed; delete is destructive with a record snapshot", async () => {
    const c = await seed("create");
    const pc = (await attachPendingPreviews(env, adminA, await getMessages(env, c.conv))).find((m) => m.pending).pending;
    assert.deepEqual(pc.changes.map((x) => x.current), [null, null]);
    const d = await seed("delete");
    const pd = (await attachPendingPreviews(env, adminA, await getMessages(env, d.conv))).find((m) => m.pending).pending;
    assert.equal(pd.destructive, true);
    assert.equal(pd.recordSnapshot.slug, "level-casino");
  });

  test("only the FIRST message per operation gets the card; the later result message stays text", async () => {
    const { conv, id } = await seed("update");
    await appendMessage(env, conv, "assistant", "Write completed.", id);
    const msgs = await attachPendingPreviews(env, adminA, await getMessages(env, conv));
    assert.equal(msgs.filter((m) => m.pending).length, 1);
  });

  test("an executed operation is reported as executed, not as a live pending card", async () => {
    const { conv, id } = await seed("update");
    await markStatus(env, id, "executed", { ok: true });
    const p = (await attachPendingPreviews(env, adminA, await getMessages(env, conv))).find((m) => m.pending).pending;
    assert.equal(p.state, "executed");
  });

  test("an expired operation is reported as expired", async () => {
    const { conv } = await seed("update", { ttlMs: -1000 });
    const p = (await attachPendingPreviews(env, adminA, await getMessages(env, conv))).find((m) => m.pending).pending;
    assert.equal(p.state, "expired");
  });

  test("another admin's operation is never attached (ownership)", async () => {
    const { conv } = await seed("update");
    const msgs = await attachPendingPreviews(env, adminB, await getMessages(env, conv));
    assert.equal(msgs.filter((m) => m.pending).length, 0);
  });
});

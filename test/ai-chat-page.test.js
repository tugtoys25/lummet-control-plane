import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, applyMigrations } from "./support/d1-shim.js";
import { renderAiChatPage } from "../worker/views/pages/ai-chat.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
let db, env;

beforeEach(async () => {
  db = createTestDb();
  applyMigrations(db);
  env = { LUMMET_DB: db };
  await env.LUMMET_DB.prepare(
    `INSERT INTO tenants (id, name, host, api_base_url, status) VALUES (?, 'level.casino', 'level.casino', 'https://level.casino', 'active')`
  ).bind(TENANT_A).run();
  await env.LUMMET_DB.prepare(`INSERT INTO lummet_admins (id, email, password_hash, role) VALUES (1, 'a@test.local', 'x', 'super_admin')`).run();
});

describe("worker/views/pages/ai-chat.js", () => {
  test("renders successfully for an admin with an active tenant", async () => {
    const admin = { id: 1, role: "super_admin", email: "a@test.local", activeTenantId: TENANT_A };
    const html = await renderAiChatPage(env, admin);
    assert.match(html, /<title>AI Chat/);
    assert.match(html, /id="ai-composer"/);
    assert.match(html, /id="ai-messages"/);
    assert.match(html, /aiSendMessage/);
    assert.doesNotMatch(html, /no-tenant-notice/);
  });

  test("includes the mobile drawer toggle and deep-link handling for conversations", async () => {
    const admin = { id: 1, role: "super_admin", email: "a@test.local", activeTenantId: TENANT_A };
    const html = await renderAiChatPage(env, admin);
    assert.match(html, /aiToggleDrawer/);
    assert.match(html, /ai-mobile-topbar/);
    assert.match(html, /aiSetUrlConversation/);
    assert.match(html, /URLSearchParams\(location\.search\)\.get\("conversation"\)/);
  });

  test("shows the no-active-tenant notice when nothing is selected, but still renders the composer", async () => {
    const admin = { id: 1, role: "super_admin", email: "a@test.local", activeTenantId: null };
    const html = await renderAiChatPage(env, admin);
    assert.match(html, /no-tenant-notice/);
    assert.match(html, /id="ai-composer"/);
  });

  test("the confirm-failure handler surfaces the tenant's reason, not only the generic message", async () => {
    const admin = { id: 1, role: "super_admin", email: "a@test.local", activeTenantId: TENANT_A };
    const html = await renderAiChatPage(env, admin);
    assert.match(html, /\(reason: /);
  });

  test("history loader rebuilds preview cards from m.pending and shows non-pending states", async () => {
    const admin = { id: 1, role: "super_admin", email: "a@test.local", activeTenantId: TENANT_A };
    const html = await renderAiChatPage(env, admin);
    assert.match(html, /if \(m\.pending\) aiRenderWritePreview\(m\.pending, m\.pending\.state\)/);
    assert.match(html, /Already executed\./);
  });

  test("the AI Chat nav link is present and points at /ai", async () => {
    const admin = { id: 1, role: "super_admin", email: "a@test.local", activeTenantId: TENANT_A };
    const html = await renderAiChatPage(env, admin);
    assert.match(html, /href="\/ai"/);
  });
});

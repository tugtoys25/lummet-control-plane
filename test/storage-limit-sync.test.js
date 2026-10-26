import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, applyMigrations } from "./support/d1-shim.js";
import * as customerAuth from "../worker/customer-auth.js";
import { reconcileStorageLimits, processStorageLimitPushes, collectStorageUsage, organizationStorageUsage, desiredStorageMb } from "../worker/storage-sync.js";
import { getUsageSnapshot } from "../worker/usage.js";

const MB = 1024 * 1024;
function makeEnv() { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db }; }
const signup = (env, email) => customerAuth.signUp({ async json() { return { email, password: "correct-horse-battery", organizationName: "Org" }; }, headers: { get: () => "203.0.113.50" } }, env);
async function seedSite(env, orgId, n = 1, { status = "active" } = {}) {
  const db = env.LUMMET_DB;
  let prod = await db.prepare("SELECT id FROM products LIMIT 1").first();
  if (!prod) { await db.prepare("INSERT INTO products (id, key, name, category) VALUES ('p1','casino','Casino','affiliate')").run(); prod = { id: "p1" }; }
  const productId = prod.id;
  await db.prepare("INSERT INTO tenants (id, name, host, api_base_url) VALUES (?,?,?,?)").bind(`t${n}`, `T${n}`, `t${n}.example.com`, `https://t${n}.example.com`).run();
  await db.prepare("INSERT INTO sites (id, organization_id, tenant_id, name, slug, product_id, status) VALUES (?,?,?,?,?,?,?)").bind(`s${n}`, orgId, `t${n}`, `Site ${n}`, `site-${n}`, productId, status).run();
  return `s${n}`;
}
const entitlementsOf = (map) => ({ async resolveForOrganization(_e, org) { return { "storage.max_mb": { type: "number", value: map[org] ?? 0 } }; } });
const sync = (env, id) => env.LUMMET_DB.prepare("SELECT * FROM site_storage_limit_sync WHERE site_id=?").bind(id).first();

test("reconcile queues a first push, is a no-op when unchanged, and bumps the generation when the plan changes", async () => {
  const env = makeEnv(); const { organizationId: org } = await signup(env, "a@example.com"); const s = await seedSite(env, org);
  const ent = { [org]: 500 };
  let r = await reconcileStorageLimits(env, { entitlements: entitlementsOf(ent) });
  assert.equal(r.queued, 1); let row = await sync(env, s); assert.equal(row.desired_mb, 500); assert.equal(row.generation, 1); assert.equal(row.status, "pending");
  r = await reconcileStorageLimits(env, { entitlements: entitlementsOf(ent) });
  assert.equal(r.queued, 0); assert.equal((await sync(env, s)).generation, 1);
  ent[org] = 2000;
  r = await reconcileStorageLimits(env, { entitlements: entitlementsOf(ent) });
  row = await sync(env, s); assert.equal(r.queued, 1); assert.equal(row.generation, 2); assert.equal(row.desired_mb, 2000); assert.equal(row.status, "pending");
});

test("a zero or missing entitlement is never pushed as a cap and leaves the previous cap queued state alone", async () => {
  const env = makeEnv(); const { organizationId: org } = await signup(env, "b@example.com"); const s = await seedSite(env, org);
  const ent = { [org]: 500 };
  await reconcileStorageLimits(env, { entitlements: entitlementsOf(ent) });
  ent[org] = 0;
  const r = await reconcileStorageLimits(env, { entitlements: entitlementsOf(ent) });
  assert.equal(r.skipped, 1); const row = await sync(env, s); assert.equal(row.desired_mb, 500); assert.equal(row.generation, 1);
  assert.equal(await desiredStorageMb(env, org, { entitlements: entitlementsOf({}) }), null);
});

test("sites that are not provisioned or are deleting are not synced", async () => {
  const env = makeEnv(); const { organizationId: org } = await signup(env, "c@example.com");
  await seedSite(env, org, 1, { status: "deleting" });
  await env.LUMMET_DB.prepare("INSERT INTO sites (id, organization_id, name, slug, product_id, status) VALUES ('s9',?, 'x','x9',(SELECT id FROM products LIMIT 1),'active')").bind(org).run();
  const r = await reconcileStorageLimits(env, { entitlements: entitlementsOf({ [org]: 100 }) });
  assert.equal(r.checked, 0);
});

test("push sends bytes with the generation, marks success, and a failed push retries then ends failed after five attempts", async () => {
  const env = makeEnv(); const { organizationId: org } = await signup(env, "d@example.com"); const s = await seedSite(env, org);
  await reconcileStorageLimits(env, { entitlements: entitlementsOf({ [org]: 3 }) });
  const calls = []; let okNext = true;
  const clientAdapter = { async pushTenantStorageLimit(_e, tenant, body) { calls.push({ tenant, ...body }); return okNext ? { ok: true, status: 200, data: { data: { accepted: true } } } : { ok: false, status: 502, reason: "tenant_unavailable" }; } };
  const siteLookup = async (_e, id) => ({ id, tenant_id: `t1` });
  const future = "2999-01-01 00:00:00";
  okNext = false;
  for (let i = 1; i <= 5; i++) { const r = await processStorageLimitPushes(env, { clientAdapter, siteLookup, now: future }); assert.equal(r.attempted, 1); assert.equal(r.failed, i === 5 ? 1 : 0); }
  let row = await sync(env, s); assert.equal(row.status, "failed"); assert.equal(row.attempts, 5); assert.match(row.last_error, /tenant_unavailable/);
  // staff retry path: a plan change re-queues with a new generation and a clean slate
  await reconcileStorageLimits(env, { entitlements: entitlementsOf({ [org]: 4 }) });
  okNext = true;
  const r = await processStorageLimitPushes(env, { clientAdapter, siteLookup, now: future });
  assert.equal(r.succeeded, 1); row = await sync(env, s);
  assert.equal(row.status, "succeeded"); assert.equal(row.pushed_generation, 2);
  assert.deepEqual({ ...calls.at(-1) }, { tenant: "t1", maxBytes: 4 * MB, generation: 2, siteId: s });
  assert.equal((await processStorageLimitPushes(env, { clientAdapter, siteLookup, now: future })).attempted, 0, "nothing left to push");
});

test("a tenant that is ahead of the control plane fails loudly instead of silently leaving the cap unapplied", async () => {
  const env = makeEnv(); const { organizationId: org } = await signup(env, "e@example.com"); const s = await seedSite(env, org);
  await reconcileStorageLimits(env, { entitlements: entitlementsOf({ [org]: 3 }) });
  const clientAdapter = { async pushTenantStorageLimit() { return { ok: true, status: 200, data: { data: { accepted: false, reason: "stale_generation" } } }; } };
  const r = await processStorageLimitPushes(env, { clientAdapter, siteLookup: async () => ({ tenant_id: "t1" }), now: "2999-01-01 00:00:00" });
  assert.equal(r.retrying, 1); assert.match((await sync(env, s)).last_error, /tenant_generation_ahead/);
});

test("a push claimed for an old generation cannot overwrite a newer queued one", async () => {
  const env = makeEnv(); const { organizationId: org } = await signup(env, "f@example.com"); const s = await seedSite(env, org);
  const ent = { [org]: 3 };
  await reconcileStorageLimits(env, { entitlements: entitlementsOf(ent) });
  const repo = await import("../worker/repositories/storage-sync.js");
  assert.equal((await repo.claimPush(env, { siteId: s, generation: 1 })).meta.changes, 1);
  ent[org] = 9; // plan changes while generation 1 is in flight
  await env.LUMMET_DB.prepare("UPDATE site_storage_limit_sync SET status='running' WHERE site_id=?").bind(s).run();
  await repo.changeDesired(env, { siteId: s, desiredMb: 9 });
  await repo.markPushed(env, { siteId: s, generation: 1, httpStatus: 200 });
  const row = await sync(env, s);
  assert.equal(row.generation, 2); assert.equal(row.status, "pending", "generation 2 is still owed"); assert.equal(row.pushed_generation, 1);
});

test("usage is pulled, stored, summed per organization, and feeds the Usage snapshot with partial coverage flagged", async () => {
  const env = makeEnv(); const { organizationId: org } = await signup(env, "g@example.com"); const s1 = await seedSite(env, org, 1); const s2 = await seedSite(env, org, 2);
  assert.equal((await getUsageSnapshot(env, org)).storageBytes, null, "nothing reported yet is null, not zero");
  const reports = { t1: { usedBytes: 5 * MB, reservedBytes: 1, limitBytes: 10 * MB, limitGeneration: 2 }, t2: null };
  const clientAdapter = { async getFromTenant(_e, tenant) { const d = reports[tenant]; return d ? { ok: true, status: 200, data: { data: d } } : { ok: false, status: 502, reason: "tenant_unavailable" }; } };
  let r = await collectStorageUsage(env, { clientAdapter });
  assert.deepEqual(r, { checked: 2, recorded: 1, failed: 1 });
  let usage = await getUsageSnapshot(env, org);
  assert.equal(usage.storageBytes, 5 * MB); assert.equal(usage.storageMb.used, 5); assert.equal(usage.storageMb.partial, true); assert.equal(usage.storageMb.sitesReporting, 1);
  reports.t2 = { usedBytes: 2 * MB, reservedBytes: 0, limitBytes: null, limitGeneration: 0 };
  await collectStorageUsage(env, { clientAdapter });
  usage = await getUsageSnapshot(env, org);
  assert.equal(usage.storageBytes, 7 * MB); assert.equal(usage.storageMb.partial, false);
  // stale reports (older than 3 days) stop counting
  const old = await organizationStorageUsage(env, org, { now: Date.now() + 4 * 86400000 });
  assert.equal(old.bytes, null);
  void s1; void s2;
});

test("malformed tenant usage reports are ignored", async () => {
  const env = makeEnv(); const { organizationId: org } = await signup(env, "h@example.com"); await seedSite(env, org, 1);
  for (const bad of [{ usedBytes: -1 }, { usedBytes: "5" }, { usedBytes: 1.5 }, {}]) {
    const r = await collectStorageUsage(env, { clientAdapter: { async getFromTenant() { return { ok: true, status: 200, data: { data: bad } }; } } });
    assert.equal(r.recorded, 0);
  }
});

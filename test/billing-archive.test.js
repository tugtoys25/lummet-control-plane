// Billing history of closed, deleted or erased organizations lives in a billing archive instead of the main staff lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import * as staff from '../worker/staff-saas.js';
import * as notificationRepo from '../worker/repositories/billing-notifications.js';
import { renderSubscriptionsPage, renderNotificationsPage } from '../worker/views/pages/saas-admin.js';

const ADMIN = { id: 1, email: 'a@b.c', role: 'super_admin' };
async function env() {
  const db = createTestDb(); applyMigrations(db);
  await db.prepare('PRAGMA foreign_keys = OFF').run();
  const run = (s, ...b) => db.prepare(s).bind(...b).run();
  await run(`INSERT INTO organizations (id,name,slug,status) VALUES ('o1','Acme Media','acme','active'),('o2','Gone Co','gone','closed')`);
  await run(`INSERT INTO organizations (id,name,slug,status,erased_at) VALUES ('o3','Erased organization','erased-o3','closed','2026-11-01 00:00:00')`);
  const plan = (await db.prepare('SELECT id FROM plans LIMIT 1').first()).id;
  await run(`INSERT INTO subscriptions (id,organization_id,plan_id,status) VALUES ('s1','o1',?,'active'),('s2','o2',?,'canceled'),('s3','o3',?,'expired')`, plan, plan, plan);
  await run(`INSERT INTO billing_notifications (id,organization_id,subscription_id,kind,stage,dedupe_key,created_at) VALUES ('n1','o1','s1','renewal','7d','k1','2026-11-20 10:00:00'),('n2','o2','s2','past_due','1','k2','2026-11-21 10:00:00'),('n3','o3','s3','trial_ended','1','k3','2026-11-22 10:00:00')`);
  return { LUMMET_DB: db };
}
const orgs = (rows) => rows.map((r) => r.organization).sort();

test('subscriptions: current list hides closed and erased organizations; the archive lists only them', async () => {
  const e = await env();
  assert.deepEqual(orgs(await staff.listSubscriptions(e)), ['Acme Media']);
  assert.deepEqual(orgs(await staff.listSubscriptions(e, { archive: true })), ['Erased organization', 'Gone Co']);
  assert.deepEqual(orgs(await staff.listSubscriptions(e, { archive: true, status: 'canceled' })), ['Gone Co']);
});

test('subscriptions page: links to the archive, marks erased ones, keeps the view through paging and the filter form', async () => {
  const e = await env();
  const main = await renderSubscriptionsPage(e, ADMIN, {});
  assert.ok(main.includes('view=archive') && main.includes('Acme Media') && !main.includes('Gone Co'));
  const arch = await renderSubscriptionsPage(e, ADMIN, { view: 'archive' });
  assert.ok(arch.includes('Gone Co') && arch.includes('Erased organization') && arch.includes('erased') && !arch.includes('Acme Media'));
  assert.ok(arch.includes('name="view" value="archive"') && arch.includes('Back to current subscriptions'));
});

test('notifications: same split; asking for one organization by id still finds an archived one', async () => {
  const e = await env();
  const ids = async (o) => (await notificationRepo.listForStaff(e, o)).map((r) => r.id).sort();
  assert.deepEqual(await ids({}), ['n1']);
  assert.deepEqual(await ids({ archive: true }), ['n2', 'n3']);
  assert.deepEqual(await ids({ organizationId: 'o2' }), ['n2']);
  assert.deepEqual(await ids({ organizationId: 'o1', archive: true }), []);
  const main = await renderNotificationsPage(e, ADMIN, {});
  assert.ok(main.includes('view=archive') && !main.includes('Gone Co'));
  const arch = await renderNotificationsPage(e, ADMIN, { view: 'archive' });
  assert.ok(arch.includes('Gone Co') && arch.includes('Back to current notifications'));
});

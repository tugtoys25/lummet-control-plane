// Deleted (closed) organizations go to an archive view instead of cluttering the main list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import * as staff from '../worker/staff-saas.js';
import { renderOrganizationsPage } from '../worker/views/pages/saas-admin.js';

async function env() {
  const db = createTestDb(); applyMigrations(db);
  await db.prepare(`INSERT INTO organizations (id,name,slug,status) VALUES ('o1','Acme Media','acme','active'),('o2','Beta Betting','beta','suspended'),('o3','Gone Co','gone','closed'),('o4','Old Gone Ltd','old-gone','closed')`).run();
  return { LUMMET_DB: db };
}
const names = (rows) => rows.map((r) => r.name).sort();

test('default list shows only current organizations', async () => {
  assert.deepEqual(names(await staff.listOrganizations(await env())), ['Acme Media', 'Beta Betting']);
});
test('archive view lists only closed ones, under both names', async () => {
  const e = await env();
  assert.deepEqual(names(await staff.listOrganizations(e, { status: 'archived' })), ['Gone Co', 'Old Gone Ltd']);
  assert.deepEqual(names(await staff.listOrganizations(e, { status: 'closed' })), ['Gone Co', 'Old Gone Ltd']);
});
test('searching still finds an archived organization; status filters still work', async () => {
  const e = await env();
  assert.deepEqual(names(await staff.listOrganizations(e, { q: 'gone' })), ['Gone Co', 'Old Gone Ltd']);
  assert.deepEqual(names(await staff.listOrganizations(e, { status: 'active' })), ['Acme Media']);
  assert.deepEqual(names(await staff.listOrganizations(e, { q: 'acme', status: 'archived' })), []);
});
test('page: main list links to the archive, archive view says so and links back', async () => {
  const e = await env(); const admin = { id: 1, email: 'a@b.c', role: 'super_admin' };
  const main = await renderOrganizationsPage(e, admin, {});
  assert.ok(main.includes('status=archived') && main.includes('Acme Media') && !main.includes('Gone Co'));
  const arch = await renderOrganizationsPage(e, admin, { status: 'archived' });
  assert.ok(arch.includes('Gone Co') && !arch.includes('Acme Media') && arch.includes('Back to current organizations'));
});

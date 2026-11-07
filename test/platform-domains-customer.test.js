// Customer side of Platform domains: options list, createSite validation, the omitted-value rule, default pinning, the picker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';
import * as pd from '../worker/platform-domains.js';
import * as repo from '../worker/repositories/platform-domains.js';
import { renderSitesPage } from '../worker/views/customer-pages/sites.js';

function makeEnv() {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, PLATFORM_DOMAIN_SUFFIX: 'lummet.app', CF_ZONE_ID: 'zone-default' };
}
let seq = 0;
async function newOrg(env) {
  seq += 1;
  const signup = await customerAuth.signUp({ async json() { return { email: `pd${seq}@example.com`, password: 'correct-horse-battery', organizationName: `Org${seq}` }; }, headers: { get: () => '203.0.113.30' } }, env);
  await plans.startTrialSubscription(env, signup.organizationId, 'plan_casino_news_starter');
  return { organizationId: signup.organizationId, userId: signup.userId };
}
const create = (env, org, extra = {}) => sites.createSite(env, { organizationId: org.organizationId, name: 'My Brand', productId: 'prod_casino_news', actorUserId: org.userId, ...extra });
async function addDomain(env, id, hostname, extra = {}) {
  await repo.insert(env, { id, hostname, label: hostname, cfZoneId: `zone-${id}`, status: 'active', ...extra });
}

test('one domain only: no picker data beyond the default, and a site is created on it', async () => {
  const env = makeEnv(); const org = await newOrg(env);
  const opts = await pd.customerDomainOptions(env, { organizationId: org.organizationId });
  assert.deepEqual(opts.map((o) => [o.hostname, o.isDefault]), [['lummet.app', true]]);
  const r = await create(env, org);
  assert.equal(r.ok, true);
  assert.equal(r.platformDomain.host, 'my-brand.lummet.app');
  const row = await env.LUMMET_DB.prepare(`SELECT platform_domain_id FROM sites WHERE id = ?`).bind(r.siteId).first();
  assert.equal(row.platform_domain_id, (await pd.getDefaultDomain(env)).id);
});

test('options only list active, customer-choosable, entitled domains; default is preselected', async () => {
  const env = makeEnv(); const org = await newOrg(env);
  await pd.getDefaultDomain(env);
  await addDomain(env, 'b', 'b.com', { sortOrder: 1 });
  await addDomain(env, 'off', 'off.com', { allowCustomerChoice: false });
  await addDomain(env, 'dis', 'dis.com', { status: 'disabled' });
  await addDomain(env, 'pend', 'pend.com', { status: 'pending' });
  await addDomain(env, 'ent', 'ent.com', { entitlementKey: 'sites.premium_domain_nope' });
  const opts = await pd.customerDomainOptions(env, { organizationId: org.organizationId });
  assert.deepEqual(opts.map((o) => o.hostname).sort(), ['b.com', 'lummet.app']);
  assert.deepEqual(opts.filter((o) => o.isDefault).map((o) => o.hostname), ['lummet.app']);
});

test('createSite: a chosen domain is used; invalid, disabled, pending, non-choosable and unknown ids are rejected before anything is written', async () => {
  const env = makeEnv(); const org = await newOrg(env);
  await pd.getDefaultDomain(env);
  await addDomain(env, 'b', 'b.com');
  await addDomain(env, 'off', 'off.com', { allowCustomerChoice: false });
  await addDomain(env, 'dis', 'dis.com', { status: 'disabled' });
  await addDomain(env, 'pend', 'pend.com', { status: 'pending' });
  const ok = await create(env, org, { platformDomainId: 'b' });
  assert.equal(ok.platformDomain.host, 'my-brand.b.com');
  const before = (await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM sites`).first()).n;
  for (const bad of ['off', 'dis', 'pend', 'nope', '../x']) {
    const r = await create(env, org, { platformDomainId: bad });
    assert.deepEqual([r.ok, r.status, r.error], [false, 422, 'invalid_platform_domain'], bad);
  }
  assert.equal((await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM sites`).first()).n, before, 'nothing written for a rejected domain');
});

test('omitted domain = the default; if the default is not customer-choosable, the first choosable one (matching what the screen shows)', async () => {
  const env = makeEnv(); const org = await newOrg(env);
  const def = await pd.getDefaultDomain(env);
  assert.equal((await create(env, org)).platformDomain.hostname, 'lummet.app');
  await addDomain(env, 'b', 'b.com', { sortOrder: 1 });
  await repo.update(env, def.id, { allowCustomerChoice: false });
  const opts = await pd.customerDomainOptions(env, { organizationId: org.organizationId });
  assert.deepEqual(opts.map((o) => [o.hostname, o.isDefault]), [['b.com', true]]);
  assert.equal((await create(env, org)).platformDomain.hostname, 'b.com');
});

test('the slug stays globally unique across domains: the same name on two domains gets a numbered slug', async () => {
  const env = makeEnv(); const org = await newOrg(env);
  await pd.getDefaultDomain(env);
  await addDomain(env, 'b', 'b.com');
  const one = await create(env, org);
  const two = await create(env, org, { platformDomainId: 'b' });
  assert.deepEqual([one.slug, two.slug], ['my-brand', 'my-brand-2']);
  assert.equal(two.platformDomain.host, 'my-brand-2.b.com');
});

test('changing the default pins sites with no stored domain to the old default, so their host does not move', async () => {
  const env = makeEnv(); const org = await newOrg(env);
  const oldDef = await pd.getDefaultDomain(env);
  const prod = await env.LUMMET_DB.prepare(`SELECT id FROM products LIMIT 1`).first();
  await env.LUMMET_DB.prepare(`INSERT INTO sites (id, organization_id, product_id, name, slug, status) VALUES ('legacy', ?, ?, 'Legacy', 'legacy', 'active')`).bind(org.organizationId, prod.id).run();
  await addDomain(env, 'b', 'b.com');
  const site = () => env.LUMMET_DB.prepare(`SELECT * FROM sites WHERE id = 'legacy'`).first();
  assert.equal(pd.hostFor(await site(), await pd.getDomainForSite(env, await site())), 'legacy.lummet.app');
  await repo.setDefault(env, 'b');
  assert.equal((await site()).platform_domain_id, oldDef.id);
  assert.equal(pd.hostFor(await site(), await pd.getDomainForSite(env, await site())), 'legacy.lummet.app', 'host unchanged after the default moved');
  assert.equal((await pd.getDefaultDomain(env)).hostname, 'b.com');
  assert.deepEqual(await repo.siteCountsByStatus(env, oldDef.id, { isDefault: false }), { active: 1 });
});

test('page: picker only with a real choice, hidden input with one, live preview text, site address shown, escaping', async () => {
  const products = [{ id: 'prod_casino_news', name: 'Casino news' }];
  const base = { sites: [{ id: 's1', name: 'S', product_name: 'P', status: 'pending', primary_domain: null, app_version: null }], products, canManage: true, siteHosts: { s1: 's.lummet.app' } };
  const one = renderSitesPage({ ...base, platformDomains: [{ id: 'd1', label: 'Lummet', hostname: 'lummet.app', isDefault: true }] });
  assert.ok(!one.includes('id="site-domain">') && one.includes('type="hidden" id="site-domain"') && one.includes('s.lummet.app'));
  const two = renderSitesPage({ ...base, platformDomains: [{ id: 'd1', label: 'Lummet', hostname: 'lummet.app', isDefault: true }, { id: 'd2', label: '<b>X</b>', hostname: 'x.com', isDefault: false }] });
  assert.ok(two.includes('<select id="site-domain">') && two.includes('value="d1" data-host="lummet.app" selected'));
  assert.ok(two.includes('lummetHostPreview') && two.includes('platformDomainId = dom.value'));
  assert.ok(!two.includes('<b>X</b>') && two.includes('&lt;b&gt;X&lt;/b&gt;'));
  const none = renderSitesPage({ ...base, platformDomains: [] });
  assert.ok(!none.includes('site-domain"'));
});

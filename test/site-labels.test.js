// Site address reservation: a label belongs to one non-deleted site per platform domain; a taken label is refused (never
// renamed) with suggestions; the same label stays free on another domain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';
import * as pd from '../worker/platform-domains.js';
import * as repo from '../worker/repositories/platform-domains.js';
import * as labels from '../worker/site-labels.js';

function makeEnv() {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, PLATFORM_DOMAIN_SUFFIX: 'lummet.app', CF_ZONE_ID: 'zone-default' };
}
let seq = 0;
async function newOrg(env) {
  seq += 1;
  const s = await customerAuth.signUp({ async json() { return { email: `lbl${seq}@example.com`, password: 'correct-horse-battery', organizationName: `Org${seq}` }; }, headers: { get: () => '203.0.113.40' } }, env);
  await plans.startTrialSubscription(env, s.organizationId, 'plan_casino_news_starter').catch(() => plans.startTrialSubscription(env, s.organizationId, 'plan_casino_news_starter'));
  return { organizationId: s.organizationId, userId: s.userId };
}
const create = (env, org, name, extra = {}) => sites.createSite(env, { organizationId: org.organizationId, name, productId: 'prod_casino_news', actorUserId: org.userId, ...extra });
const addDomain = (env, id, hostname) => repo.insert(env, { id, hostname, label: hostname, cfZoneId: `zone-${id}`, status: 'active' });

test('validateLabel: length, characters, hyphens and reserved names', () => {
  assert.equal(labels.validateLabel('reviews').ok, true);
  assert.equal(labels.validateLabel('ab').reason, 'too_short');
  assert.equal(labels.validateLabel('a'.repeat(41)).reason, 'too_long');
  assert.equal(labels.validateLabel('-reviews').reason, 'invalid');
  assert.equal(labels.validateLabel('re_views').reason, 'invalid');
  assert.equal(labels.validateLabel('xn--abc').reason, 'invalid');
  assert.equal(labels.validateLabel('www').reason, 'reserved');
  assert.equal(labels.validateLabel('admin').reason, 'reserved');
});

test('a taken label is refused with suggestions and is NEVER renamed to review-2', async () => {
  const env = makeEnv(); const a = await newOrg(env); const b = await newOrg(env);
  const first = await create(env, a, 'Reviews');
  assert.equal(first.ok, true);
  assert.equal(first.platformDomain.host, 'reviews.lummet.app');

  const second = await create(env, b, 'Reviews');
  assert.equal(second.ok, false);
  assert.equal(second.status, 409);
  assert.equal(second.error, 'subdomain_taken');
  assert.equal(second.host, 'reviews.lummet.app');
  assert.ok(second.suggestions.length >= 3, 'offers other words');
  assert.ok(second.suggestions.every((s) => s.label !== 'reviews'), 'never offers the taken label itself');
  assert.ok(second.suggestions.some((s) => s.label === 'reviews-hub'));
  const count = await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM sites WHERE organization_id = ?`).bind(b.organizationId).first();
  assert.equal(count.n, 0, 'nothing was created for the refused request');

  // The customer picks one of the suggestions and gets exactly that.
  const picked = await create(env, b, 'Reviews', { subdomain: second.suggestions[0].label });
  assert.equal(picked.ok, true);
  assert.equal(picked.platformDomain.host, `${second.suggestions[0].label}.lummet.app`);
});

test('the same label on another domain is free, and the refusal points to it', async () => {
  const env = makeEnv(); const a = await newOrg(env); const b = await newOrg(env);
  await pd.getDefaultDomain(env);
  await addDomain(env, 'sze', 'sze.app');
  assert.equal((await create(env, a, 'Reviews')).ok, true);
  const refused = await create(env, b, 'Reviews');
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.otherDomains.map((d) => d.host), ['reviews.sze.app']);

  const onOther = await create(env, b, 'Reviews', { platformDomainId: 'sze' });
  assert.equal(onOther.ok, true);
  assert.equal(onOther.platformDomain.host, 'reviews.sze.app');
  // ...and now it is taken there too, for a third customer.
  const c = await newOrg(env);
  const third = await create(env, c, 'Reviews', { platformDomainId: 'sze' });
  assert.equal(third.error, 'subdomain_taken');
  assert.equal(third.host, 'reviews.sze.app');
});

test('a typed address wins over the site name; invalid and reserved addresses are refused with a reason', async () => {
  const env = makeEnv(); const a = await newOrg(env);
  const ok = await create(env, a, 'My Casino Reviews', { subdomain: 'Best Slots' });
  assert.equal(ok.platformDomain.host, 'best-slots.lummet.app');
  assert.equal((await create(env, a, 'X', { subdomain: 'www' })).error, 'subdomain_reserved');
  const bad = await create(env, a, 'X', { subdomain: 'no_good!' });
  assert.equal(bad.error, 'invalid_subdomain');
  assert.equal(bad.status, 422);
  assert.equal((await create(env, a, 'X', { subdomain: 'ab' })).reason, 'too_short');
});

test('a site that is deleting still holds its address; once deleted it is free again', async () => {
  const env = makeEnv(); const a = await newOrg(env); const b = await newOrg(env);
  const s = await create(env, a, 'Reviews');
  await sites.transitionSiteStatus(env, s.siteId, 'deleting', { actorType: 'system' });
  assert.equal((await labels.checkLabel(env, { label: 'reviews', domain: await pd.getDefaultDomain(env) })).available, false);
  assert.equal((await create(env, b, 'Reviews')).error, 'subdomain_taken');
  await sites.transitionSiteStatus(env, s.siteId, 'deleted', { actorType: 'system' });
  const again = await create(env, b, 'Reviews');
  assert.equal(again.ok, true);
  assert.equal(again.platformDomain.host, 'reviews.lummet.app');
  assert.notEqual(again.slug, 'reviews', 'only the internal slug differs, because the old one is still on record');
});

test('the old address of a moved site is held while its redirect lives, and freed when it expires', async () => {
  const env = makeEnv(); const a = await newOrg(env); const b = await newOrg(env);
  const s = await create(env, a, 'Reviews');
  await sites.transitionSiteStatus(env, s.siteId, 'deleting', { actorType: 'system' });
  await sites.transitionSiteStatus(env, s.siteId, 'deleted', { actorType: 'system' });
  const future = new Date(Date.now() + 86400000).toISOString();
  await env.LUMMET_DB.prepare(`INSERT INTO site_host_redirects (old_host, new_host, site_id, move_id, expires_at) VALUES ('reviews.lummet.app', 'reviews.sze.app', 'other-site', 'm1', ?)`).bind(future).run();
  assert.equal((await create(env, b, 'Reviews')).error, 'subdomain_taken');
  await env.LUMMET_DB.prepare(`UPDATE site_host_redirects SET expires_at = ?`).bind(new Date(Date.now() - 1000).toISOString()).run();
  assert.equal((await create(env, b, 'Reviews')).ok, true);
});

test('the unique index refuses a duplicate even if the check is bypassed (race)', async () => {
  const env = makeEnv(); const a = await newOrg(env);
  const s = await create(env, a, 'Reviews');
  const row = await env.LUMMET_DB.prepare(`SELECT platform_domain_id FROM sites WHERE id = ?`).bind(s.siteId).first();
  await assert.rejects(env.LUMMET_DB.prepare(`INSERT INTO sites (id, organization_id, name, slug, host_label, product_id, status, platform_domain_id) VALUES ('dup', ?, 'Dup', 'dup-slug', 'reviews', 'prod_casino_news', 'pending', ?)`).bind(a.organizationId, row.platform_domain_id).run(), /UNIQUE|constraint/i);
});

test('legacy sites (no host_label) keep their slug as their address and still block it', async () => {
  const env = makeEnv(); const a = await newOrg(env);
  const dom = await pd.getDefaultDomain(env);
  await env.LUMMET_DB.prepare(`INSERT INTO sites (id, organization_id, name, slug, product_id, status) VALUES ('legacy', ?, 'Legacy', 'legacy-site', 'prod_casino_news', 'active')`).bind(a.organizationId).run();
  assert.equal(pd.hostFor({ slug: 'legacy-site' }, dom), 'legacy-site.lummet.app');
  assert.equal((await labels.checkLabel(env, { label: 'legacy-site', domain: dom })).available, false);
});

// ---- through worker.fetch: the live check the create-site form calls, and the create route ----
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
let ipn = 30;
async function call(env, method, path, { body, cookie } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': `198.51.100.${(ipn++ % 240) + 1}` });
  if (cookie) h.set('Cookie', cookie);
  let payload; if (body !== undefined) { h.set('Content-Type', 'application/json'); payload = JSON.stringify(body); }
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: payload, redirect: 'manual' }), env, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function signup(env, email) {
  const r = await call(env, 'POST', '/api/customer/signup', { body: { email, password: 'Correct-Horse-Battery-9', organizationName: 'Org ' + email, displayName: 'T' } });
  assert.equal(r.status, 200, r.text);
  await plans.startTrialSubscription(env, r.json.organizationId, 'plan_casino_news_starter').catch(() => {});
  return { cookie: r.cookie, orgId: r.json.organizationId };
}
function routeEnv() { const e = makeEnv(); return { ...e, ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)) }; }

test('route: name-check says available, then taken with suggestions and other domains; create refuses with the same advice', async () => {
  const env = routeEnv();
  await pd.getDefaultDomain(env); await addDomain(env, 'sze', 'sze.app');
  const a = await signup(env, 'a-lbl@example.com'); const b = await signup(env, 'b-lbl@example.com');
  const base = (o) => `/api/organizations/${o.orgId}`;

  const free = await call(env, 'GET', `${base(a)}/sites/name-check?label=reviews`, { cookie: a.cookie });
  assert.equal(free.status, 200, free.text);
  assert.equal(free.json.data.available, true);
  assert.equal(free.json.data.host, 'reviews.lummet.app');

  const made = await call(env, 'POST', `${base(a)}/sites`, { cookie: a.cookie, body: { name: 'Reviews', productId: 'prod_casino_news' } });
  assert.equal(made.status, 200, made.text);
  assert.equal(made.json.host, 'reviews.lummet.app');

  const taken = await call(env, 'GET', `${base(b)}/sites/name-check?label=reviews`, { cookie: b.cookie });
  assert.equal(taken.json.data.available, false);
  assert.equal(taken.json.data.reason, 'taken');
  assert.ok(taken.json.data.suggestions.length >= 3);
  assert.deepEqual(taken.json.data.otherDomains.map((d) => d.host), ['reviews.sze.app']);
  assert.ok(!JSON.stringify(taken.json).includes(a.orgId), 'never says who holds it');

  const refused = await call(env, 'POST', `${base(b)}/sites`, { cookie: b.cookie, body: { name: 'Reviews', productId: 'prod_casino_news' } });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, 'subdomain_taken');
  assert.ok(refused.json.suggestions.length >= 3);

  const bad = await call(env, 'GET', `${base(b)}/sites/name-check?label=www`, { cookie: b.cookie });
  assert.equal(bad.json.data.reason, 'reserved');
  const short = await call(env, 'GET', `${base(b)}/sites/name-check?label=ab`, { cookie: b.cookie });
  assert.equal(short.json.data.reason, 'too_short');
});

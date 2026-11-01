// Round R.5: entitlement matrix (blueprint I-27). Tests only; no product code changes.
//
// Every subscription state against what a customer can actually do through the real Worker and real database, with
// BILLING_ENFORCE=enforce: read vs write, the entitlement values the API reports, a real site create and API-key create,
// the serve gate, then plan limits (sites, seats), downgrade, add-ons, and every code path that adds a member.
// The expected values below are written out by hand from the billing rules (14 grace days, 7 restricted days, 30 suspended days);
// they are not computed by the code under test.
//
// Three gaps this matrix first found are fixed in release 2.6.1.6 and tested at the end of this file:
//   G1  api.enabled was displayed but never enforced (now API_ENTITLEMENT=off|shadow|enforce, default off)
//   G2  a provider trial past its end date kept write access but lost every entitlement until the webhook arrived (fixed)
//   G3  SSO just-in-time sign-in added members without the seat check (fixed; behaviour tests in test/sso-seat-limit.test.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../worker/index.js';
import * as customerAuth from '../worker/customer-auth.js';
import { resolveAccess, evaluateServeGate, evaluateWriteGate, isWriteGateExempt } from '../worker/access.js';
import { createTestDb, applyMigrations } from './support/d1-shim.js';

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
const PW = 'Correct-Horse-Battery-9';
const DAY = 86400000;
const iso = (offset) => new Date(Date.now() + offset).toISOString();
let n = 0;
const nextIp = () => { n += 1; return `10.1.${(n >> 8) & 255}.${n & 255}`; };

async function call(e, method, path, body, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': nextIp() });
  if (cookie) h.set('Cookie', cookie);
  const hasBody = method !== 'GET' && method !== 'DELETE';
  if (hasBody) h.set('Content-Type', 'application/json');
  const response = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: hasBody ? JSON.stringify(body ?? {}) : undefined, redirect: 'manual' }), e, ctx);
  const text = await response.text(); let json = null; try { json = JSON.parse(text); } catch (_) { json = null; }
  return { status: response.status, text, json };
}
function newEnv(mode = 'enforce') {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, BILLING_ENFORCE: mode, CREDENTIAL_KEK: btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 37 + 11 + (i * i) % 251) % 256))),
    PORTAL_BASE_URL: 'https://app.example.test', EMAIL_FETCH: async () => new Response(JSON.stringify({ id: 'fake-email' }), { status: 200 }) };
}
let seq = 0;
async function org(e, plan = 'plan_casino_news_pro') {
  seq += 1;
  const email = `owner${seq}@example.test`;
  const r = await call(e, 'POST', '/api/customer/signup', { email, password: PW, organizationName: `Org ${seq}` });
  assert.equal(r.status, 200, r.text);
  const userId = (await e.LUMMET_DB.prepare('SELECT id FROM customer_users WHERE email = ?').bind(email).first()).id;
  const organizationId = r.json.organizationId;
  const s = await customerAuth.createSession(e, userId, organizationId);
  // Sign-up creates the organization with no subscription (a trial is started explicitly), so the matrix inserts the one each scenario describes.
  await e.LUMMET_DB.prepare(`INSERT INTO subscriptions (id, organization_id, plan_id, status) VALUES (?, ?, ?, 'active')`).bind(`sub-${organizationId}`, organizationId, plan).run();
  return { userId, organizationId, cookie: s.cookie.split(';')[0], base: `/api/organizations/${organizationId}` };
}
async function setSub(e, o, fields) {
  const cols = { status: 'active', trial_ends_at: null, provider_subscription_id: null, canceled_at: null, grace_ends_at: null, restricted_at: null, suspended_at: null, stripe_status: null, cancel_at_period_end: 0, ...fields };
  const keys = Object.keys(cols);
  await e.LUMMET_DB.prepare(`UPDATE subscriptions SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE organization_id = ?`).bind(...keys.map((k) => cols[k]), iso(-3600000), o.organizationId).run();
}

// name -> [subscription fields, org status, expected access state, canMutate, canServe]
const STATES = {
  trialing_local:               [{ status: 'trialing', trial_ends_at: iso(3 * DAY) }, 'active', 'trialing', true, true],
  active:                       [{ status: 'active' }, 'active', 'active', true, true],
  active_cancel_at_period_end:  [{ status: 'active', cancel_at_period_end: 1, current_period_end: iso(10 * DAY) }, 'active', 'active', true, true],
  past_due_in_grace:            [{ status: 'past_due', grace_ends_at: iso(5 * DAY) }, 'active', 'past_due', true, true],
  past_due_after_grace:         [{ status: 'past_due', grace_ends_at: iso(-3600000) }, 'active', 'restricted', false, true],
  past_due_after_restricted:    [{ status: 'past_due', grace_ends_at: iso(-8 * DAY) }, 'active', 'suspended', false, false],
  restricted:                   [{ status: 'restricted', restricted_at: iso(-3600000) }, 'active', 'restricted', false, true],
  restricted_runs_into_suspend: [{ status: 'restricted', restricted_at: iso(-8 * DAY) }, 'active', 'suspended', false, false],
  unpaid:                       [{ status: 'unpaid', stripe_status: 'unpaid', restricted_at: iso(-3600000) }, 'active', 'restricted', false, true],
  suspended:                    [{ status: 'suspended', suspended_at: iso(-3600000) }, 'active', 'suspended', false, false],
  suspended_period_elapsed:     [{ status: 'suspended', suspended_at: iso(-31 * DAY) }, 'active', 'closed', false, false],
  canceled_yesterday:           [{ status: 'canceled', canceled_at: iso(-1 * DAY) }, 'active', 'trial_expired', false, true],
  canceled_8_days_ago:          [{ status: 'canceled', canceled_at: iso(-8 * DAY) }, 'active', 'restricted', false, true],
  canceled_40_days_ago:         [{ status: 'canceled', canceled_at: iso(-40 * DAY) }, 'active', 'suspended', false, false],
  canceled_80_days_ago:         [{ status: 'canceled', canceled_at: iso(-80 * DAY) }, 'active', 'closed', false, false],
  trial_expired_yesterday:      [{ status: 'expired', trial_ends_at: iso(-1 * DAY) }, 'active', 'trial_expired', false, true],
  paused_or_unknown_status:     [{ status: 'paused' }, 'active', 'restricted', false, true],
  organization_closed:          [{ status: 'active' }, 'closed', 'closed', false, false]
};
const MUTATING_REFUSALS = [402, 403];

async function arrange(e, name, plan) {
  const [fields, orgStatus] = STATES[name];
  const o = await org(e, plan);
  await setSub(e, o, fields);
  await e.LUMMET_DB.prepare('UPDATE organizations SET status = ? WHERE id = ?').bind(orgStatus, o.organizationId).run();
  return o;
}
const countRows = async (e, table, o) => (await e.LUMMET_DB.prepare(`SELECT COUNT(*) c FROM ${table} WHERE organization_id = ?`).bind(o.organizationId).first()).c;

// ---------------------------------------------------------------- the state table itself

test('R.5 access state: every subscription state resolves to the hand-written state, canMutate and canServe', async () => {
  const e = newEnv(); const failures = [];
  for (const [name, [, , state, mutate, serve]] of Object.entries(STATES)) {
    const o = await arrange(e, name);
    const a = await resolveAccess(e, o.organizationId);
    if (a.state !== state || a.canMutate !== mutate || a.canServe !== serve) failures.push(`${name}: got ${a.state}/${a.canMutate}/${a.canServe}, expected ${state}/${mutate}/${serve}`);
  }
  assert.deepEqual(failures, []);
});

// ---------------------------------------------------------------- what a customer can do, per state, in enforce mode

test('R.5 enforce: reads always work; a site and an API key can be created only where the state may mutate; nothing is created when refused', async () => {
  const e = newEnv('enforce'); const failures = [];
  for (const [name, [, , , mutate]] of Object.entries(STATES)) {
    const o = await arrange(e, name);
    for (const path of ['/sites', '/usage', '/entitlements', '/members', '/audit-log']) {
      const r = await call(e, 'GET', `${o.base}${path}`, null, o.cookie);
      if (r.status !== 200) failures.push(`${name}: GET ${path} -> ${r.status}`);
    }
    const sitesBefore = await countRows(e, 'sites', o), keysBefore = await countRows(e, 'customer_api_keys', o);
    const site = await call(e, 'POST', `${o.base}/sites`, { name: `Site ${name}`, productId: 'prod_casino_news' }, o.cookie);
    const key = await call(e, 'POST', `${o.base}/api-keys`, { name: `key ${name}`, scopes: ['sites:read'] }, o.cookie);
    for (const [what, r, table, before] of [['site', site, 'sites', sitesBefore], ['api key', key, 'customer_api_keys', keysBefore]]) {
      const created = (await countRows(e, table, o)) - before;
      if (mutate) { if (r.status !== 200 || created !== 1) failures.push(`${name}: ${what} create -> ${r.status}, created ${created} (should work)`); }
      else {
        if (!MUTATING_REFUSALS.includes(r.status)) failures.push(`${name}: ${what} create -> ${r.status} (should be refused 402/403)`);
        if (created !== 0) failures.push(`${name}: ${what} row was created despite refusal`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('R.5 enforce: the entitlements the API reports match the state (plan values where it may mutate, the zero floor where it may not)', async () => {
  const e = newEnv('enforce'); const failures = [];
  for (const [name, [, , , mutate]] of Object.entries(STATES)) {
    const o = await arrange(e, name);
    const r = await call(e, 'GET', `${o.base}/entitlements`, null, o.cookie);
    const ent = r.json?.data || r.json?.entitlements || {};
    const val = (k) => (ent[k] && typeof ent[k] === 'object' ? ent[k].value : ent[k]);
    const want = mutate ? { sites: 3, users: 10, api: true } : { sites: 0, users: 1, api: false };
    const got = { sites: val('sites.max'), users: val('users.max'), api: val('api.enabled') };
    if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${name}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
  }
  assert.deepEqual(failures, []);
});

test('R.5 serve gate (public sites, API-key reads): blocked exactly where the state may not serve', async () => {
  const e = newEnv('enforce'); const failures = [];
  for (const [name, [, , , , serve]] of Object.entries(STATES)) {
    const o = await arrange(e, name);
    const g = await evaluateServeGate(e, { organizationId: o.organizationId, entryPoint: 'matrix' });
    if (g.blocked === serve) failures.push(`${name}: blocked=${g.blocked} but canServe should be ${serve}`);
  }
  assert.deepEqual(failures, []);
});

test('R.5 the way out of a restricted state is never blocked: billing, backups, trial and account-deletion routes are exempt', () => {
  for (const p of ['/billing/checkout', '/billing/portal', '/billing/pay', '/backups', '/backups/abc/download', '/trial', '/switch', '/reactivate', '/request-deletion', '/cancel-deletion']) {
    assert.equal(isWriteGateExempt(p), true, p);
  }
  for (const p of ['/sites', '/api-keys', '/webhooks', '/invitations', '/members/x', '/automations', '/sites/x/provision']) assert.equal(isWriteGateExempt(p), false, p);
});

test('R.5 rollout modes: off never blocks, shadow never blocks but records one finding per entry point, enforce blocks', async () => {
  for (const mode of ['off', 'shadow', 'enforce']) {
    const e = newEnv(mode);
    const o = await arrange(e, 'restricted');
    const r = await call(e, 'POST', `${o.base}/webhooks`, { url: 'https://hooks.example.test/x', eventTypes: ['site.created'] }, o.cookie);
    const refused = MUTATING_REFUSALS.includes(r.status) && /billing_access_restricted|restricted/.test(r.text);
    assert.equal(refused, mode === 'enforce', `${mode}: ${r.status} ${r.text.slice(0, 120)}`);
    const shadows = (await e.LUMMET_DB.prepare('SELECT COUNT(*) c FROM subscription_access_shadow WHERE organization_id = ?').bind(o.organizationId).first()).c;
    assert.equal(shadows, mode === 'shadow' ? 1 : 0, `${mode}: shadow rows`);
    const again = await evaluateWriteGate(e, { organizationId: o.organizationId, method: 'POST', subPath: '/webhooks' });
    if (mode === 'shadow') assert.equal((await e.LUMMET_DB.prepare('SELECT COUNT(*) c FROM subscription_access_shadow WHERE organization_id = ?').bind(o.organizationId).first()).c, 1, 'repeat is deduplicated');
    assert.equal(again.blocked, mode === 'enforce');
  }
});

// ---------------------------------------------------------------- limits, downgrade, add-ons

test('R.5 site limit is enforced in the API, not only the UI: the plan allows exactly sites.max, the next create is refused and nothing is created', async () => {
  const e = newEnv('enforce'); const o = await org(e, 'plan_casino_news_pro');         // sites.max = 3
  await setSub(e, o, { status: 'active' });
  for (let i = 1; i <= 3; i += 1) assert.equal((await call(e, 'POST', `${o.base}/sites`, { name: `S${i}`, productId: 'prod_casino_news' }, o.cookie)).status, 200, `site ${i}`);
  const over = await call(e, 'POST', `${o.base}/sites`, { name: 'S4', productId: 'prod_casino_news' }, o.cookie);
  assert.equal(over.status, 403); assert.equal(over.json.error, 'site_limit_reached'); assert.equal(over.json.limit, 3);
  assert.equal(await countRows(e, 'sites', o), 3);
});

test('R.5 seat limit (members plus pending invitations): enforced in enforce mode, never in off mode', async () => {
  for (const [mode, blocked] of [['enforce', true], ['off', false]]) {
    const e = newEnv(mode); const o = await org(e, 'plan_casino_news_starter');          // users.max = 2, the owner is seat 1
    await setSub(e, o, { status: 'active' });
    const first = await call(e, 'POST', `${o.base}/invitations`, { email: `a-${mode}@example.test`, role: 'editor' }, o.cookie);
    assert.equal(first.status, 200, first.text);
    const second = await call(e, 'POST', `${o.base}/invitations`, { email: `b-${mode}@example.test`, role: 'editor' }, o.cookie);
    assert.equal(second.status === 402 && second.json.error === 'seat_limit_reached', blocked, `${mode}: ${second.status} ${second.text.slice(0, 100)}`);
  }
});

test('R.5 downgrade over the new limit: existing sites stay readable and are never deleted; only new creation is refused', async () => {
  const e = newEnv('enforce'); const o = await org(e, 'plan_casino_news_pro');
  await setSub(e, o, { status: 'active' });
  for (let i = 1; i <= 3; i += 1) assert.equal((await call(e, 'POST', `${o.base}/sites`, { name: `S${i}`, productId: 'prod_casino_news' }, o.cookie)).status, 200);
  await e.LUMMET_DB.prepare('UPDATE subscriptions SET plan_id = ? WHERE organization_id = ?').bind('plan_casino_news_starter', o.organizationId).run();   // sites.max = 1
  const list = await call(e, 'GET', `${o.base}/sites`, null, o.cookie);
  assert.equal(list.status, 200); assert.equal(list.json.data.length, 3, 'all three still listed');
  const more = await call(e, 'POST', `${o.base}/sites`, { name: 'S4', productId: 'prod_casino_news' }, o.cookie);
  assert.equal(more.status, 403); assert.equal(more.json.error, 'site_limit_reached');
  assert.equal(await countRows(e, 'sites', o), 3, 'nothing deleted');
});

test('R.5 add-ons: a numeric add-on raises the limit by delta x quantity; an add-on can never switch on a feature the plan lacks or lower a limit', async () => {
  const e = newEnv('enforce'); const o = await org(e, 'plan_casino_news_starter');       // sites.max 1, api.enabled false
  await setSub(e, o, { status: 'active' });
  const sub = (await e.LUMMET_DB.prepare('SELECT id FROM subscriptions WHERE organization_id = ?').bind(o.organizationId).first()).id;
  const addon = (id, key, delta) => e.LUMMET_DB.prepare(`INSERT INTO addons (id, key, name, entitlement_key, delta_per_unit, stripe_price_id, active) VALUES (?, ?, ?, ?, ?, ?, 1)`).bind(id, id, id, key, delta, `price_${id}`).run();
  await addon('ad_sites', 'sites.max', 2); await addon('ad_api', 'api.enabled', 1);
  await assert.rejects(async () => addon('ad_neg', 'users.max', -1), /delta_per_unit/, 'the schema refuses a negative delta, so an add-on can never lower a limit');
  const attach = (id, q) => e.LUMMET_DB.prepare('INSERT INTO subscription_addons (subscription_id, addon_id, quantity) VALUES (?, ?, ?)').bind(sub, id, q).run();
  await attach('ad_sites', 2); await attach('ad_api', 5);
  const r = await call(e, 'GET', `${o.base}/entitlements`, null, o.cookie);
  const ent = r.json.data || r.json.entitlements; const val = (k) => (ent[k] && typeof ent[k] === 'object' ? ent[k].value : ent[k]);
  assert.equal(val('sites.max'), 5, '1 + 2 x 2');
  assert.equal(val('api.enabled'), false, 'a numeric delta cannot enable a boolean');
  assert.equal(val('users.max'), 2, 'unrelated limits are untouched');
  for (let i = 1; i <= 5; i += 1) assert.equal((await call(e, 'POST', `${o.base}/sites`, { name: `S${i}`, productId: 'prod_casino_news' }, o.cookie)).status, 200, `site ${i}`);
  assert.equal((await call(e, 'POST', `${o.base}/sites`, { name: 'S6', productId: 'prod_casino_news' }, o.cookie)).status, 403);
});

test('R.5 a restricted organization loses its add-on capacity along with its plan (the floor wins), and gets it back when it pays', async () => {
  const e = newEnv('enforce'); const o = await org(e, 'plan_casino_news_pro');
  await setSub(e, o, { status: 'active' });
  const sub = (await e.LUMMET_DB.prepare('SELECT id FROM subscriptions WHERE organization_id = ?').bind(o.organizationId).first()).id;
  await e.LUMMET_DB.prepare(`INSERT INTO addons (id, key, name, entitlement_key, delta_per_unit, stripe_price_id, active) VALUES ('ad_s', 'ad_s', 'x', 'sites.max', 10, 'price_s', 1)`).run();
  await e.LUMMET_DB.prepare('INSERT INTO subscription_addons (subscription_id, addon_id, quantity) VALUES (?, ?, 1)').bind(sub, 'ad_s').run();
  const sites = async () => { const r = await call(e, 'GET', `${o.base}/entitlements`, null, o.cookie); const ent = r.json.data || r.json.entitlements; return ent['sites.max'].value ?? ent['sites.max']; };
  assert.equal(await sites(), 13);
  await setSub(e, o, { status: 'restricted', restricted_at: iso(-3600000) });
  assert.equal(await sites(), 0);
  await setSub(e, o, { status: 'active' });
  assert.equal(await sites(), 13);
});

// ---------------------------------------------------------------- delayed and duplicate provider events (state changes only through one path)

test('R.5 repeating the same state write is idempotent: resolving access twice, or after a duplicate delivery, gives the same answer', async () => {
  const e = newEnv('enforce'); const o = await org(e);
  await setSub(e, o, { status: 'past_due', grace_ends_at: iso(5 * DAY) });
  const a = await resolveAccess(e, o.organizationId); const b = await resolveAccess(e, o.organizationId);
  assert.deepEqual({ ...a, endsAt: null }, { ...b, endsAt: null });
  await setSub(e, o, { status: 'past_due', grace_ends_at: iso(5 * DAY) });                 // the same event applied again
  assert.equal((await resolveAccess(e, o.organizationId)).state, 'past_due');
});

// ---------------------------------------------------------------- every path that adds a member

test('R.5 gate: every code path that adds an organization member is seat-checked', () => {
  const root = new URL('../worker/', import.meta.url);
  const offenders = [];
  const walk = (dir) => {
    for (const ent of readdirSync(new URL(dir, root), { withFileTypes: true })) {
      if (ent.isDirectory()) { if (ent.name !== 'views') walk(`${dir}${ent.name}/`); continue; }
      if (!/\.js$/.test(ent.name)) continue;
      const src = readFileSync(new URL(`${dir}${ent.name}`, root), 'utf8');
      const inserts = src.match(/INSERT INTO organization_users/g) || [];
      // The first owner of a new organization is not a seat decision. Everything else must call seatCheck in the same file.
      const ownerInserts = (src.match(/INSERT INTO organization_users[^`]*'owner'/g) || []).length;
      if (inserts.length - ownerInserts > 0 && !/seatCheck\(/.test(src) && !/repositories\//.test(`${dir}${ent.name}`)) offenders.push(`${dir}${ent.name}`);
    }
  };
  walk('');
  assert.deepEqual(offenders.sort(), [], 'every file that adds a member must call seatCheck; a file listed here is a new unchecked way to add one');
});

// ---------------------------------------------------------------- the three gaps, fixed in 2.6.1.6

const keyBody = { name: 'k', scopes: ['sites:read'] };
async function createKey(e, o) { return call(e, 'POST', `${o.base}/api-keys`, keyBody, o.cookie); }

test('G1 api.enabled: off (default) changes nothing, shadow only logs, enforce refuses a plan without API access and still serves one with it', async () => {
  const logged = []; const orig = console.log; console.log = (...a) => logged.push(a.join(' '));
  try {
    for (const [mode, starterAllowed] of [[undefined, true], ['off', true], ['shadow', true], ['enforce', false]]) {
      const e = { ...newEnv('enforce'), API_ENTITLEMENT: mode };
      const starter = await org(e, 'plan_casino_news_starter'); await setSub(e, starter, { status: 'active' });     // api.enabled = false
      const pro = await org(e, 'plan_casino_news_pro'); await setSub(e, pro, { status: 'active' });                  // api.enabled = true
      const a = await createKey(e, starter);
      assert.equal(a.status === 200, starterAllowed, `${mode}: starter ${a.status} ${a.text.slice(0, 80)}`);
      if (!starterAllowed) { assert.equal(a.status, 403); assert.equal(a.json.error, 'api_not_enabled'); assert.equal(await countRows(e, 'customer_api_keys', starter), 0); }
      assert.equal((await createKey(e, pro)).status, 200, `${mode}: pro`);
    }
  } finally { console.log = orig; }
  assert.ok(logged.some((l) => l.includes('api_entitlement_would_refuse')), 'shadow logged the would-refuse');
});

test('G1 using keys: enforce ends use of an existing key when the plan has no API access, and a payment lapse does not end key reads', async () => {
  const readSites = async (e, token) => {
    const r = await worker.fetch(new Request('https://cp.test/api/v1/sites', { headers: { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': nextIp() } }), e, ctx);
    return { status: r.status, text: await r.text() };
  };
  const off = newEnv('enforce');                                                   // API_ENTITLEMENT unset
  const starter = await org(off, 'plan_casino_news_starter'); await setSub(off, starter, { status: 'active' });
  const pro = await org(off, 'plan_casino_news_pro'); await setSub(off, pro, { status: 'active' });
  const keyStarter = (await createKey(off, starter)).json.token || (await createKey(off, starter)).json.data?.token;
  const keyPro = (await createKey(off, pro)).json.token || (await createKey(off, pro)).json.data?.token;
  assert.ok(keyStarter && keyPro, 'keys were issued while the setting was off');
  assert.equal((await readSites(off, keyStarter)).status, 200, 'off: a starter key still reads');
  const on = { ...off, API_ENTITLEMENT: 'enforce' };
  const refused = await readSites(on, keyStarter);
  assert.equal(refused.status, 403); assert.match(refused.text, /api_not_enabled/);
  assert.equal((await readSites(on, keyPro)).status, 200, 'a plan with API access keeps reading');
  await setSub(on, pro, { status: 'restricted', restricted_at: iso(-3600000) });
  assert.equal((await readSites(on, keyPro)).status, 200, 'read-only for non-payment: keys keep reading, like public sites');
  await setSub(on, pro, { status: 'suspended', suspended_at: iso(-3600000) });
  assert.notEqual((await readSites(on, keyPro)).status, 200, 'suspended still stops everything (serve gate)');
});

test('G2 a provider trial past its end date keeps its plan entitlements until the provider event arrives; a local trial still lapses by the clock', async () => {
  const e = newEnv('enforce'); const o = await org(e, 'plan_casino_news_pro');
  await setSub(e, o, { status: 'trialing', trial_ends_at: iso(-1 * DAY), provider_subscription_id: 'sub_provider' });
  assert.equal((await resolveAccess(e, o.organizationId)).canMutate, true, 'the state machine lets a provider trial keep working');
  const site = await call(e, 'POST', `${o.base}/sites`, { name: 'S1', productId: 'prod_casino_news' }, o.cookie);
  assert.equal(site.status, 200, `a site create returned ${site.status} ${site.text.slice(0, 80)}`);
  const ent = (await call(e, 'GET', `${o.base}/entitlements`, null, o.cookie)).json;
  const val = (k) => ((ent.data || ent.entitlements)[k]?.value ?? (ent.data || ent.entitlements)[k]);
  assert.equal(val('sites.max'), 3);
  // control: the same trial with no provider behind it lapses by the clock, as before
  const local = await org(e, 'plan_casino_news_pro');
  await setSub(e, local, { status: 'trialing', trial_ends_at: iso(-1 * DAY) });
  const lent = (await call(e, 'GET', `${local.base}/entitlements`, null, local.cookie)).json;
  assert.equal(((lent.data || lent.entitlements)['sites.max']?.value ?? (lent.data || lent.entitlements)['sites.max']), 0, 'a local expired trial still collapses to the floor');
});

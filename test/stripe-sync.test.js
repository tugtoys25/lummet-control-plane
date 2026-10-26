// Phase 3, sprint 3.1: scripts/stripe-sync (library and command line) against a fake Stripe and a sqlite stand-in for D1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, applyMigrations, splitSqlStatements } from './support/d1-shim.js';
import { runSync, buildSql, modeOfKey } from '../scripts/stripe-sync-lib.mjs';
import { catalogPrices } from '../worker/catalog.js';
import { StripeError } from '../worker/billing-stripe.js';
import * as subscriptionRepo from '../worker/repositories/billing-subscriptions.js';

const catalogFile = new URL('../catalog/plans.v1.json', import.meta.url);
const loadCatalog = () => JSON.parse(readFileSync(catalogFile, 'utf8'));
const N_PRICES = 48;

// ---------------------------------------------------------------- fake Stripe
function fakeStripe({ livemode = false, failPostNumber: failAt = null } = {}) {
  let failPostNumber = failAt;
  const products = new Map(); const prices = new Map(); const idem = new Map(); const log = []; let n = 1; let posts = 0;
  const notFound = () => new StripeError('No such object', { kind: 'rejected', status: 404, code: 'resource_missing' });
  async function stripe(method, path, params = {}, { idempotencyKey } = {}) {
    log.push({ method, path, params });
    if (method === 'POST') {
      posts++;
      if (failPostNumber && posts === failPostNumber) throw new StripeError('Stripe unreachable: timed out', { kind: 'unreachable' });
      if (!idempotencyKey) throw new Error('POST without an idempotency key: ' + path);
      if (idem.has(idempotencyKey)) return idem.get(idempotencyKey);
    }
    const [p, qs] = path.split('?'); const u = new URLSearchParams(qs || '');
    let out;
    if (method === 'GET' && p.startsWith('/products/')) { const x = products.get(decodeURIComponent(p.slice(10))); if (!x) throw notFound(); out = x; }
    else if (method === 'POST' && p === '/products') {
      if (products.has(params.id)) throw new StripeError('exists', { kind: 'rejected', status: 400 });
      out = { id: params.id, name: params.name, tax_code: params.tax_code, livemode }; products.set(params.id, out);
    } else if (method === 'GET' && p === '/prices') {
      const keys = u.getAll('lookup_keys[]'); out = { data: [...prices.values()].filter((x) => x.lookup_key && keys.includes(x.lookup_key)) };
    } else if (method === 'GET' && p.startsWith('/prices/')) { const x = prices.get(decodeURIComponent(p.slice(8))); if (!x) throw notFound(); out = x; }
    else if (method === 'POST' && p === '/prices') {
      if (!products.has(params.product)) throw new StripeError('no such product', { kind: 'rejected', status: 400 });
      if ([...prices.values()].some((x) => x.lookup_key === params.lookup_key)) throw new StripeError('lookup key in use', { kind: 'rejected', status: 400 });
      out = { id: 'price_' + n++, product: params.product, currency: params.currency, unit_amount: params.unit_amount, recurring: params.recurring, lookup_key: params.lookup_key, tax_behavior: params.tax_behavior || 'unspecified', active: true, livemode, nickname: params.nickname, metadata: params.metadata };
      prices.set(out.id, out);
    } else if (method === 'POST' && p.startsWith('/prices/')) {
      const x = prices.get(decodeURIComponent(p.slice(8))); if (!x) throw notFound();
      if ('unit_amount' in params || 'currency' in params) throw new Error('Stripe prices are immutable');
      if (params.lookup_key !== undefined) x.lookup_key = params.lookup_key;
      if (params.tax_behavior !== undefined) x.tax_behavior = params.tax_behavior;
      if (params.active !== undefined) x.active = params.active === 'true' || params.active === true;
      out = x;
    } else throw new Error(`fake stripe: unhandled ${method} ${path}`);
    if (method === 'POST') idem.set(idempotencyKey, out);
    return out;
  }
  stripe.products = products; stripe.prices = prices; stripe.log = log; stripe.heal = () => { failPostNumber = null; };
  stripe.posts = () => log.filter((l) => l.method === 'POST');
  return stripe;
}

// ---------------------------------------------------------------- sqlite stand-in for D1
function fakeDb() {
  const raw = createTestDb(); applyMigrations(raw);
  return {
    raw,
    query: async (sql) => (await raw.prepare(sql).all()).results.map((r) => ({ ...r })),
    exec: async (sql) => { for (const s of splitSqlStatements(sql)) raw._exec(s + ';'); }
  };
}
const rows = (db) => db.query(`SELECT pp.*, p.key AS plan_key FROM plan_prices pp JOIN plans p ON p.id = pp.plan_id ORDER BY pp.lookup_key`);
const kinds = (r) => { const t = {}; for (const a of r.plan.actions) t[a.kind] = (t[a.kind] || 0) + 1; return t; };
const base = (o = {}) => ({ catalog: loadCatalog(), mode: 'test', operator: 'tester', now: '2026-10-23T00:00:00Z', ...o });

// ---------------------------------------------------------------- dry run and apply
test('a dry run reads Stripe and the database and writes to neither', async () => {
  const stripe = fakeStripe(); const db = fakeDb();
  const r = await runSync(base({ stripe, db }));
  assert.equal(r.ok, true); assert.equal(r.applied, false);
  assert.deepEqual(kinds(r), { create_product: 9, create_price: N_PRICES });
  assert.equal(stripe.posts().length, 0);
  assert.equal((await rows(db)).length, 0);
  assert.equal((await db.query(`SELECT COUNT(*) n FROM lummet_audit_logs WHERE resource = 'plan_prices'`))[0].n, 0);
});

test('apply creates every product and price once, records plan_prices, mirrors plans for rollback and audits the run', async () => {
  const stripe = fakeStripe(); const db = fakeDb();
  const r = await runSync(base({ stripe, db, apply: true }));
  assert.equal(r.ok, true); assert.equal(r.applied, true);
  assert.equal(stripe.products.size, 9); assert.equal(stripe.prices.size, N_PRICES);
  assert.ok([...stripe.products.keys()].every((id) => /^prod_lummet_[a-z_]+$/.test(id)), 'deterministic product ids');
  const sp = [...stripe.prices.values()].find((x) => x.lookup_key === 'casino_news_starter_month_usd_v1');
  assert.deepEqual({ a: sp.unit_amount, c: sp.currency, i: sp.recurring.interval, p: sp.product, t: sp.tax_behavior }, { a: 500, c: 'usd', i: 'month', p: 'prod_lummet_casino_news', t: 'unspecified' });
  assert.equal(sp.metadata.lummet_plan_key, 'casino_news_starter');
  assert.equal(stripe.products.get('prod_lummet_casino_news').tax_code, 'txcd_10103001');
  const out = await rows(db);
  assert.equal(out.length, N_PRICES);
  assert.ok(out.every((x) => x.stripe_mode === 'test' && x.active === 1 && x.version === 1));
  const dbRow = out.find((x) => x.lookup_key === 'casino_news_starter_month_usd_v1');
  assert.equal(dbRow.stripe_price_id, sp.id); assert.equal(dbRow.unit_amount_cents, 500);
  const plan = (await db.query(`SELECT stripe_price_id, price_cents FROM plans WHERE key = 'casino_news_starter'`))[0];
  assert.deepEqual(plan, { stripe_price_id: sp.id, price_cents: 500 });
  const audit = await db.query(`SELECT * FROM lummet_audit_logs WHERE resource = 'plan_prices'`);
  assert.equal(audit.length, 1); assert.match(audit[0].action, /^catalog_sync:test:v1:48 prices$/); assert.match(audit[0].endpoint, /by tester$/);
  assert.equal(await subscriptionRepo.planIdForPrice({ LUMMET_DB: db.raw }, sp.id), 'plan_casino_news_starter');
});

test('running the sync again changes nothing and sends no write to Stripe', async () => {
  const stripe = fakeStripe(); const db = fakeDb();
  await runSync(base({ stripe, db, apply: true }));
  const before = await rows(db); const postsBefore = stripe.posts().length;
  const again = await runSync(base({ stripe, db, apply: true }));
  assert.equal(again.ok, true);
  assert.deepEqual(kinds(again), { ok: N_PRICES });
  assert.equal(stripe.posts().length, postsBefore, 'no Stripe write on the second run');
  assert.deepEqual(await rows(db), before);
  assert.equal(stripe.prices.size, N_PRICES);
});

test('a failure part-way through leaves the database untouched, and the next run finishes without duplicating anything', async () => {
  const stripe = fakeStripe({ failPostNumber: 20 }); const db = fakeDb();
  await assert.rejects(() => runSync(base({ stripe, db, apply: true })), /unreachable/);
  assert.equal((await rows(db)).length, 0, 'the database is written only after every Stripe step succeeded');
  assert.ok(stripe.prices.size > 0 && stripe.prices.size < N_PRICES);
  stripe.heal();                                    // same Stripe account, healthy now
  const ok = await runSync(base({ stripe, db, apply: true }));
  assert.equal(ok.ok, true);
  assert.equal(stripe.prices.size, N_PRICES); assert.equal((await rows(db)).length, N_PRICES);
  assert.equal(new Set([...stripe.prices.values()].map((x) => x.lookup_key)).size, N_PRICES);
});

// ---------------------------------------------------------------- immutability and conflicts
test('a Stripe price whose amount differs from the catalog is a conflict; nothing is written anywhere', async () => {
  const stripe = fakeStripe(); const db = fakeDb();
  await runSync(base({ stripe, db, apply: true }));
  const p = [...stripe.prices.values()].find((x) => x.lookup_key === 'casino_news_starter_month_usd_v1'); p.unit_amount = 700;
  const before = await rows(db); const posts = stripe.posts().length;
  const r = await runSync(base({ stripe, db, apply: true }));
  assert.equal(r.ok, false); assert.equal(r.stage, 'conflicts');
  assert.deepEqual(r.plan.conflicts.map((c) => c.kind), ['price_differs']);
  assert.match(r.plan.conflicts[0].message, /immutable: add a new version/);
  assert.equal(stripe.posts().length, posts); assert.deepEqual(await rows(db), before);
});

test('editing the amount of a synced price in the catalog is caught as a conflict, not applied', async () => {
  const stripe = fakeStripe(); const db = fakeDb();
  await runSync(base({ stripe, db, apply: true }));
  const c = loadCatalog(); c.plans.find((p) => p.key === 'casino_news_starter').prices[0].unit_amount_cents = 600;
  const r = await runSync(base({ catalog: c, stripe, db, apply: true }));
  assert.equal(r.ok, false); assert.equal(r.plan.conflicts[0].kind, 'price_differs');
  assert.equal((await db.query(`SELECT unit_amount_cents FROM plan_prices WHERE lookup_key = 'casino_news_starter_month_usd_v1'`))[0].unit_amount_cents, 500);
});

test('a new price version: new customers move to it, the old version is retired in Stripe and the database, nothing is deleted', async () => {
  const stripe = fakeStripe(); const db = fakeDb();
  await runSync(base({ stripe, db, apply: true }));
  const v1 = (await db.query(`SELECT stripe_price_id FROM plan_prices WHERE lookup_key = 'casino_news_starter_month_usd_v1'`))[0].stripe_price_id;
  const c = loadCatalog(); const plan = c.plans.find((p) => p.key === 'casino_news_starter');
  plan.prices[0].active = false;
  plan.prices.push({ version: 2, currency: 'usd', interval: 'month', unit_amount_cents: 600, tax_behavior: null, active: true });
  const r = await runSync(base({ catalog: c, stripe, db, apply: true }));
  assert.equal(r.ok, true, JSON.stringify(r.plan?.conflicts));
  assert.equal(stripe.prices.get(v1).active, false, 'old price archived in Stripe: no new checkouts on it');
  assert.equal(stripe.prices.get(v1).unit_amount, 500, 'and not edited');
  const got = await db.query(`SELECT version, active, unit_amount_cents, stripe_price_id FROM plan_prices WHERE plan_id = 'plan_casino_news_starter' ORDER BY version`);
  assert.deepEqual(got.map((x) => [x.version, x.active, x.unit_amount_cents]), [[1, 0, 500], [2, 1, 600]]);
  assert.equal((await db.query(`SELECT price_cents, stripe_price_id FROM plans WHERE key = 'casino_news_starter'`))[0].price_cents, 600);
  assert.equal(await subscriptionRepo.planIdForPrice({ LUMMET_DB: db.raw }, v1), 'plan_casino_news_starter', 'existing subscribers on v1 still map');
  const again = await runSync(base({ catalog: c, stripe, db, apply: true }));
  assert.equal(again.ok, true); assert.deepEqual(kinds(again), { ok: N_PRICES + 1 });
});

test('an inactive version that was never synced is not created in Stripe', async () => {
  const stripe = fakeStripe(); const db = fakeDb();
  const c = loadCatalog(); const plan = c.plans.find((p) => p.key === 'casino_news_starter');
  plan.prices[0].active = false;
  plan.prices.push({ version: 2, currency: 'usd', interval: 'month', unit_amount_cents: 600, tax_behavior: null, active: true });
  const r = await runSync(base({ catalog: c, stripe, db, apply: true }));
  assert.equal(r.ok, true);
  assert.equal(r.plan.actions.filter((a) => a.kind === 'skip_inactive').length, 1);
  assert.ok(![...stripe.prices.values()].some((x) => x.lookup_key === 'casino_news_starter_month_usd_v1'));
  assert.equal((await rows(db)).length, N_PRICES);
});

test('livemode must agree with --mode: a live price seen in test mode is a conflict', async () => {
  const stripe = fakeStripe(); const db = fakeDb();
  await runSync(base({ stripe, db, apply: true }));
  for (const p of stripe.prices.values()) p.livemode = true;
  const r = await runSync(base({ stripe, db }));
  assert.equal(r.ok, false); assert.ok(r.plan.conflicts.every((c) => c.kind === 'livemode_mismatch')); assert.equal(r.plan.conflicts.length, N_PRICES);
});

test('a database that already holds prices of the other mode is refused', async () => {
  const stripe = fakeStripe(); const db = fakeDb();
  await runSync(base({ stripe, db, apply: true }));
  const live = fakeStripe({ livemode: true });
  const r = await runSync(base({ mode: 'live', stripe: live, db, apply: true }));
  assert.equal(r.ok, false); assert.equal(r.plan.conflicts[0].kind, 'wrong_database_for_mode');
  assert.equal(live.posts().length, 0, 'nothing was created in live mode');
});

test('an archived Stripe price that the catalog still lists as active is a conflict', async () => {
  const stripe = fakeStripe(); const db = fakeDb();
  await runSync(base({ stripe, db, apply: true }));
  [...stripe.prices.values()].find((x) => x.lookup_key === 'casino_news_pro_month_usd_v1').active = false;
  const r = await runSync(base({ stripe, db }));
  assert.equal(r.ok, false); assert.equal(r.plan.conflicts[0].kind, 'archived_in_stripe');
});

// ---------------------------------------------------------------- legacy prices (the old free-text field)
async function withLegacy(db, planId, priceId) {
  await db.exec(`UPDATE plans SET stripe_price_id = '${priceId}' WHERE id = '${planId}';`);
  await db.exec(readFileSync(new URL('../migrations/0052_plan_prices.sql', import.meta.url), 'utf8'));
}
const stripeWith = (stripe, id, over = {}) => { stripe.prices.set(id, { id, product: 'prod_hand_made', currency: 'usd', unit_amount: 500, recurring: { interval: 'month' }, lookup_key: null, active: true, tax_behavior: 'unspecified', livemode: false, ...over }); };

test('a price customers already pay is ADOPTED (given its lookup key), never duplicated, and keeps its id', async () => {
  const stripe = fakeStripe(); const db = fakeDb();
  await withLegacy(db, 'plan_casino_news_starter', 'price_legacy');
  stripeWith(stripe, 'price_legacy');
  const r = await runSync(base({ stripe, db, apply: true }));
  assert.equal(r.ok, true, JSON.stringify(r.plan?.conflicts));
  assert.equal(stripe.prices.get('price_legacy').lookup_key, 'casino_news_starter_month_usd_v1');
  assert.equal(stripe.prices.size, N_PRICES, 'one price per catalog entry, the legacy one included');
  const row = (await db.query(`SELECT * FROM plan_prices WHERE lookup_key = 'casino_news_starter_month_usd_v1'`))[0];
  assert.deepEqual({ id: row.stripe_price_id, mode: row.stripe_mode }, { id: 'price_legacy', mode: 'test' });
  assert.equal((await rows(db)).length, N_PRICES);
  assert.equal(await subscriptionRepo.planIdForPrice({ LUMMET_DB: db.raw }, 'price_legacy'), 'plan_casino_news_starter');
});

test('a legacy price that charges a different amount than the catalog is a conflict, nothing is written', async () => {
  const stripe = fakeStripe(); const db = fakeDb();
  await withLegacy(db, 'plan_casino_news_starter', 'price_legacy');
  stripeWith(stripe, 'price_legacy', { unit_amount: 450 });
  const r = await runSync(base({ stripe, db, apply: true }));
  assert.equal(r.ok, false); assert.equal(r.plan.conflicts[0].kind, 'legacy_price_differs');
  assert.match(r.plan.conflicts[0].message, /450 usd\/month/);
  assert.equal(stripe.posts().length, 0);
  assert.equal((await rows(db)).length, 1);
});

test('a legacy id that does not exist in this Stripe mode never worked here: it is replaced by the catalog price', async () => {
  const stripe = fakeStripe(); const db = fakeDb();
  await withLegacy(db, 'plan_casino_news_starter', 'price_from_other_mode');
  const r = await runSync(base({ stripe, db, apply: true }));
  assert.equal(r.ok, true);
  const row = (await db.query(`SELECT * FROM plan_prices WHERE lookup_key = 'casino_news_starter_month_usd_v1'`))[0];
  assert.notEqual(row.stripe_price_id, 'price_from_other_mode'); assert.equal(row.stripe_mode, 'test');
  assert.equal((await rows(db)).length, N_PRICES);
});

test('a database price Stripe no longer returns is a conflict, not a silent re-create', async () => {
  const stripe = fakeStripe(); const db = fakeDb();
  await runSync(base({ stripe, db, apply: true }));
  const gone = fakeStripe(); // an empty Stripe account: someone pointed the key at the wrong account
  const r = await runSync(base({ stripe: gone, db }));
  assert.equal(r.ok, false); assert.ok(r.plan.conflicts.every((c) => c.kind === 'db_price_missing_in_stripe'));
});

// ---------------------------------------------------------------- tax behavior
test('a catalog tax behavior is set on a new price, and set once on an existing price that has none', async () => {
  const stripe = fakeStripe(); const db = fakeDb();
  const c = loadCatalog(); c.tax.default_tax_behavior = 'exclusive';
  await runSync(base({ catalog: c, stripe, db, apply: true }));
  assert.ok([...stripe.prices.values()].every((p) => p.tax_behavior === 'exclusive'));
  assert.ok((await rows(db)).every((r) => r.tax_behavior === 'exclusive'));

  const s2 = fakeStripe(); const d2 = fakeDb();
  await runSync(base({ stripe: s2, db: d2, apply: true }));            // created 'unspecified'
  const r = await runSync(base({ catalog: c, stripe: s2, db: d2, apply: true }));
  assert.equal(r.ok, true); assert.equal(kinds(r).set_tax_behavior, N_PRICES);
  assert.ok([...s2.prices.values()].every((p) => p.tax_behavior === 'exclusive'));
  // once set it cannot be changed
  const c2 = loadCatalog(); c2.tax.default_tax_behavior = 'inclusive';
  const bad = await runSync(base({ catalog: c2, stripe: s2, db: d2 }));
  assert.equal(bad.ok, false); assert.equal(bad.plan.conflicts[0].kind, 'tax_behavior_differs');
});

// ---------------------------------------------------------------- guards
test('an invalid catalog stops before any call; --apply without a database is refused', async () => {
  const stripe = fakeStripe(); const db = fakeDb();
  const c = loadCatalog(); c.plans[0].prices[0].unit_amount_cents = -1;
  const bad = await runSync(base({ catalog: c, stripe, db, apply: true }));
  assert.equal(bad.ok, false); assert.equal(bad.stage, 'catalog'); assert.equal(stripe.log.length, 0);
  const noDb = await runSync(base({ stripe, apply: true }));
  assert.equal(noDb.ok, false); assert.equal(noDb.stage, 'usage'); assert.equal(stripe.log.length, 0);
});

test('the entry price floor stops a sync before any call', async () => {
  const stripe = fakeStripe(); const db = fakeDb();
  const c = loadCatalog(); c.decisions.entry_price_floor_cents = 900;
  const r = await runSync(base({ catalog: c, stripe, db, apply: true }));
  assert.equal(r.stage, 'catalog'); assert.ok(r.problems.some((p) => /floor/.test(p))); assert.equal(stripe.log.length, 0);
});

test('the generated SQL escapes quotes, mirrors only active prices, and holds no key or secret', async () => {
  const c = loadCatalog(); c.plans.find((p) => p.key === 'casino_news_starter').name = "Starter' ; DROP TABLE plans; --";
  const stripe = fakeStripe(); const db = fakeDb();
  const r = await runSync(base({ catalog: c, stripe, db, apply: true, operator: "o'brien" }));
  assert.equal(r.ok, true);
  assert.match(r.sql, /by o''brien/);
  assert.doesNotMatch(r.sql, /sk_|rk_|whsec_|DROP TABLE/);
  assert.equal((await db.query(`SELECT COUNT(*) n FROM plans`))[0].n, 50, 'plans intact');
  assert.equal((r.sql.match(/^UPDATE plans SET/gm) || []).length, N_PRICES);
  assert.throws(() => buildSql({ catalog: c, mode: 'test', plan: { actions: [{ kind: 'create_price', price: catalogPrices(c)[0], lookupKey: 'x' }] }, created: new Map(), now: 'n' }), /no Stripe price id/);
});

test('modeOfKey reads the key prefix only', () => {
  assert.equal(modeOfKey('sk_test_abc'), 'test'); assert.equal(modeOfKey('rk_live_abc'), 'live');
  assert.equal(modeOfKey('pk_live_abc'), null); assert.equal(modeOfKey(''), null); assert.equal(modeOfKey(undefined), null);
});

// ---------------------------------------------------------------- the command line
const SCRIPT = new URL('../scripts/stripe-sync.mjs', import.meta.url).pathname;
const cli = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

test('CLI: --offline validates the catalog with no key and no network', () => {
  const r = cli(['--offline']);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Catalog v1 is valid: 10 products, 50 plans, 48 prices \(48 active\)/);
});

test('CLI: refuses a mode that does not match the key, a missing key, a missing --db and a bad catalog, before any call', () => {
  const mismatch = cli(['--mode', 'live', '--db', 'x'], { STRIPE_SECRET_KEY: 'sk_test_dummy' });
  assert.equal(mismatch.status, 1); assert.match(mismatch.stderr, /REFUSED: --mode live but STRIPE_SECRET_KEY is a test-mode key/);
  const noKey = cli(['--mode', 'test', '--db', 'x']); assert.equal(noKey.status, 2); assert.match(noKey.stderr, /STRIPE_SECRET_KEY/);
  const noDb = cli(['--mode', 'test'], { STRIPE_SECRET_KEY: 'sk_test_dummy' }); assert.equal(noDb.status, 2); assert.match(noDb.stderr, /--db/);
  const noMode = cli(['--db', 'x'], { STRIPE_SECRET_KEY: 'sk_test_dummy' }); assert.equal(noMode.status, 2); assert.match(noMode.stderr, /--mode/);
  const dir = mkdtempSync(join(tmpdir(), 'cat-')); const f = join(dir, 'bad.json');
  const c = loadCatalog(); c.plans[0].prices[0].unit_amount_cents = 0; writeFileSync(f, JSON.stringify(c));
  const bad = cli(['--offline', '--catalog', f]); assert.equal(bad.status, 1); assert.match(bad.stderr, /CATALOG INVALID/);
  const missing = cli(['--offline', '--catalog', join(dir, 'nope.json')]); assert.equal(missing.status, 2);
});

test('CLI: end to end against a stubbed Stripe and a fake wrangler: dry run changes nothing, --apply writes the database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-e2e-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const wrangler = join(bin, 'wrangler');
  writeFileSync(wrangler, `#!/usr/bin/env node\nimport('${new URL('./support/fake-wrangler.mjs', import.meta.url).pathname}');\n`); chmodSync(wrangler, 0o755);
  // a real sqlite file holding the control-plane schema, built by the real migration runner through the fake wrangler
  const dbPath = join(dir, 'db.sqlite');
  const mig = spawnSync(process.execPath, [new URL('../scripts/migrate.mjs', import.meta.url).pathname, '--db', 'cp-db', '--remote'], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, FAKE_WRANGLER_DB_PATH: dbPath } });
  assert.equal(mig.status, 0, mig.stdout + mig.stderr);
  // Stripe stub: a preload module replaces global fetch with the fake, so the real stripeRequest path (headers, encoding) runs.
  const preload = join(dir, 'fetch-stub.mjs');
  writeFileSync(preload, `
    const products = new Map(), prices = new Map(); let n = 1;
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url); const p = u.pathname.replace('/v1', ''); const m = init.method || 'GET';
      const body = new URLSearchParams(init.body || '');
      if (init.headers['Authorization'] !== 'Bearer sk_test_cli') return json(401, { error: { message: 'bad key' } });
      if (m === 'POST' && !init.headers['Idempotency-Key']) return json(400, { error: { message: 'no idempotency key' } });
      if (m === 'GET' && p.startsWith('/products/')) { const x = products.get(p.slice(10)); return x ? json(200, x) : json(404, { error: { code: 'resource_missing', message: 'no' } }); }
      if (m === 'POST' && p === '/products') { const x = { id: body.get('id'), livemode: false }; products.set(x.id, x); return json(200, x); }
      if (m === 'GET' && p === '/prices') { const keys = u.searchParams.getAll('lookup_keys[]'); return json(200, { data: [...prices.values()].filter((x) => keys.includes(x.lookup_key)) }); }
      if (m === 'GET' && p.startsWith('/prices/')) { const x = prices.get(p.slice(8)); return x ? json(200, x) : json(404, { error: { code: 'resource_missing', message: 'no' } }); }
      if (m === 'POST' && p === '/prices') { const x = { id: 'price_cli' + n++, unit_amount: Number(body.get('unit_amount')), currency: body.get('currency'), recurring: { interval: body.get('recurring[interval]') }, lookup_key: body.get('lookup_key'), active: true, livemode: false, tax_behavior: 'unspecified' }; prices.set(x.id, x); return json(200, x); }
      return json(500, { error: { message: 'unhandled ' + m + ' ' + p } });
    };`);
  const run = (extra) => spawnSync(process.execPath, ['--import', preload, SCRIPT, '--mode', 'test', '--db', 'cp-db', '--remote', ...extra], {
    encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, FAKE_WRANGLER_DB_PATH: dbPath, STRIPE_SECRET_KEY: 'sk_test_cli', STRIPE_RETRY_BASE_MS: '0', USER: 'cli-tester' }
  });
  const count = () => { const { DatabaseSync: D } = createRequire(import.meta.url)('node:sqlite'); const s = new D(dbPath); const n = s.prepare('SELECT COUNT(*) n FROM plan_prices').get().n; s.close(); return n; };
  const dry = run([]);
  assert.equal(dry.status, 0, dry.stdout + dry.stderr); assert.match(dry.stdout, /DRY RUN/); assert.match(dry.stdout, /Nothing was changed/);
  assert.equal(count(), 0);
  const sqlOut = join(dir, 'out.sql');
  const applied = run(['--apply', '--sql-out', sqlOut]);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr); assert.match(applied.stdout, /APPLIED/);
  assert.equal(count(), 48);
  assert.match(readFileSync(sqlOut, 'utf8'), /INSERT INTO plan_prices/);
  assert.doesNotMatch(applied.stdout + applied.stderr + readFileSync(sqlOut, 'utf8'), /sk_test_cli/, 'the key never appears in output or SQL');
});


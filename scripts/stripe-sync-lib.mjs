// Logic behind scripts/stripe-sync.mjs (Phase 3, sprint 3.1). Kept in a library so the tests drive it with a fake
// Stripe and a sqlite stand-in for D1, with no network and no wrangler.
//
// What a sync does, per catalog price (see worker/catalog.js):
//   1. find the Stripe price by its lookup key; if none, adopt the legacy price the database already holds for it (set the
//      lookup key on it), or create a new one;
//   2. verify what Stripe cannot change (amount, currency, interval) still equals the catalog; a difference is a CONFLICT and
//      nothing is written for it (prices are immutable: change the catalog by adding a new version);
//   3. write the result into plan_prices as SQL (idempotent), mirror the active price into plans for rollback, audit it.
// A dry run (the default) reads Stripe and the database and writes nothing anywhere.
import { catalogPrices, stripeProductId, validateCatalog } from "../worker/catalog.js";

export const modeOfKey = (key) => (/^(sk|rk)_test_/.test(String(key || "")) ? "test" : /^(sk|rk)_live_/.test(String(key || "")) ? "live" : null);
const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const isMissing = (e) => e && (e.status === 404 || e.code === "resource_missing");

/** Reads what the sync needs from Stripe. `stripe(method, path, params, { idempotencyKey })` is the injected client. */
export async function readStripeState({ catalog, stripe, dbRows }) {
  const prices = catalogPrices(catalog);
  const productKeys = [...new Set(prices.map((p) => p.productKey))];
  const products = new Map();
  for (const key of productKeys) {
    const id = stripeProductId(key);
    try { products.set(id, await stripe("GET", `/products/${encodeURIComponent(id)}`)); }
    catch (e) { if (isMissing(e)) products.set(id, null); else throw e; }
  }
  const byLookup = new Map();
  const keys = prices.map((p) => p.lookupKey);
  for (let i = 0; i < keys.length; i += 10) {
    const chunk = keys.slice(i, i + 10);
    const qs = chunk.map((k) => `lookup_keys%5B%5D=${encodeURIComponent(k)}`).join("&");
    const page = await stripe("GET", `/prices?limit=100&${qs}`);
    for (const p of page.data || []) if (p.lookup_key) byLookup.set(p.lookup_key, p);
  }
  // Legacy prices the database holds (mode still unknown) that Stripe did not return by lookup key: fetch them by id so
  // they can be adopted instead of duplicated.
  const legacy = new Map();
  for (const row of dbRows || []) {
    if (row.stripe_mode !== "unknown" || byLookup.has(row.lookup_key)) continue;
    try { legacy.set(row.stripe_price_id, await stripe("GET", `/prices/${encodeURIComponent(row.stripe_price_id)}`)); }
    catch (e) { if (isMissing(e)) legacy.set(row.stripe_price_id, null); else throw e; }
  }
  return { products, byLookup, legacy };
}

const matches = (sp, c) => sp.unit_amount === c.unitAmountCents && String(sp.currency).toLowerCase() === c.currency && sp.recurring?.interval === c.interval;
const describe = (sp) => `${sp.unit_amount} ${String(sp.currency).toLowerCase()}/${sp.recurring?.interval}`;

/**
 * Pure: turns the catalog, the mode, what Stripe holds and what the database holds into a list of actions and conflicts.
 * Action kinds: create_product, create_price, adopt_price, set_tax_behavior, archive_price, ok, skip_inactive.
 */
export function planSync({ catalog, mode, state, dbRows }) {
  const actions = [];
  const conflicts = [];
  const conflict = (c, kind, message) => conflicts.push({ lookupKey: c.lookupKey, kind, message });
  const live = mode === "live";
  const rowsByLookup = new Map((dbRows || []).map((r) => [r.lookup_key, r]));

  for (const row of dbRows || []) {
    if (row.stripe_mode !== "unknown" && row.stripe_mode !== mode) {
      conflicts.push({ lookupKey: row.lookup_key, kind: "wrong_database_for_mode", message: `the database holds a ${row.stripe_mode}-mode price but this run is --mode ${mode}; point --db at the ${mode} environment's database` });
    }
  }

  const productsNeeded = new Set(catalogPrices(catalog).filter((p) => p.active || state.byLookup.has(p.lookupKey) || rowsByLookup.has(p.lookupKey)).map((p) => p.productKey));
  for (const key of productsNeeded) {
    const id = stripeProductId(key);
    const sp = state.products.get(id);
    if (!sp) actions.push({ kind: "create_product", productKey: key, stripeProductId: id });
    else if (sp.livemode !== undefined && sp.livemode !== live) conflicts.push({ lookupKey: id, kind: "livemode_mismatch", message: `product ${id} livemode=${sp.livemode} but --mode ${mode}` });
  }

  for (const c of catalogPrices(catalog)) {
    const found = state.byLookup.get(c.lookupKey);
    const row = rowsByLookup.get(c.lookupKey);
    const base = { lookupKey: c.lookupKey, price: c };

    if (found) {
      if (found.livemode !== undefined && found.livemode !== live) { conflict(c, "livemode_mismatch", `Stripe price ${found.id} livemode=${found.livemode} but --mode ${mode}`); continue; }
      if (!matches(found, c)) { conflict(c, "price_differs", `Stripe holds ${describe(found)} for this lookup key, the catalog says ${c.unitAmountCents} ${c.currency}/${c.interval}. Prices are immutable: add a new version in the catalog instead of editing this one`); continue; }
      if (row && row.stripe_price_id !== found.id) { conflict(c, "db_price_id_differs", `the database maps this lookup key to ${row.stripe_price_id} but Stripe's price is ${found.id}; resolve by hand before syncing`); continue; }
      if (c.taxBehavior !== "unspecified" && found.tax_behavior !== c.taxBehavior) {
        if (found.tax_behavior && found.tax_behavior !== "unspecified") { conflict(c, "tax_behavior_differs", `Stripe has tax_behavior ${found.tax_behavior}, the catalog says ${c.taxBehavior}; it cannot be changed once set`); continue; }
        actions.push({ ...base, kind: "set_tax_behavior", stripePriceId: found.id });
      }
      if (!c.active && found.active) actions.push({ ...base, kind: "archive_price", stripePriceId: found.id });
      else if (c.active && !found.active) { conflict(c, "archived_in_stripe", `price ${found.id} is archived in Stripe but active in the catalog; restore it in Stripe or add a new version`); continue; }
      actions.push({ ...base, kind: "ok", stripePriceId: found.id, mode });
      continue;
    }

    // Not found by lookup key.
    if (row) {
      const legacy = state.legacy.get(row.stripe_price_id);
      if (row.stripe_mode === "unknown" && legacy) {
        if (legacy.livemode !== undefined && legacy.livemode !== live) { conflict(c, "livemode_mismatch", `legacy price ${legacy.id} livemode=${legacy.livemode} but --mode ${mode}`); continue; }
        if (!matches(legacy, c)) { conflict(c, "legacy_price_differs", `the price ${legacy.id} already in use charges ${describe(legacy)} but the catalog says ${c.unitAmountCents} ${c.currency}/${c.interval}. Fix the catalog to match what customers pay, or retire this plan and add a new one`); continue; }
        actions.push({ ...base, kind: "adopt_price", stripePriceId: legacy.id });
        if (!c.active) actions.push({ ...base, kind: "archive_price", stripePriceId: legacy.id });
        actions.push({ ...base, kind: "ok", stripePriceId: legacy.id, mode });
        continue;
      }
      if (row.stripe_mode === "unknown" && legacy === null) {
        // The id never existed in THIS mode, so it never worked here and no subscription in this mode can use it: replace it.
        actions.push({ ...base, kind: "create_price", replaces: row.stripe_price_id });
        continue;
      }
      conflict(c, "db_price_missing_in_stripe", `the database holds ${row.stripe_price_id} (${row.stripe_mode}) for this lookup key but Stripe does not return it`);
      continue;
    }

    if (!c.active) { actions.push({ ...base, kind: "skip_inactive" }); continue; }
    actions.push({ ...base, kind: "create_price" });
  }
  return { actions, conflicts };
}

/** Executes create / adopt / tax / archive actions against Stripe; returns lookupKey -> { stripePriceId, active }. */
export async function applyStripeActions({ catalog, actions, stripe, catalogVersion }) {
  const results = new Map();
  const planName = new Map(catalog.plans.map((p) => [p.key, p.name]));
  const productCfg = new Map(catalog.products.map((p) => [p.key, p]));
  for (const a of actions.filter((x) => x.kind === "create_product")) {
    const cfg = productCfg.get(a.productKey);
    await stripe("POST", "/products", {
      id: a.stripeProductId, name: cfg.name,
      tax_code: cfg.tax_code || catalog.tax?.default_tax_code || undefined,
      metadata: { lummet_product_key: a.productKey, lummet_catalog_version: catalogVersion }
    }, { idempotencyKey: `product:${a.stripeProductId}` });
  }
  for (const a of actions) {
    if (a.kind === "create_price") {
      const c = a.price;
      const created = await stripe("POST", "/prices", {
        product: stripeProductId(c.productKey), currency: c.currency, unit_amount: c.unitAmountCents,
        recurring: { interval: c.interval }, lookup_key: c.lookupKey,
        tax_behavior: c.taxBehavior === "unspecified" ? undefined : c.taxBehavior,
        nickname: `${planName.get(c.planKey) || c.planKey} (${c.interval}) v${c.version}`.slice(0, 250),
        metadata: { lummet_plan_key: c.planKey, lummet_price_version: c.version, lummet_catalog_version: catalogVersion }
      }, { idempotencyKey: `price:${c.lookupKey}` });
      results.set(c.lookupKey, { stripePriceId: created.id });
      if (!c.active) await stripe("POST", `/prices/${created.id}`, { active: "false" }, { idempotencyKey: `price-archive:${created.id}` });
    } else if (a.kind === "adopt_price") {
      await stripe("POST", `/prices/${encodeURIComponent(a.stripePriceId)}`, { lookup_key: a.lookupKey, nickname: undefined }, { idempotencyKey: `price-adopt:${a.stripePriceId}:${a.lookupKey}` });
    } else if (a.kind === "set_tax_behavior") {
      await stripe("POST", `/prices/${encodeURIComponent(a.stripePriceId)}`, { tax_behavior: a.price.taxBehavior }, { idempotencyKey: `price-tax:${a.stripePriceId}:${a.price.taxBehavior}` });
    } else if (a.kind === "archive_price") {
      await stripe("POST", `/prices/${encodeURIComponent(a.stripePriceId)}`, { active: "false" }, { idempotencyKey: `price-archive:${a.stripePriceId}` });
    }
  }
  return results;
}

/**
 * SQL that records the result in plan_prices. Idempotent. Never changes the amount, currency, interval, plan, lookup key
 * or version of an existing row (immutability); it only inserts, stamps the Stripe mode, and flips `active`.
 * Inactive prices come first so a new active version never meets the one-active-price index with the old one still active.
 */
export function buildSql({ catalog, mode, plan, created, operator, now }) {
  const out = ["-- Generated by scripts/stripe-sync.mjs. Safe to run twice.", `-- mode: ${mode}   catalog_version: ${catalog.catalog_version}   at: ${now}`];
  const resolved = [];
  for (const a of plan.actions) {
    if (a.kind === "ok") resolved.push({ c: a.price, id: a.stripePriceId, replaces: null });
    else if (a.kind === "create_price") resolved.push({ c: a.price, id: created.get(a.lookupKey)?.stripePriceId, replaces: a.replaces || null });
  }
  // an adopted price also emits "ok"; a created price emits only create_price: de-duplicate by lookup key
  const seen = new Set();
  const rows = resolved.filter((r) => (seen.has(r.c.lookupKey) ? false : seen.add(r.c.lookupKey))).sort((x, y) => Number(x.c.active) - Number(y.c.active));
  for (const r of rows) {
    if (!r.id) throw new Error(`no Stripe price id for ${r.c.lookupKey}`);
    const c = r.c;
    if (r.replaces) {
      out.push(`UPDATE plan_prices SET stripe_price_id = ${q(r.id)}, stripe_mode = ${q(mode)} WHERE lookup_key = ${q(c.lookupKey)} AND stripe_mode = 'unknown' AND stripe_price_id = ${q(r.replaces)};`);
    }
    out.push(
      `INSERT INTO plan_prices (id, plan_id, currency, interval, unit_amount_cents, tax_behavior, stripe_price_id, lookup_key, stripe_mode, version, active)\n` +
      `SELECT ${q("pp_" + c.lookupKey)}, p.id, ${q(c.currency)}, ${q(c.interval)}, ${c.unitAmountCents}, ${q(c.taxBehavior)}, ${q(r.id)}, ${q(c.lookupKey)}, ${q(mode)}, ${c.version}, ${c.active ? 1 : 0}\n` +
      `  FROM plans p WHERE p.key = ${q(c.planKey)}\n` +
      `ON CONFLICT(lookup_key) DO UPDATE SET stripe_mode = excluded.stripe_mode, active = excluded.active\n` +
      `  WHERE plan_prices.stripe_price_id = excluded.stripe_price_id;`
    );
  }
  // Rollback support: the older code reads plans.stripe_price_id / price_cents. Mirror the active price of the plan's own currency.
  for (const r of rows.filter((x) => x.c.active)) {
    out.push(`UPDATE plans SET stripe_price_id = ${q(r.id)}, price_cents = ${r.c.unitAmountCents} WHERE key = ${q(r.c.planKey)} AND lower(currency) = ${q(r.c.currency)};`);
  }
  const audit = `catalog_sync:${mode}:v${catalog.catalog_version}:${rows.length} prices`;
  out.push(`INSERT INTO lummet_audit_logs (admin_id, endpoint, method, resource, resource_id, action, success, status_code) VALUES (NULL, ${q("scripts/stripe-sync.mjs by " + (operator || "unknown"))}, 'CLI', 'plan_prices', ${q("catalog_v" + catalog.catalog_version)}, ${q(audit)}, 1, 200);`);
  return out.join("\n") + "\n";
}

/**
 * The whole run. `db` is { query(sql) -> rows, exec(sql) } or null; `stripe` the injected client.
 * Returns { ok, plan, sql, appliedToDb }. Dry run (apply=false) writes nothing to Stripe or the database.
 */
export async function runSync({ catalog, mode, stripe, db, apply = false, operator = "unknown", now = new Date().toISOString(), log = () => {} }) {
  const problems = validateCatalog(catalog);
  if (problems.length) return { ok: false, stage: "catalog", problems };
  if (apply && !db) return { ok: false, stage: "usage", problems: ["--apply needs --db so existing prices are read first (a price already in use must be adopted, never duplicated)"] };

  const dbRows = db ? await db.query(`SELECT pp.lookup_key, pp.stripe_price_id, pp.stripe_mode, pp.active, p.key AS plan_key FROM plan_prices pp JOIN plans p ON p.id = pp.plan_id`) : [];
  const state = await readStripeState({ catalog, stripe, dbRows });
  const plan = planSync({ catalog, mode, state, dbRows });
  log(plan);
  if (plan.conflicts.length) return { ok: false, stage: "conflicts", plan };
  if (!apply) return { ok: true, plan, applied: false };

  const created = await applyStripeActions({ catalog, actions: plan.actions, stripe, catalogVersion: catalog.catalog_version });
  const sql = buildSql({ catalog, mode, plan, created, operator, now });
  await db.exec(sql);
  return { ok: true, plan, sql, applied: true };
}

// =====================================================
// CATALOG AS CODE (Phase 3, sprint 3.1)
//
// Pure helpers for catalog/plans.v1.json: the lookup-key rule, the price list a catalog implies, and validation.
// No I/O, so scripts/stripe-sync.mjs, the tests and `npm run catalog:check` share one definition. The Worker does
// not read the JSON file at runtime; it reads the plan_prices table the sync script fills.
// =====================================================

export const INTERVALS = ["month", "year"];
export const TAX_BEHAVIORS = ["inclusive", "exclusive", "unspecified"];
export const PERIOD_INTERVAL = { monthly: "month", annual: "year" };

/** <plan key>_<interval>_<currency>_v<version>, e.g. casino_news_starter_month_usd_v1. Stable; never reused. */
export function priceLookupKey(planKey, interval, currency, version) {
  return `${planKey}_${interval}_${String(currency).toLowerCase()}_v${version}`;
}

/** Deterministic Stripe product id for a catalog product, so a sync can never create a duplicate. */
export function stripeProductId(productKey) {
  return `prod_lummet_${productKey}`;
}

/** Every price the catalog defines, flattened, with its lookup key and resolved tax behavior. */
export function catalogPrices(catalog) {
  const out = [];
  for (const plan of catalog.plans || []) {
    for (const price of plan.prices || []) {
      const currency = String(price.currency).toLowerCase();
      out.push({
        planKey: plan.key,
        productKey: plan.product,
        planName: plan.name,
        currency,
        interval: price.interval,
        unitAmountCents: price.unit_amount_cents,
        taxBehavior: price.tax_behavior || catalog.tax?.default_tax_behavior || "unspecified",
        version: price.version,
        active: price.active !== false,
        lookupKey: priceLookupKey(plan.key, price.interval, currency, price.version)
      });
    }
  }
  return out;
}

/**
 * Returns a list of problems (strings); empty means the catalog is valid. Checks structure, uniqueness, the
 * one-active-price rule, the period/interval pairing and the owner's entry price floor.
 */
export function validateCatalog(catalog) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!catalog || typeof catalog !== "object") return ["catalog is not an object"];
  if (!Number.isInteger(catalog.catalog_version) || catalog.catalog_version < 1) err("catalog_version must be a positive integer");
  if (!Array.isArray(catalog.products) || !catalog.products.length) err("products must be a non-empty array");
  if (!Array.isArray(catalog.plans) || !catalog.plans.length) err("plans must be a non-empty array");
  if (errors.length) return errors;

  const floor = catalog.decisions?.entry_price_floor_cents;
  if (floor != null && (!Number.isInteger(floor) || floor < 0)) err("decisions.entry_price_floor_cents must be null or a non-negative integer");
  const dtb = catalog.tax?.default_tax_behavior;
  if (dtb != null && !TAX_BEHAVIORS.includes(dtb)) err(`tax.default_tax_behavior must be one of ${TAX_BEHAVIORS.join(", ")}`);
  const dtc = catalog.tax?.default_tax_code;
  if (dtc != null && !/^txcd_\d{8}$/.test(dtc)) err("tax.default_tax_code must look like txcd_12345678");

  const productKeys = new Set();
  for (const p of catalog.products) {
    if (!/^[a-z][a-z0-9_]*$/.test(p.key || "")) err(`product key ${JSON.stringify(p.key)} must be lower_snake_case`);
    if (productKeys.has(p.key)) err(`duplicate product key ${p.key}`);
    productKeys.add(p.key);
    if (!p.name) err(`product ${p.key} has no name`);
    if (p.tax_code != null && !/^txcd_\d{8}$/.test(p.tax_code)) err(`product ${p.key}: tax_code must look like txcd_12345678`);
  }

  const planKeys = new Set();
  const lookupKeys = new Set();
  for (const plan of catalog.plans) {
    const where = `plan ${plan.key}`;
    if (!/^[a-z][a-z0-9_]*$/.test(plan.key || "")) err(`plan key ${JSON.stringify(plan.key)} must be lower_snake_case`);
    if (planKeys.has(plan.key)) err(`duplicate plan key ${plan.key}`);
    planKeys.add(plan.key);
    if (!productKeys.has(plan.product)) err(`${where}: unknown product ${plan.product}`);
    if (!["monthly", "annual", "custom"].includes(plan.period)) err(`${where}: period must be monthly, annual or custom`);
    if (!["active", "retired"].includes(plan.status)) err(`${where}: status must be active or retired`);
    if (!Number.isInteger(plan.trial_days) || plan.trial_days < 0 || plan.trial_days > 90) err(`${where}: trial_days must be 0 to 90`);
    if (!Array.isArray(plan.prices)) { err(`${where}: prices must be an array`); continue; }
    if (plan.period === "custom" && plan.prices.length) err(`${where}: a custom plan has no self-serve price`);
    if (plan.period !== "custom" && !plan.prices.length) err(`${where}: a ${plan.period} plan needs at least one price`);

    const activeSeen = new Set();
    const versionsSeen = new Set();
    for (const price of plan.prices) {
      const tag = `${where} v${price.version}`;
      if (!Number.isInteger(price.version) || price.version < 1) { err(`${tag}: version must be a positive integer`); continue; }
      if (!/^[a-z]{3}$/.test(String(price.currency || ""))) err(`${tag}: currency must be a lower-case ISO code`);
      if (!INTERVALS.includes(price.interval)) err(`${tag}: interval must be month or year`);
      if (PERIOD_INTERVAL[plan.period] && price.interval !== PERIOD_INTERVAL[plan.period]) err(`${tag}: a ${plan.period} plan is sold per ${PERIOD_INTERVAL[plan.period]}, not per ${price.interval}`);
      if (!Number.isInteger(price.unit_amount_cents) || price.unit_amount_cents <= 0) err(`${tag}: unit_amount_cents must be a positive integer (cents)`);
      if (price.tax_behavior != null && !TAX_BEHAVIORS.includes(price.tax_behavior)) err(`${tag}: tax_behavior must be one of ${TAX_BEHAVIORS.join(", ")} or null`);
      const vk = `${price.currency}/${price.interval}/${price.version}`;
      if (versionsSeen.has(vk)) err(`${tag}: version is used twice for ${price.currency}/${price.interval}`);
      versionsSeen.add(vk);
      const lk = priceLookupKey(plan.key, price.interval, price.currency, price.version);
      if (lk.length > 200) err(`${tag}: lookup key is longer than Stripe's 200 characters`);
      if (lookupKeys.has(lk)) err(`${tag}: duplicate lookup key ${lk}`);
      lookupKeys.add(lk);
      if (price.active !== false) {
        const ak = `${price.currency}/${price.interval}`;
        if (activeSeen.has(ak)) err(`${where}: more than one active price for ${ak}; deactivate the old version`);
        activeSeen.add(ak);
        if (floor != null && Number.isInteger(price.unit_amount_cents) && price.unit_amount_cents < floor) {
          err(`${tag}: ${price.unit_amount_cents} is below the entry price floor ${floor}`);
        }
      }
    }
    if (plan.status === "active" && plan.prices.length && !plan.prices.some((p) => p.active !== false)) err(`${where}: active plan with no active price`);
    if (plan.same_limits_as != null && !(catalog.plans || []).some((q) => q.key === plan.same_limits_as)) err(`${where}: same_limits_as ${plan.same_limits_as} is not a plan`);
    if (plan.same_limits_as == null && (plan.limits == null || typeof plan.limits !== "object")) err(`${where}: needs limits or same_limits_as`);
  }
  return errors;
}

/** Limits of a plan, following same_limits_as one hop. */
export function limitsOf(catalog, plan) {
  if (plan.same_limits_as) return limitsOf(catalog, catalog.plans.find((q) => q.key === plan.same_limits_as) || { limits: {} });
  return plan.limits || {};
}

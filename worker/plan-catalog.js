// =====================================================
// PLAN CATALOG MANAGEMENT (staff console)
//
// The rules behind /platform/saas/plans and /api/platform/saas/plan-catalog*. No SQL here (see
// repositories/plan-catalog.js and repositories/plan-price-versions.js). Every function returns { ok, ... } and never
// throws for a business-rule failure; the route layer audits the result.
//
// The model, in one paragraph. A plan has a LIFECYCLE STATUS: draft (being prepared, invisible), active (published:
// visitors see it, customers can buy it) or retired (archived: no new sales; existing subscribers keep it). Its PRICE is
// not a field: it is the active row of plan_prices, an immutable ledger of Stripe prices. "Changing the price" therefore
// means adding a new price version (setPlanPrice); subscribers on the old version keep paying it. Everything else here
// (name, copy, labels, feature lines, entitlements, SEO, promotions, sort, trial) is ordinary editable data.
// =====================================================

import * as repo from "./repositories/plan-catalog.js";
import * as versions from "./repositories/plan-price-versions.js";
import { priceLookupKey, PERIOD_INTERVAL, TAX_BEHAVIORS } from "./catalog.js";
import { stripeModeFromEnv } from "./plan-prices.js";
import { stripeRequest } from "./billing-stripe.js";

export const PLAN_STATUSES = ["draft", "active", "retired"];
export const BILLING_PERIODS = ["monthly", "annual", "custom"];
export const PRODUCT_CATEGORIES = ["news", "affiliate", "business", "license"];
export const LABEL_COLORS = ["neutral", "blue", "green", "amber", "red", "purple", "teal"];
export const BULK_ACTIONS = ["publish", "unpublish", "archive", "restore", "delete", "duplicate", "feature", "unfeature", "add_label", "remove_label", "set_trial_days"];
export const MAX_BULK = 100;

/** What the entitlement editor offers. Keys are the ones the product enforces (entitlements.js); staff may add others. */
export const ENTITLEMENT_CATALOG = [
  { key: "sites.max", label: "Sites", type: "number", group: "Capacity", help: "How many sites the organization can run." },
  { key: "domains.custom.max", label: "Custom domains", type: "number", group: "Capacity", help: "Custom domains across all sites." },
  { key: "users.max", label: "Team members", type: "number", group: "Capacity", help: "Seats in the organization." },
  { key: "storage.max_mb", label: "Storage (MB)", type: "number", group: "Capacity", help: "Media and file storage." },
  { key: "ai.credits_monthly", label: "AI credits / month", type: "number", group: "AI", help: "Credits granted each billing month." },
  { key: "ai.enabled", label: "AI tools", type: "boolean", group: "AI", help: "AI assistant and tools." },
  { key: "analytics.level", label: "Analytics level", type: "text", group: "Insights", options: ["none", "basic", "advanced"], help: "none, basic or advanced." },
  { key: "reports.enabled", label: "Scheduled reports", type: "boolean", group: "Insights" },
  { key: "alerts.enabled", label: "Alerts", type: "boolean", group: "Insights" },
  { key: "affiliate.enabled", label: "Affiliate tools", type: "boolean", group: "Features" },
  { key: "api.enabled", label: "API access", type: "boolean", group: "Features" },
  { key: "automations.enabled", label: "Automations", type: "boolean", group: "Features" },
  { key: "backups.enabled", label: "Backups", type: "boolean", group: "Features" },
  { key: "approval_workflows.enabled", label: "Approval workflows", type: "boolean", group: "Features" },
  { key: "white_label.enabled", label: "White label", type: "boolean", group: "Enterprise" },
  { key: "dedicated_infrastructure.enabled", label: "Dedicated infrastructure", type: "boolean", group: "Enterprise" },
  { key: "security.ip_allowlist.enabled", label: "IP allowlist", type: "boolean", group: "Enterprise" }
];
const KNOWN_TYPE = new Map(ENTITLEMENT_CATALOG.map((e) => [e.key, e.type]));

const fail = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
const optText = (v, max) => { const s = clean(v, max); return s === "" ? null : s; };
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
const KEY_RE = /^[a-z][a-z0-9_]{1,63}$/;
const CURRENCY_RE = /^[A-Za-z]{3}$/;
const STRIPE_PRICE_RE = /^price_[A-Za-z0-9]{8,64}$/;
const sqlTime = (d) => d.toISOString().replace("T", " ").slice(0, 19);

function parseWhen(v, field) {
  if (v === undefined || v === null || String(v).trim() === "") return { ok: true, value: null };
  const raw = String(v).trim();
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : /Z$|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return { ok: false, error: `invalid_${field}` };
  return { ok: true, value: sqlTime(d) };
}

// ---------------------------------------------------------------------------------------------- reading

/** Things staff should know about a plan before/after publishing. Codes only; the console words them. */
export function planWarnings(p, { featureCount = 0, entitlementCount = 0 } = {}) {
  const w = [];
  const priced = p.billing_period !== "custom";
  if (priced && (p.price_cents == null || p.price_cents <= 0)) w.push("not_listed_on_pricing_page");
  if (p.billing_period === "custom") w.push("not_listed_on_pricing_page");
  if (priced && p.price_cents > 0 && !p.active_price_id) w.push("no_active_stripe_price");
  if (p.active_price_id && p.price_amount_cents != null && p.price_cents != null && p.price_cents !== p.price_amount_cents) w.push("price_differs_from_stripe");
  if (p.status === "active" && p.product_status !== "active") w.push("product_not_active");
  if (p.status === "active" && !featureCount && !entitlementCount) w.push("no_features");
  if (p.status === "active" && !p.seo_description) w.push("seo_description_missing");
  return [...new Set(w)];
}

export async function listCatalog(env, filters = {}) {
  const { rows, total } = await repo.listPlans(env, filters);
  const labels = await repo.labelsForPlans(env, rows.map((r) => r.id));
  const out = rows.map((r) => ({ ...r, labels: labels.get(r.id) || [], warnings: planWarnings(r) }));
  return { rows: out, total, counts: await repo.statusCounts(env) };
}

export async function planDetail(env, planId) {
  const plan = await repo.getPlan(env, planId);
  if (!plan) return null;
  const [features, entitlements, labels, promotions, prices] = await Promise.all([
    repo.listFeatures(env, planId), repo.listEntitlements(env, planId), repo.labelsForPlans(env, [planId]),
    repo.listPromotions(env, planId), repo.listPriceVersions(env, planId)
  ]);
  return { plan, features, entitlements, labels: labels.get(planId) || [], promotions, prices, warnings: planWarnings(plan, { featureCount: features.length, entitlementCount: entitlements.length }) };
}

export async function formOptions(env) {
  const [products, labels, coupons] = await Promise.all([repo.listProducts(env), repo.listLabels(env), repo.listCouponChoices(env)]);
  return { products, labels, coupons };
}

// ---------------------------------------------------------------------------------------------- plan create / update

function validateCore(input, { partial }) {
  const out = {};
  const has = (k) => input[k] !== undefined;
  if (!partial || has("name")) {
    const name = clean(input.name, 80);
    if (name.length < 2) return fail(422, "invalid_name");
    out.name = name;
  }
  if (has("billingPeriod")) {
    if (!BILLING_PERIODS.includes(input.billingPeriod)) return fail(422, "invalid_billing_period");
    out.billingPeriod = input.billingPeriod;
  }
  if (has("currency")) {
    if (!CURRENCY_RE.test(String(input.currency))) return fail(422, "invalid_currency");
    out.currency = String(input.currency).toUpperCase();
  }
  if (has("priceCents")) {
    if (input.priceCents === null || input.priceCents === "") out.priceCents = null;
    else {
      const n = Number(input.priceCents);
      if (!Number.isInteger(n) || n < 0 || n > 100_000_000) return fail(422, "invalid_price_cents");
      out.priceCents = n;
    }
  }
  if (has("trialDays")) {
    const n = Number(input.trialDays);
    if (!Number.isInteger(n) || n < 0 || n > 90) return fail(422, "invalid_trial_days");
    out.trialDays = n;
  }
  if (has("sortOrder")) {
    const n = Number(input.sortOrder);
    if (!Number.isInteger(n) || n < -9999 || n > 9999) return fail(422, "invalid_sort_order");
    out.sortOrder = n;
  }
  if (has("isFeatured")) out.isFeatured = input.isFeatured === true || input.isFeatured === 1 || input.isFeatured === "1" || input.isFeatured === "true";
  if (has("tagline")) out.tagline = optText(input.tagline, 120);
  if (has("description")) out.description = optText(input.description, 800);
  if (has("ctaLabel")) out.ctaLabel = optText(input.ctaLabel, 40);
  if (has("seoTitle")) out.seoTitle = optText(input.seoTitle, 70);
  if (has("seoDescription")) out.seoDescription = optText(input.seoDescription, 170);
  return { ok: true, value: out };
}

export async function createPlan(env, input = {}) {
  const core = validateCore(input, { partial: false });
  if (!core.ok) return core;
  const v = core.value;
  const product = await repo.getProduct(env, String(input.productId || ""));
  if (!product) return fail(422, "product_not_found");
  if (product.status !== "active") return fail(422, "product_not_active");

  const key = clean(input.key, 64) || `${product.key}_${slug(v.name)}`;
  if (!KEY_RE.test(key)) return fail(422, "invalid_key");
  if (await repo.getPlanByKey(env, key)) return fail(409, "key_already_exists");

  const billingPeriod = v.billingPeriod || "monthly";
  const status = input.status === undefined ? "draft" : input.status;
  if (!PLAN_STATUSES.includes(status)) return fail(422, "invalid_status");
  let priceCents = v.priceCents === undefined ? (billingPeriod === "custom" ? null : 0) : v.priceCents;
  if (billingPeriod === "custom") priceCents = null;
  else if (priceCents === null) return fail(422, "price_required");

  let id = `plan_${key}`;
  if (await repo.getPlan(env, id)) id = `plan_${key}_${crypto.randomUUID().slice(0, 8)}`;
  await repo.insertPlan(env, {
    id, productId: product.id, key, name: v.name, billingPeriod, priceCents, currency: v.currency || "USD", trialDays: v.trialDays ?? 0, status,
    description: v.description ?? null, tagline: v.tagline ?? null, sortOrder: v.sortOrder ?? 0, isFeatured: v.isFeatured ?? false,
    ctaLabel: v.ctaLabel ?? null, seoTitle: v.seoTitle ?? null, seoDescription: v.seoDescription ?? null
  });
  if (v.isFeatured) await repo.clearFeaturedSiblings(env, id);
  const labelIds = Array.isArray(input.labelIds) ? input.labelIds.map(String) : [];
  if (labelIds.length) { const r = await setLabels(env, id, labelIds); if (!r.ok) return { ...r, planId: id, partial: true }; }
  return { ok: true, planId: id, key };
}

export async function updatePlan(env, planId, input = {}) {
  const before = await repo.getPlan(env, planId);
  if (!before) return fail(404, "not_found");
  if ("key" in input && input.key !== before.key) return fail(422, "key_is_immutable");
  const core = validateCore(input, { partial: true });
  if (!core.ok) return core;
  const v = core.value;

  if (input.productId !== undefined && input.productId !== before.product_id) {
    if (before.price_versions || before.total_subscriptions) return fail(409, "product_locked_after_sales");
    const product = await repo.getProduct(env, String(input.productId));
    if (!product || product.status !== "active") return fail(422, "product_not_found");
    v.productId = product.id;
  }
  if (v.billingPeriod !== undefined && v.billingPeriod !== before.billing_period && (before.price_versions || before.total_subscriptions)) return fail(409, "billing_period_locked_after_sales");
  if (v.currency !== undefined && v.currency !== String(before.currency).toUpperCase() && (before.price_versions || before.total_subscriptions)) return fail(409, "currency_locked_after_sales");

  const period = v.billingPeriod ?? before.billing_period;
  if (period === "custom") v.priceCents = null;
  if (v.priceCents !== undefined && v.priceCents !== before.price_cents) {
    // A plan that has a price ledger changes price through a new version (setPlanPrice), never by editing the list price.
    if (before.price_versions) return fail(422, "price_managed_by_versions");
    if (v.priceCents === null && period !== "custom") return fail(422, "price_required");
  }
  const changed = {};
  for (const [k, val] of Object.entries(v)) {
    const col = { productId: "product_id", billingPeriod: "billing_period", priceCents: "price_cents", trialDays: "trial_days", sortOrder: "sort_order", isFeatured: "is_featured", ctaLabel: "cta_label", seoTitle: "seo_title", seoDescription: "seo_description" }[k] || k;
    const old = before[col];
    const cmp = k === "isFeatured" ? !!old : old;
    if (cmp !== val && !(cmp == null && val == null)) changed[k] = { from: old ?? null, to: val };
  }
  if (!Object.keys(changed).length) return { ok: true, changed: {}, unchanged: true };
  await repo.updatePlanFields(env, planId, Object.fromEntries(Object.keys(changed).map((k) => [k, v[k]])));
  if (changed.isFeatured && v.isFeatured) await repo.clearFeaturedSiblings(env, planId);
  return { ok: true, changed };
}

// ---------------------------------------------------------------------------------------------- lifecycle

async function transition(env, planId, to) {
  const plan = await repo.getPlan(env, planId);
  if (!plan) return fail(404, "not_found");
  if (plan.status === to) return { ok: true, from: plan.status, to, unchanged: true, warnings: planWarnings(plan) };
  if (to === "active") {
    if (plan.product_status !== "active") return fail(409, "product_not_active");
    if (plan.billing_period !== "custom" && plan.price_cents == null) return fail(422, "price_required");
  }
  await repo.setPlanStatus(env, planId, to);
  const features = to === "active" ? await repo.listFeatures(env, planId) : [];
  const ents = to === "active" ? await repo.listEntitlements(env, planId) : [];
  return {
    ok: true, from: plan.status, to, liveSubscriptions: plan.live_subscriptions,
    warnings: to === "active" ? planWarnings({ ...plan, status: "active" }, { featureCount: features.length, entitlementCount: ents.length }) : []
  };
}
export const publishPlan = (env, id) => transition(env, id, "active");
/** Back to draft: hidden from visitors and from new checkouts; existing subscribers are untouched. */
export const unpublishPlan = (env, id) => transition(env, id, "draft");
export const archivePlan = (env, id) => transition(env, id, "retired");
export async function restorePlan(env, id) {
  const plan = await repo.getPlan(env, id);
  if (!plan) return fail(404, "not_found");
  if (plan.status !== "retired") return fail(409, "not_archived");
  return transition(env, id, "draft");
}

export async function deletePlan(env, planId) {
  const plan = await repo.getPlan(env, planId);
  if (!plan) return fail(404, "not_found");
  if (plan.status === "active") return fail(409, "unpublish_before_delete");
  const b = await repo.deleteBlockers(env, planId);
  if (b.subscriptions || b.prices || b.intents || b.checkouts) return fail(409, "plan_in_use", { blockers: b, hint: "archive_instead" });
  await repo.deletePlan(env, planId);
  return { ok: true, key: plan.key, name: plan.name };
}

export async function duplicatePlan(env, planId) {
  const src = await repo.getPlan(env, planId);
  if (!src) return fail(404, "not_found");
  let key = `${src.key}_copy`, n = 1;
  while (await repo.getPlanByKey(env, key)) key = `${src.key}_copy${++n}`;
  if (key.length > 64) return fail(422, "invalid_key");
  const id = `plan_${key}`;
  await repo.insertPlan(env, {
    id, productId: src.product_id, key, name: `${src.name} (copy)`.slice(0, 80), billingPeriod: src.billing_period, priceCents: src.billing_period === "custom" ? null : src.price_cents,
    currency: String(src.currency).toUpperCase(), trialDays: src.trial_days, status: "draft", description: src.description, tagline: src.tagline, sortOrder: src.sort_order + 1,
    isFeatured: false, ctaLabel: src.cta_label, seoTitle: src.seo_title, seoDescription: src.seo_description
  });
  await repo.copyPlanDetails(env, planId, id);
  return { ok: true, planId: id, key };
}

export async function setFeatured(env, planId, featured) {
  const plan = await repo.getPlan(env, planId);
  if (!plan) return fail(404, "not_found");
  await repo.setFeatured(env, planId, featured);
  if (featured) await repo.clearFeaturedSiblings(env, planId);
  return { ok: true, featured: !!featured };
}

export async function setTrialDays(env, planId, days) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 0 || n > 90) return fail(422, "invalid_trial_days");
  const plan = await repo.getPlan(env, planId);
  if (!plan) return fail(404, "not_found");
  await repo.setTrialDays(env, planId, n);
  return { ok: true, from: plan.trial_days, to: n };
}

// ---------------------------------------------------------------------------------------------- detail editors

export async function setFeatureLines(env, planId, lines) {
  if (!(await repo.getPlan(env, planId))) return fail(404, "not_found");
  if (!Array.isArray(lines) || lines.length > 30) return fail(422, "too_many_features");
  const rows = [];
  for (const l of lines) {
    const label = clean(typeof l === "string" ? l : l?.label, 100);
    if (!label) continue;
    rows.push({ label, included: typeof l === "string" ? true : l.included !== false && l.included !== 0, highlight: typeof l === "object" && (l.highlight === true || l.highlight === 1) });
  }
  await repo.replaceFeatures(env, planId, rows);
  return { ok: true, count: rows.length };
}

export async function setEntitlements(env, planId, list) {
  if (!(await repo.getPlan(env, planId))) return fail(404, "not_found");
  if (!Array.isArray(list) || list.length > 80) return fail(422, "too_many_entitlements");
  const seen = new Set(), rows = [];
  for (const e of list) {
    const key = clean(e?.key, 80);
    if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(key)) return fail(422, "invalid_key", { key });
    if (seen.has(key)) return fail(422, "duplicate_key", { key });
    seen.add(key);
    const valueType = String(e.valueType || e.type || "");
    if (!["boolean", "number", "text"].includes(valueType)) return fail(422, "invalid_value_type", { key });
    if (KNOWN_TYPE.has(key) && KNOWN_TYPE.get(key) !== valueType) return fail(422, "entitlement_type_mismatch", { key, expected: KNOWN_TYPE.get(key) });
    let value = e.value;
    if (valueType === "boolean") {
      if (![true, false, "true", "false"].includes(value)) return fail(422, "invalid_boolean", { key });
      value = String(value);
    } else if (valueType === "number") {
      const n = Number(value);
      if (value === "" || value === null || !Number.isInteger(n) || n < 0 || n > 1_000_000_000) return fail(422, "invalid_number", { key });
      value = String(n);
    } else {
      value = clean(value, 200);
      if (!value) return fail(422, "invalid_text", { key });
    }
    rows.push({ key, valueType, value });
  }
  await repo.replaceEntitlements(env, planId, rows);
  return { ok: true, count: rows.length };
}

export async function setLabels(env, planId, labelIds) {
  if (!(await repo.getPlan(env, planId))) return fail(404, "not_found");
  const ids = [...new Set((Array.isArray(labelIds) ? labelIds : []).map(String))];
  if (ids.length > 8) return fail(422, "too_many_labels");
  for (const id of ids) if (!(await repo.getLabel(env, id))) return fail(422, "label_not_found", { labelId: id });
  await repo.setPlanLabels(env, planId, ids);
  return { ok: true, count: ids.length };
}

// ---------------------------------------------------------------------------------------------- labels & products

export async function createLabel(env, { name, color = "neutral", key } = {}) {
  const n = clean(name, 30);
  if (n.length < 2) return fail(422, "invalid_name");
  if (!LABEL_COLORS.includes(color)) return fail(422, "invalid_color");
  const k = slug(key || n);
  if (!/^[a-z][a-z0-9_]{1,47}$/.test(k)) return fail(422, "invalid_key");
  if (await repo.getLabelByKey(env, k)) return fail(409, "label_already_exists");
  const id = `label_${k}`;
  await repo.insertLabel(env, { id, key: k, name: n, color });
  return { ok: true, labelId: id };
}
export async function updateLabel(env, id, { name, color } = {}) {
  if (!(await repo.getLabel(env, id))) return fail(404, "not_found");
  const f = {};
  if (name !== undefined) { f.name = clean(name, 30); if (f.name.length < 2) return fail(422, "invalid_name"); }
  if (color !== undefined) { if (!LABEL_COLORS.includes(color)) return fail(422, "invalid_color"); f.color = color; }
  await repo.updateLabel(env, id, f);
  return { ok: true };
}
export async function deleteLabel(env, id) {
  if (!(await repo.getLabel(env, id))) return fail(404, "not_found");
  await repo.deleteLabel(env, id);
  return { ok: true };
}

export async function createProduct(env, { name, key, category } = {}) {
  const n = clean(name, 80);
  if (n.length < 2) return fail(422, "invalid_name");
  if (!PRODUCT_CATEGORIES.includes(category)) return fail(422, "invalid_category");
  const k = clean(key, 64) || slug(n);
  if (!KEY_RE.test(k)) return fail(422, "invalid_key");
  if (await repo.getProductByKey(env, k)) return fail(409, "key_already_exists");
  const id = `product_${k}`;
  await repo.insertProduct(env, { id, key: k, name: n, category });
  return { ok: true, productId: id };
}
export async function updateProduct(env, id, { name, status } = {}) {
  if (!(await repo.getProduct(env, id))) return fail(404, "not_found");
  const f = {};
  if (name !== undefined) { f.name = clean(name, 80); if (f.name.length < 2) return fail(422, "invalid_name"); }
  if (status !== undefined) { if (!["active", "retired"].includes(status)) return fail(422, "invalid_status"); f.status = status; }
  await repo.updateProduct(env, id, f);
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------- promotions

async function validatePromotion(env, input) {
  const name = clean(input.name, 60), badge = clean(input.badgeText, 40);
  if (name.length < 2) return fail(422, "invalid_name");
  if (badge.length < 2) return fail(422, "invalid_badge_text");
  const starts = parseWhen(input.startsAt, "starts_at"); if (!starts.ok) return fail(422, starts.error);
  const ends = parseWhen(input.endsAt, "ends_at"); if (!ends.ok) return fail(422, ends.error);
  if (starts.value && ends.value && ends.value <= starts.value) return fail(422, "ends_before_start");
  const status = input.status === undefined ? "active" : input.status;
  if (!["active", "paused"].includes(status)) return fail(422, "invalid_status");
  let couponId = null;
  if (input.couponId) {
    const c = await repo.getCoupon(env, String(input.couponId));
    if (!c) return fail(422, "coupon_not_found");
    if (c.organization_id) return fail(422, "coupon_is_organization_scoped");
    couponId = c.id;
  }
  return { ok: true, value: { name, badgeText: badge, startsAt: starts.value, endsAt: ends.value, status, couponId } };
}
export async function createPromotion(env, planId, input = {}) {
  if (!(await repo.getPlan(env, planId))) return fail(404, "not_found");
  const v = await validatePromotion(env, input); if (!v.ok) return v;
  const id = crypto.randomUUID();
  await repo.insertPromotion(env, { id, planId, ...v.value });
  return { ok: true, promotionId: id };
}
export async function updatePromotion(env, promotionId, input = {}) {
  const cur = await repo.getPromotion(env, promotionId);
  if (!cur) return fail(404, "not_found");
  const merged = { name: cur.name, badgeText: cur.badge_text, couponId: cur.coupon_id, startsAt: cur.starts_at, endsAt: cur.ends_at, status: cur.status, ...input };
  const v = await validatePromotion(env, merged); if (!v.ok) return v;
  await repo.updatePromotion(env, promotionId, v.value);
  return { ok: true, planId: cur.plan_id };
}
export async function deletePromotion(env, promotionId) {
  const cur = await repo.getPromotion(env, promotionId);
  if (!cur) return fail(404, "not_found");
  await repo.deletePromotion(env, promotionId);
  return { ok: true, planId: cur.plan_id };
}

// ---------------------------------------------------------------------------------------------- price versions

/**
 * Sells a plan at a new price. The amount is paired with a REAL Stripe price id that staff created in Stripe (Stripe
 * prices are immutable too). When the Worker has a Stripe key it asks Stripe about that id and refuses unless the amount,
 * currency and interval match what staff typed, so the page can never advertise a number that checkout will not charge.
 * Without a key (local development, tests) the row is stored with mode 'unknown', as for carried-over rows.
 */
export async function setPlanPrice(env, planId, input = {}) {
  const plan = await repo.getPlan(env, planId);
  if (!plan) return fail(404, "not_found");
  const interval = PERIOD_INTERVAL[plan.billing_period];
  if (!interval) return fail(422, "plan_not_recurring");
  const amount = Number(input.amountCents);
  if (!Number.isInteger(amount) || amount < 0 || amount > 100_000_000) return fail(422, "invalid_price_cents");
  const stripePriceId = clean(input.stripePriceId, 80);
  if (!STRIPE_PRICE_RE.test(stripePriceId)) return fail(422, "invalid_stripe_price_id");
  const taxBehavior = input.taxBehavior || "unspecified";
  if (!TAX_BEHAVIORS.includes(taxBehavior)) return fail(422, "invalid_tax_behavior");
  const reason = clean(input.reason, 300);
  if (!reason) return fail(422, "reason_required");
  const currency = String(plan.currency).toLowerCase();
  if (await versions.stripePriceIdTaken(env, stripePriceId)) return fail(409, "stripe_price_already_used");

  let mode = "unknown", verified = false;
  if (env.STRIPE_SECRET_KEY) {
    let sp;
    try { sp = await stripeRequest(env, "GET", `/prices/${encodeURIComponent(stripePriceId)}`); }
    catch (e) { return fail(e?.kind === "rejected" ? 422 : 502, e?.kind === "rejected" ? "stripe_price_not_found" : "stripe_unreachable", { detail: String(e?.message || "").slice(0, 200) }); }
    if (sp.active === false) return fail(422, "stripe_price_inactive");
    if (sp.type && sp.type !== "recurring") return fail(422, "stripe_price_not_recurring");
    if (sp.recurring?.interval !== interval || (sp.recurring?.interval_count || 1) !== 1) return fail(422, "stripe_price_interval_mismatch", { stripe: sp.recurring?.interval || null, expected: interval });
    if (String(sp.currency || "").toLowerCase() !== currency) return fail(422, "stripe_price_currency_mismatch", { stripe: sp.currency || null, expected: currency });
    if (sp.unit_amount !== amount) return fail(422, "stripe_price_amount_mismatch", { stripe: sp.unit_amount ?? null, expected: amount });
    mode = sp.livemode ? "live" : "test";
    const keyMode = stripeModeFromEnv(env);
    if (keyMode && keyMode !== mode) return fail(409, "price_mode_mismatch");
    verified = true;
  }
  const version = (await versions.maxVersion(env, planId, currency, interval)) + 1;
  const prior = plan.price_cents;
  await versions.activateNewVersion(env, {
    id: crypto.randomUUID(), planId, currency, interval, unitAmountCents: amount, taxBehavior, stripePriceId,
    lookupKey: priceLookupKey(plan.key, interval, currency, version), stripeMode: mode, version
  });
  return { ok: true, version, mode, verified, from: prior, to: amount, reason };
}

// ---------------------------------------------------------------------------------------------- bulk

/**
 * Runs one action over up to MAX_BULK plans. Each plan succeeds or fails on its own; nothing is rolled back for the
 * others. Returns the per-plan outcome so the console can say exactly what happened.
 */
export async function bulkAction(env, action, ids, params = {}) {
  if (!BULK_ACTIONS.includes(action)) return fail(422, "invalid_action");
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
  if (!list.length) return fail(422, "nothing_selected");
  if (list.length > MAX_BULK) return fail(422, "too_many_selected", { max: MAX_BULK });
  let label = null;
  if (action === "add_label" || action === "remove_label") {
    label = await repo.getLabel(env, String(params.labelId || ""));
    if (!label) return fail(422, "label_not_found");
  }
  if (action === "set_trial_days") {
    const n = Number(params.trialDays);
    if (!Number.isInteger(n) || n < 0 || n > 90) return fail(422, "invalid_trial_days");
  }
  const results = [];
  for (const id of list) {
    let r;
    try {
      switch (action) {
        case "publish": r = await publishPlan(env, id); break;
        case "unpublish": r = await unpublishPlan(env, id); break;
        case "archive": r = await archivePlan(env, id); break;
        case "restore": r = await restorePlan(env, id); break;
        case "delete": r = await deletePlan(env, id); break;
        case "duplicate": r = await duplicatePlan(env, id); break;
        case "feature": r = await setFeatured(env, id, true); break;
        case "unfeature": r = await setFeatured(env, id, false); break;
        case "set_trial_days": r = await setTrialDays(env, id, params.trialDays); break;
        case "add_label": {
          const plan = await repo.getPlan(env, id);
          r = plan ? (await repo.addPlanLabel(env, id, label.id), { ok: true }) : fail(404, "not_found");
          break;
        }
        case "remove_label": {
          const plan = await repo.getPlan(env, id);
          r = plan ? (await repo.removePlanLabel(env, id, label.id), { ok: true }) : fail(404, "not_found");
          break;
        }
      }
    } catch (e) { r = fail(500, "unexpected_error", { detail: String(e?.message || e).slice(0, 160) }); }
    results.push({ id, ok: !!r.ok, error: r.ok ? null : r.error, warnings: r.warnings || [], detail: r });
  }
  const done = results.filter((x) => x.ok).length;
  return { ok: true, action, done, failed: results.length - done, results };
}

// ---------------------------------------------------------------------------------------------- export

const csvCell = (v) => {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;          // spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export async function exportCsv(env) {
  const rows = await repo.listAllForExport(env);
  const labels = await repo.labelsForPlans(env, rows.map((r) => r.id));
  const head = ["id", "key", "name", "product", "category", "billing_period", "price", "currency", "trial_days", "status", "featured", "sort_order", "labels", "live_subscriptions", "stripe_price_id", "price_version", "updated_at"];
  const lines = [head.join(",")];
  for (const r of rows) {
    lines.push([r.id, r.key, r.name, r.product, r.category, r.billing_period, r.price_cents == null ? "" : (r.price_cents / 100).toFixed(2), r.currency, r.trial_days, r.status, r.is_featured ? "yes" : "no", r.sort_order,
      (labels.get(r.id) || []).map((l) => l.name).join("; "), r.live_subscriptions, r.active_price_id || "", r.price_version || "", r.updated_at || r.created_at || ""].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

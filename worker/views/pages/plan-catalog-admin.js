// Staff console: Plans & pricing (/platform/saas/plans).
//
// Server-rendered list (filters, sorting, paging and row selection all work without script), plus the editor drawer,
// bulk actions and publish switch added by plan-catalog-client.js. Super-admin only: the route layer enforces it.
import { renderShell, escapeHtml as h } from "../layout.js";
import { nonceToken } from "../../csp.js";
import * as catalog from "../../plan-catalog.js";
import { PLAN_CATALOG_CLIENT } from "./plan-catalog-client.js";

const money = (c, cur) => {
  if (c == null) return "custom";
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: String(cur || "USD").toUpperCase() }).format(c / 100); } catch (_) { return `$${(c / 100).toFixed(2)}`; }
};
const SORTABLE = { product: "Product", name: "Plan", price: "Price", trial: "Trial", status: "Status", subs: "Live subs", updated: "Updated" };
const PAGE_SIZE_CHOICES = [25, 50, 100];
const STATUS_LABEL = { active: "Published", draft: "Draft", retired: "Retired" };
const WARN_LABEL = {
  no_active_stripe_price: "No Stripe price",
  price_differs_from_stripe: "Price differs from Stripe",
  product_not_active: "Product retired",
  no_features: "No features",
  seo_description_missing: "No SEO description",
  not_listed_on_pricing_page: "Not on pricing page"
};
const WARN_HELP = {
  no_active_stripe_price: "Customers cannot pay for this plan until a Stripe price is attached (Pricing tab).",
  price_differs_from_stripe: "The list price and the active Stripe price disagree. Checkout charges the Stripe price.",
  product_not_active: "The product is retired, so the plan is hidden from the pricing page.",
  no_features: "No feature lines or entitlements: the pricing card will look empty.",
  seo_description_missing: "Add an SEO description on the SEO tab.",
  not_listed_on_pricing_page: "Free, contract and custom-period plans are not listed on the public pricing page."
};
// Warnings that matter for the table; the editor shows all of them.
const TABLE_WARNINGS = new Set(["no_active_stripe_price", "price_differs_from_stripe", "product_not_active"]);

function priceCell(p) {
  if (!p.active_price_id) return `<span class="pc-dim">${h(p.billing_period === "custom" ? "contract" : "— not synced —")}</span>`;
  const mismatch = p.price_cents != null && p.price_amount_cents != null && p.price_cents !== p.price_amount_cents;
  return `<code>${h(p.active_price_id)}</code><br><small>${h(p.price_lookup_key || "")} · v${h(p.price_version)} · <span class="role-badge">${h(p.price_mode)}</span>${mismatch ? ` <span class="role-badge">${h("amount differs: Stripe " + money(p.price_amount_cents, p.currency))}</span>` : ""}</small>`;
}

function query(params, over = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, ...over })) if (v !== "" && v != null && !(k === "page" && Number(v) <= 1)) q.set(k, String(v));
  const s = q.toString();
  return `/platform/saas/plans${s ? "?" + h(s) : ""}`;
}

function row(p) {
  const live = Number(p.live_subscriptions || 0);
  const on = p.status === "active";
  const chips = (p.labels || []).map((l) => `<span class="pc-chip pc-chip-${h(l.color)}">${h(l.name)}</span>`).join("");
  const warns = (p.warnings || []).filter((w) => TABLE_WARNINGS.has(w)).map((w) => `<span class="pc-wchip" title="${h(WARN_HELP[w] || "")}">${h(WARN_LABEL[w] || w)}</span>`).join("");
  const promo = p.open_promotions ? `<span class="pc-chip pc-chip-amber" title="A promotion is attached to this plan">Promo</span>` : "";
  const toggleDisabled = p.status === "retired";
  return `<tr data-plan="${h(p.id)}" data-name="${h(p.name)}" data-live="${live}">
    <td class="pc-c-check"><input type="checkbox" class="pc-row-check" value="${h(p.id)}" aria-label="Select ${h(p.name)}"></td>
    <td><button type="button" class="pc-name" data-pc="edit" data-id="${h(p.id)}">${h(p.name)}</button>${p.is_featured ? ` <span class="pc-star" title="Recommended plan">★</span>` : ""}
      <div class="pc-sub"><code>${h(p.key)}</code></div><div class="pc-chips-row">${chips}${promo}${warns}</div></td>
    <td>${h(p.product)}<div class="pc-sub">${h(p.category)}</div></td>
    <td>${money(p.price_cents, p.currency)}<div class="pc-sub">${h(p.billing_period)}</div></td>
    <td>${h(p.trial_days)}</td>
    <td><div class="pc-statuscell"><button type="button" class="pc-switch" role="switch" aria-checked="${on ? "true" : "false"}" aria-label="${on ? "Unpublish" : "Publish"} ${h(p.name)}" data-pc="toggle" data-id="${h(p.id)}"${toggleDisabled ? " disabled" : ""}><span></span></button>
      <span class="pc-badge pc-badge-${h(p.status)}">${h(STATUS_LABEL[p.status] || p.status)}</span></div></td>
    <td>${priceCell(p)}</td>
    <td>${h(live)}</td>
    <td class="pc-sub">${h((p.updated_at || p.created_at || "").slice(0, 16))}</td>
    <td class="pc-actions"><button type="button" class="btn btn-secondary btn-small" data-pc="edit" data-id="${h(p.id)}">Edit</button>
      <details class="pc-menu"><summary class="btn btn-secondary btn-small" aria-label="More actions for ${h(p.name)}">More</summary><div class="pc-menu-list">
        <button type="button" data-pc="duplicate" data-id="${h(p.id)}">Duplicate</button>
        ${p.status === "retired" ? `<button type="button" data-pc="restore" data-id="${h(p.id)}">Restore as draft</button>` : `<button type="button" data-pc="archive" data-id="${h(p.id)}">Retire</button>`}
        <button type="button" class="pc-danger" data-pc="delete" data-id="${h(p.id)}">Delete…</button>
      </div></details></td></tr>`;
}

const CSS = `
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.pc-dim, .pc-sub { color: var(--text-dim); } .pc-sub { font-size: 12px; margin-top: 2px; } .pc-sub code { font-size: 11px; }
.pc-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin: 0 0 18px; }
.pc-stat { background: var(--panel); border: 1px solid var(--panel-border); border-radius: var(--radius); padding: 12px 14px; text-decoration: none; color: inherit; display: block; }
.pc-stat:hover { border-color: var(--accent); } .pc-stat.is-on { border-color: var(--accent); background: var(--accent-soft); }
.pc-stat b { display: block; font-size: 22px; letter-spacing: -0.02em; } .pc-stat span { font-size: 12px; color: var(--text-dim); text-transform: uppercase; letter-spacing: .05em; }
.pc-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
.pc-toolbar form { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; flex: 1 1 520px; margin: 0; }
.pc-toolbar input, .pc-toolbar select { width: auto; margin: 0; min-width: 120px; } .pc-toolbar input[type=search] { flex: 1 1 200px; min-width: 180px; }
.pc-toolbar-end { display: flex; flex-wrap: wrap; gap: 8px; margin-left: auto; }
.pc-bulk { position: sticky; top: 8px; z-index: 20; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 14px; margin-bottom: 12px; background: var(--panel-2); border: 1px solid var(--accent); border-radius: var(--radius); box-shadow: var(--shadow); }
.pc-bulk[hidden] { display: none; } .pc-bulk strong { margin-right: 6px; }
.pc-tablewrap { background: var(--panel); border: 1px solid var(--panel-border); border-radius: var(--radius); overflow-x: auto; }
.pc-tablewrap table { min-width: 980px; } .pc-tablewrap th a { color: inherit; text-decoration: none; } .pc-tablewrap th a:hover { color: var(--accent); }
.pc-c-check { width: 36px; } .pc-selected td { background: var(--accent-soft); }
.pc-name { background: none; border: 0; padding: 0; font: inherit; font-weight: 700; color: var(--text); cursor: pointer; text-align: left; } .pc-name:hover { color: var(--accent); text-decoration: underline; }
.pc-star { color: var(--warn); } .pc-chips-row { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
.pc-chip, .pc-pick { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; background: color-mix(in srgb, var(--text-dim) 16%, transparent); color: var(--text); }
.pc-chip-blue { background: color-mix(in srgb, #3b82f6 18%, transparent); color: #6aa5ff; } .pc-chip-green { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
.pc-chip-amber { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); } .pc-chip-red { background: color-mix(in srgb, var(--danger) 16%, transparent); color: var(--danger-text); }
.pc-chip-purple { background: var(--accent-soft); color: var(--accent); } .pc-chip-teal { background: color-mix(in srgb, #14b8a6 18%, transparent); color: #2dd4bf; }
:root[data-theme="light"] .pc-chip-blue { color: #1d4ed8; } :root[data-theme="light"] .pc-chip-teal { color: #0f766e; }
.pc-wchip { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; background: color-mix(in srgb, var(--warn) 14%, transparent); color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); cursor: help; }
.pc-badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 700; }
.pc-badge-active { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); } .pc-badge-draft { background: color-mix(in srgb, var(--warn) 16%, transparent); color: var(--warn); } .pc-badge-retired { background: color-mix(in srgb, var(--text-dim) 18%, transparent); color: var(--text-dim); }
.pc-statuscell { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.pc-switch { position: relative; width: 38px; height: 22px; border-radius: 999px; border: 1px solid var(--panel-border); background: var(--panel-2); cursor: pointer; padding: 0; flex: none; transition: background .15s; }
.pc-switch span { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--text-dim); transition: transform .15s, background .15s; }
.pc-switch[aria-checked="true"] { background: var(--accent); border-color: var(--accent); } .pc-switch[aria-checked="true"] span { transform: translateX(16px); background: #fff; }
.pc-switch:disabled { opacity: .45; cursor: not-allowed; } .pc-switch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.pc-actions { white-space: nowrap; text-align: right; } .pc-actions > * { vertical-align: middle; }
.pc-menu { display: inline-block; position: relative; } .pc-menu summary { list-style: none; } .pc-menu summary::-webkit-details-marker { display: none; }
.pc-menu-list { position: absolute; right: 0; top: calc(100% + 4px); min-width: 170px; background: var(--panel); border: 1px solid var(--panel-border); border-radius: var(--radius-sm); box-shadow: var(--shadow); z-index: 30; padding: 4px; text-align: left; }
.pc-menu-list button { display: block; width: 100%; text-align: left; background: none; border: 0; color: var(--text); font: inherit; font-size: 13px; padding: 8px 10px; border-radius: 6px; cursor: pointer; }
.pc-menu-list button:hover { background: var(--accent-soft); } .pc-menu-list .pc-danger { color: var(--danger-text); }
.pc-pager { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; margin-top: 12px; color: var(--text-dim); font-size: 13px; }
.pc-pager nav { display: flex; gap: 8px; align-items: center; }
.pc-note { margin: 0 0 14px; color: var(--text-dim); font-size: 13px; max-width: 920px; }
.pc-empty { padding: 36px 16px; text-align: center; color: var(--text-dim); }
/* editor drawer + modals */
body.pc-lock { overflow: hidden; }
.pc-overlay { position: fixed; inset: 0; z-index: 100; background: var(--overlay); display: flex; align-items: center; justify-content: center; padding: 16px; }
.pc-overlay-drawer { justify-content: flex-end; padding: 0; align-items: stretch; }
.pc-drawer { width: min(760px, 100%); background: var(--bg); border-left: 1px solid var(--panel-border); display: flex; flex-direction: column; box-shadow: var(--shadow); }
.pc-drawer-head { display: flex; gap: 12px; align-items: flex-start; padding: 16px 20px 10px; } .pc-drawer-head > div { flex: 1; min-width: 0; } .pc-drawer-head h2 { margin: 0 0 2px; font-size: 18px; word-break: break-word; }
.pc-x { background: none; border: 0; font-size: 26px; line-height: 1; color: var(--text-dim); cursor: pointer; padding: 0 4px; } .pc-x:hover { color: var(--text); }
.pc-tabs { display: flex; gap: 2px; padding: 0 14px; border-bottom: 1px solid var(--panel-border); overflow-x: auto; }
.pc-tab { background: none; border: 0; border-bottom: 2px solid transparent; color: var(--text-dim); font: inherit; font-size: 14px; font-weight: 600; padding: 10px 12px; cursor: pointer; white-space: nowrap; } .pc-tab:disabled { opacity: .4; cursor: not-allowed; }
.pc-tab-on { color: var(--text); border-bottom-color: var(--accent); }
.pc-warns { padding: 0 20px; } .pc-warn { margin-top: 10px; padding: 8px 12px; font-size: 13px; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--warn) 12%, transparent); border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); color: var(--warn); }
.pc-drawer-body { flex: 1; overflow-y: auto; padding: 16px 20px 8px; } .pc-drawer-body h3 { font-size: 14px; margin: 20px 0 8px; }
.pc-drawer-foot { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 12px 20px; border-top: 1px solid var(--panel-border); background: var(--surface); } .pc-push { margin-left: auto; }
.pc-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; } @media (max-width: 640px) { .pc-grid2 { grid-template-columns: 1fr; } }
.pc-field { margin-bottom: 4px; } .pc-field input, .pc-field select, .pc-field textarea { margin-bottom: 4px; } .pc-hint { font-size: 12px; color: var(--text-dim); margin-bottom: 12px; min-height: 8px; }
.pc-check { display: flex; align-items: center; gap: 6px; font-size: 14px; color: var(--text); margin-bottom: 0; cursor: pointer; } .pc-check input { margin: 0; }
.pc-savebar { position: sticky; bottom: 0; padding: 12px 0 8px; background: linear-gradient(transparent, var(--bg) 30%); margin-top: 8px; }
.pc-kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 8px; } .pc-kv > div { background: var(--panel); border: 1px solid var(--panel-border); border-radius: var(--radius-sm); padding: 10px 12px; } .pc-kv span, .pc-kv strong { display: block; } .pc-kv strong { word-break: break-all; margin-top: 2px; }
.pc-mini { font-size: 13px; } .pc-mini th, .pc-mini td { padding: 6px 8px; }
.pc-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; } .pc-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; } .pc-row input:not([type=checkbox]), .pc-row select { flex: 1 1 140px; width: auto; margin: 0; } .pc-addrow { margin-top: 8px; }
.pc-ent { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 10px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--panel-border); } .pc-ent select, .pc-ent input[type=number], .pc-ent input:not([type]) { margin: 0; } .pc-ent .pc-check span { display: flex; flex-direction: column; }
.pc-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; } .pc-pick { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; font-size: 13px; cursor: pointer; margin: 0; } .pc-pick input { margin: 0; }
.pc-count { display: block; font-size: 12px; color: var(--text-dim); margin: -4px 0 12px; } .pc-over { color: var(--danger-text); }
.pc-serp { background: #fff; color: #202124; border-radius: var(--radius-sm); padding: 12px 14px; max-width: 600px; font-family: Arial, sans-serif; } .pc-serp-url { font-size: 12px; color: #4d5156; } .pc-serp-title { font-size: 19px; color: #1a0dab; margin: 2px 0; } .pc-serp-desc { font-size: 13px; color: #4d5156; line-height: 1.45; }
.pc-modal { width: min(460px, 100%); max-height: 92vh; display: flex; flex-direction: column; background: var(--panel); border: 1px solid var(--panel-border); border-radius: var(--radius); box-shadow: var(--shadow); } .pc-modal-wide { width: min(720px, 100%); }
.pc-modal-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px 0; } .pc-modal-head h2 { margin: 0; font-size: 16px; } .pc-modal-body { padding: 12px 18px; overflow-y: auto; } .pc-modal-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px 16px; } .pc-p { margin: 0 0 8px; }
.pc-toasts { position: fixed; right: 16px; top: 76px; z-index: 200; display: flex; flex-direction: column; gap: 8px; max-width: min(440px, calc(100vw - 32px)); }
.pc-toast { padding: 10px 14px; border-radius: var(--radius-sm); font-size: 14px; box-shadow: var(--shadow); background: var(--panel); border: 1px solid var(--panel-border); } .pc-toast-ok { border-color: var(--ok); } .pc-toast-warn { border-color: var(--warn); } .pc-toast-err { border-color: var(--danger); color: var(--danger-text); }
@media (max-width: 760px) { .pc-actions { white-space: normal; } .pc-drawer { width: 100%; } }
`;

export async function renderPlanCatalogPage(env, admin, params = {}) {
  const sort = Object.hasOwn(SORTABLE, params.sort) ? params.sort : "product";
  const dir = params.dir === "desc" ? "desc" : "asc";
  const pageSize = PAGE_SIZE_CHOICES.includes(Number(params.pageSize)) ? Number(params.pageSize) : 50;
  const page = Math.min(Math.max(parseInt(params.page, 10) || 1, 1), 10000);
  const f = {
    q: String(params.q || "").slice(0, 80), status: ["draft", "active", "retired"].includes(params.status) ? params.status : "",
    product: String(params.product || "").slice(0, 80), period: ["monthly", "annual", "custom"].includes(params.period) ? params.period : "", label: String(params.label || "").slice(0, 80)
  };
  const [{ rows, total, counts }, opt] = await Promise.all([
    catalog.listCatalog(env, { q: f.q, status: f.status, productId: f.product, labelId: f.label, period: f.period, sort, dir, limit: pageSize, offset: (page - 1) * pageSize }),
    catalog.formOptions(env)
  ]);
  const base = { ...f, sort: sort === "product" ? "" : sort, dir: dir === "desc" ? "desc" : "", pageSize: pageSize === 50 ? "" : pageSize };
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const th = (key) => {
    const on = sort === key;
    const nextDir = on && dir === "asc" ? "desc" : "asc";
    return `<th${on ? ` aria-sort="${dir === "asc" ? "ascending" : "descending"}"` : ""}><a href="${query(base, { sort: key === "product" ? "" : key, dir: nextDir === "desc" ? "desc" : "", page: "" })}">${h(SORTABLE[key])}${on ? (dir === "asc" ? " ▲" : " ▼") : ""}</a></th>`;
  };
  const stat = (label, n, status) => `<a class="pc-stat${f.status === status ? " is-on" : ""}" href="${query(base, { status, page: "" })}"><b>${h(n)}</b><span>${h(label)}</span></a>`;
  const filtersActive = !!(f.q || f.status || f.product || f.period || f.label);
  const body = `
    <p class="pc-note">Manage every plan visitors can see and customers can buy. <strong>Published</strong> plans appear on the pricing page; <strong>draft</strong> plans are invisible; <strong>retired</strong> plans stop selling but current subscribers keep them.
      Amounts live in an immutable price history: you add a <em>new price version</em> (a Stripe price id plus its amount) and subscribers on the old one keep paying it. Prices defined in <code>catalog/plans.v1.json</code> and synced with <code>scripts/stripe-sync.mjs</code> show up here too.</p>
    <div class="pc-stats">${stat("All plans", counts.total, "")}${stat("Published", counts.active, "active")}${stat("Drafts", counts.draft, "draft")}${stat("Retired", counts.retired, "retired")}</div>
    <div class="pc-toolbar">
      <form method="get" action="/platform/saas/plans" role="search">
        <input type="search" id="pc-q" name="q" value="${h(f.q)}" placeholder="Search plans, keys, products  ( / )" aria-label="Search plans">
        <select name="status" aria-label="Status"><option value="">Any status</option>${[["active", "Published"], ["draft", "Draft"], ["retired", "Retired"]].map(([v, l]) => `<option value="${v}"${f.status === v ? " selected" : ""}>${l}</option>`).join("")}</select>
        <select name="product" aria-label="Product"><option value="">Any product</option>${opt.products.map((p) => `<option value="${h(p.id)}"${f.product === p.id ? " selected" : ""}>${h(p.name)}</option>`).join("")}</select>
        <select name="period" aria-label="Billing period"><option value="">Any period</option>${["monthly", "annual", "custom"].map((v) => `<option${f.period === v ? " selected" : ""}>${v}</option>`).join("")}</select>
        <select name="label" aria-label="Label"><option value="">Any label</option>${opt.labels.map((l) => `<option value="${h(l.id)}"${f.label === l.id ? " selected" : ""}>${h(l.name)}</option>`).join("")}</select>
        <input type="hidden" name="sort" value="${h(sort === "product" ? "" : sort)}"><input type="hidden" name="dir" value="${dir === "desc" ? "desc" : ""}">
        <select name="pageSize" aria-label="Rows per page">${PAGE_SIZE_CHOICES.map((n) => `<option value="${n}"${n === pageSize ? " selected" : ""}>${n} / page</option>`).join("")}</select>
        <button class="btn btn-secondary" type="submit">Apply</button>${filtersActive ? ` <a class="btn btn-secondary" href="/platform/saas/plans">Clear</a>` : ""}
      </form>
      <div class="pc-toolbar-end">
        <button type="button" class="btn btn-secondary" data-pc="labels">Labels</button>
        <button type="button" class="btn btn-secondary" data-pc="product">New product</button>
        <a class="btn btn-secondary" href="/api/platform/saas/plan-catalog/export.csv">Export CSV</a>
        <button type="button" class="btn" data-pc="new">New plan</button>
      </div>
    </div>
    <div class="pc-bulk" id="pc-bulk" hidden role="toolbar" aria-label="Bulk actions for selected plans">
      <strong id="pc-bulk-count">0 selected</strong>
      <button type="button" class="btn btn-small" data-bulk="publish">Publish</button>
      <button type="button" class="btn btn-secondary btn-small" data-bulk="unpublish">Unpublish</button>
      <button type="button" class="btn btn-secondary btn-small" data-bulk="archive">Retire</button>
      <button type="button" class="btn btn-secondary btn-small" data-bulk="restore">Restore</button>
      <button type="button" class="btn btn-secondary btn-small" data-bulk="duplicate">Duplicate</button>
      <button type="button" class="btn btn-secondary btn-small" data-bulk="feature">Feature</button>
      <button type="button" class="btn btn-secondary btn-small" data-bulk="unfeature">Unfeature</button>
      <button type="button" class="btn btn-secondary btn-small" data-bulk="add_label">Add label…</button>
      <button type="button" class="btn btn-secondary btn-small" data-bulk="remove_label">Remove label…</button>
      <button type="button" class="btn btn-secondary btn-small" data-bulk="set_trial_days">Set trial…</button>
      <button type="button" class="btn btn-danger btn-small" data-bulk="delete">Delete…</button>
      <button type="button" class="btn btn-secondary btn-small" id="pc-bulk-clear">Clear selection</button>
    </div>
    <div class="pc-tablewrap">${rows.length ? `<table id="pc-table"><thead><tr>
      <th class="pc-c-check"><input type="checkbox" id="pc-select-all" aria-label="Select all plans on this page"></th>
      ${th("name")}${th("product")}${th("price")}${th("trial")}${th("status")}<th>Stripe price (active)</th>${th("subs")}${th("updated")}<th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${rows.map(row).join("")}</tbody></table>` : `<div class="pc-empty">${filtersActive ? "No plans match these filters." : "No plans yet."} <button type="button" class="btn" data-pc="new">Create a plan</button></div>`}</div>
    <div class="pc-pager"><span>${total === 0 ? "0 plans" : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total} plan${total === 1 ? "" : "s"}`}</span>
      <nav aria-label="Pages">${page > 1 ? `<a class="btn btn-secondary btn-small" href="${query(base, { page: page - 1 })}">&larr; Previous</a>` : ""}<span>Page ${page} of ${pages}</span>${page < pages ? `<a class="btn btn-secondary btn-small" href="${query(base, { page: page + 1 })}">Next &rarr;</a>` : ""}</nav></div>
    <div id="pc-root" hidden></div>`;
  return renderShell({
    title: "Plans & pricing", activeKey: "saas-plans", admin, env,
    bodyHtml: `<h1>Plans &amp; pricing</h1><style>${CSS}</style>${body}<script nonce="${nonceToken()}">${PLAN_CATALOG_CLIENT}</script>`
  });
}

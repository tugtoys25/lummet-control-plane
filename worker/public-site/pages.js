// =====================================================
// PUBLIC SITE — ROUTE HANDLERS
// One function per public page. Each loads published rows, builds the
// view model, the <head> (from the record's own seo_* fields) and the
// JSON-LD, then renders through renderPage().
// =====================================================

import * as pricingRepo from "../repositories/pricing.js";
import { cardRequiredTrial, withEffectiveTrial } from "../billing-config.js";
import * as data from "./data.js";
import { brandModel, updateModel, publicationModel, partnerModel, authorModel, typeLabel } from "./models.js";
import { PAGE_ALIASES } from "./links.js";
import { sanitizeHtml } from "./sanitize.js";
import { renderPage, textResponse } from "./render.js";
import { API_V1_SCOPES, WEBHOOK_EVENT_TYPES, buildOpenApiSpec } from "./openapi.js";
import { buildHead, breadcrumbLd, organizationLd, websiteLd, absoluteUrl } from "./seo.js";
import { buildHome } from "./home.js";
import { stripTags, truncate, safeUrl, readingMinutes } from "./format.js";

const UPDATES_PER_PAGE = 10;
const INSIGHTS_PER_PAGE = 9;

export { PAGE_ALIASES };

export function pageCanonicalPath(slug) {
  return PAGE_ALIASES.has(slug) ? `/${slug}` : `/p/${slug}`;
}

function pageNumber(url) {
  const n = parseInt(url.searchParams.get("page") || "1", 10);
  return Number.isFinite(n) && n > 0 && n < 10000 ? n : 1;
}

function pager(basePath, page, total, perPage, extraQuery = {}) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const href = (p) => {
    const q = new URLSearchParams(extraQuery);
    if (p > 1) q.set("page", String(p));
    const s = q.toString();
    return s ? `${basePath}?${s}` : basePath;
  };
  const numbers = [];
  for (let p = 1; p <= pages; p++) numbers.push({ number: p, href: href(p), current: p === page });
  return {
    show: pages > 1,
    current: page,
    total_pages: pages,
    prev_href: page > 1 ? href(page - 1) : "",
    next_href: page < pages ? href(page + 1) : "",
    numbers
  };
}

const crumb = (label, href) => ({ label, href });

function crumbs(list) {
  return list.map((c, i) => ({ ...c, last: i === list.length - 1 }));
}

const heading_for = (ui, key) => ui[`title_${key}`] || "";

const intro = (settings, key, fallbackTitle) => ({
  title: (settings[`${key}_title`] || "").trim() || fallbackTitle,
  intro: (settings[`${key}_intro`] || "").trim()
});

// ---------------------------------------------------------------- home

export async function homePage(ctx) {
  const { site, ui } = ctx.siteCtx;
  const home = await buildHome(ctx);
  const ld = [organizationLd(site), websiteLd(site)];
  if (home.faqItems.length) {
    ld.push({
      "@type": "FAQPage",
      mainEntity: home.faqItems.map((f) => ({
        "@type": "Question",
        name: f.question,
        acceptedAnswer: { "@type": "Answer", text: f.answer_text }
      }))
    });
  }
  const head = buildHead({
    site,
    rawTitle: site.title,
    description: site.description,
    path: "/",
    jsonLd: ld
  });
  return renderPage(ctx, { template: "home", data: home, head, bodyClass: "page-home" });
}

// -------------------------------------------------------------- brands

export async function brandsPage(ctx) {
  const { site, settings, ui } = ctx.siteCtx;
  const rows = await data.listBrands(ctx.env, 200);
  const brands = rows.map(brandModel);
  const counts = new Map();
  for (const b of brands) if (b.category) counts.set(b.category, (counts.get(b.category) || 0) + 1);
  const categories = [...counts.entries()].map(([name, n]) => ({ name, count: n }));
  const heading = intro(settings, "brands", ui.title_brands || "");
  const head = buildHead({
    site,
    title: heading.title,
    description: heading.intro,
    path: "/brands",
    noindex: brands.length === 0,
    jsonLd: [
      { "@type": "CollectionPage", name: heading.title, url: absoluteUrl(site, "/brands") },
      breadcrumbLd(site, [crumb(ui.crumb_home, "/"), crumb(heading_for(ui, "brands"), "/brands")]),
      ...(brands.length
        ? [{
            "@type": "ItemList",
            itemListElement: brands.map((b, i) => ({ "@type": "ListItem", position: i + 1, url: absoluteUrl(site, b.url), name: b.name }))
          }]
        : [])
    ]
  });
  return renderPage(ctx, {
    template: "brands",
    data: { ...heading, brands, categories, has_categories: categories.some((c) => c.count > 1), crumbs: crumbs([crumb(ui.crumb_home, "/"), crumb(heading.title, "/brands")]) },
    head,
    bodyClass: "page-brands"
  });
}

export async function brandPage(ctx, { slug }) {
  const row = await data.getBrand(ctx.env, slug);
  if (!row) return null;
  const { site, ui } = ctx.siteCtx;
  const brand = brandModel(row);
  const others = (await data.listBrands(ctx.env, 12)).filter((b) => b.slug !== slug).map(brandModel);
  const related = others.filter((b) => b.category && b.category === brand.category).concat(others.filter((b) => b.category !== brand.category)).slice(0, 3);
  const description = row.seo_description || brand.summary || `${brand.name} is part of the ${site.name} platform.`;
  const trail = [crumb(ui.crumb_home, "/"), crumb(heading_for(ui, "brands"), "/brands"), crumb(brand.name, brand.url)];
  const org = { "@type": "Organization", name: brand.name, url: brand.website_url || absoluteUrl(site, brand.url), description };
  if (brand.logo_url) org.logo = absoluteUrl(site, brand.logo_url);
  const head = buildHead({
    site,
    title: row.seo_title || (brand.category ? `${brand.name} — ${brand.category}` : brand.name),
    description,
    path: brand.url,
    image: safeUrl(row.og_image) || brand.logo_url,
    jsonLd: [org, breadcrumbLd(site, trail)]
  });
  return renderPage(ctx, {
    template: "brand",
    data: { brand, related, has_related: related.length > 0, crumbs: crumbs(trail) },
    head,
    bodyClass: "page-brand"
  });
}

// ------------------------------------------------------------- updates

export async function updatesPage(ctx) {
  const { site, settings, ui } = ctx.siteCtx;
  const page = pageNumber(ctx.url);
  const total = await data.countUpdates(ctx.env);
  const rows = await data.listUpdates(ctx.env, { limit: UPDATES_PER_PAGE, offset: (page - 1) * UPDATES_PER_PAGE });
  if (page > 1 && !rows.length) return null;
  const heading = intro(settings, "updates", ui.title_updates || "");
  const p = pager("/updates", page, total, UPDATES_PER_PAGE);
  const head = buildHead({
    site,
    title: page > 1 ? `${heading.title} — ${ui.page_word} ${page}` : heading.title,
    description: heading.intro,
    path: page > 1 ? `/updates?page=${page}` : "/updates",
    noindex: total === 0,
    prev: p.prev_href || undefined,
    next: p.next_href || undefined,
    jsonLd: [{ "@type": "CollectionPage", name: heading.title, url: absoluteUrl(site, "/updates") }, breadcrumbLd(site, [crumb(ui.crumb_home, "/"), crumb(heading_for(ui, "updates"), "/updates")])]
  });
  return renderPage(ctx, { template: "updates", data: { ...heading, updates: rows.map(updateModel), pager: p, crumbs: crumbs([crumb(ui.crumb_home, "/"), crumb(heading.title, "/updates")]) }, head, bodyClass: "page-updates" });
}

function articleJsonLd(site, item, kind, trail) {
  const ld = {
    "@type": "Article",
    headline: item.title,
    description: item.excerpt,
    mainEntityOfPage: absoluteUrl(site, item.url),
    publisher: { "@id": `${site.base_url}/#organization` }
  };
  if (item.date_iso) ld.datePublished = item.date_iso;
  if (item.modified_iso) ld.dateModified = item.modified_iso;
  if (item.author_name) ld.author = { "@type": "Person", name: item.author_name, url: item.author_url ? absoluteUrl(site, item.author_url) : undefined };
  if (item.featured_image) ld.image = absoluteUrl(site, item.featured_image);
  return [organizationLd(site), ld, breadcrumbLd(site, trail)];
}

export async function updatePage(ctx, { slug }) {
  const row = await data.getUpdate(ctx.env, slug);
  if (!row) return null;
  const { site, ui } = ctx.siteCtx;
  const update = updateModel(row);
  const more = (await data.listUpdates(ctx.env, { limit: 3, excludeSlug: slug })).map(updateModel);
  const trail = [crumb(ui.crumb_home, "/"), crumb(heading_for(ui, "updates"), "/updates"), crumb(update.title, update.url)];
  const head = buildHead({
    site,
    title: row.seo_title || update.title,
    description: row.seo_description || update.excerpt,
    path: update.url,
    image: safeUrl(row.og_image) || update.featured_image,
    type: "article",
    article: { published: update.date_iso, modified: update.modified_iso, author: update.author_name },
    jsonLd: articleJsonLd(site, update, "update", trail)
  });
  return renderPage(ctx, { template: "update", data: { update, more, has_more: more.length > 0, crumbs: crumbs(trail) }, head, bodyClass: "page-article" });
}

// ------------------------------------------------------------ insights

export async function insightsPage(ctx) {
  const { site, settings, ui } = ctx.siteCtx;
  const page = pageNumber(ctx.url);
  const typeParam = ctx.url.searchParams.get("type");
  const types = await data.listPublicationTypes(ctx.env);
  const activeType = types.some((t) => t.type === typeParam) ? typeParam : null;
  const total = await data.countPublications(ctx.env, activeType);
  const rows = await data.listPublications(ctx.env, { type: activeType, limit: INSIGHTS_PER_PAGE, offset: (page - 1) * INSIGHTS_PER_PAGE });
  if (page > 1 && !rows.length) return null;
  const heading = intro(settings, "insights", ui.title_insights || "");
  const extra = activeType ? { type: activeType } : {};
  const p = pager("/insights", page, total, INSIGHTS_PER_PAGE, extra);
  const filters = types.length > 1
    ? [{ label: ui.filter_all || "", href: "/insights", current: !activeType }, ...types.map((t) => ({ label: `${typeLabel(ui, t.type)} (${t.n})`, href: `/insights?type=${encodeURIComponent(t.type)}`, current: t.type === activeType }))]
    : [];
  const qs = new URLSearchParams(extra);
  if (page > 1) qs.set("page", String(page));
  const head = buildHead({
    site,
    title: page > 1 ? `${heading.title} — ${ui.page_word} ${page}` : heading.title,
    description: heading.intro,
    path: qs.toString() ? `/insights?${qs}` : "/insights",
    noindex: total === 0 || Boolean(activeType),
    prev: p.prev_href || undefined,
    next: p.next_href || undefined,
    jsonLd: [{ "@type": "CollectionPage", name: heading.title, url: absoluteUrl(site, "/insights") }, breadcrumbLd(site, [crumb(ui.crumb_home, "/"), crumb(heading_for(ui, "insights"), "/insights")])]
  });
  return renderPage(ctx, {
    template: "insights",
    data: { ...heading, insights: rows.map((r) => publicationModel(r, ui)), pager: p, filters, has_filters: filters.length > 0, crumbs: crumbs([crumb(ui.crumb_home, "/"), crumb(heading.title, "/insights")]) },
    head,
    bodyClass: "page-insights"
  });
}

export async function insightPage(ctx, { slug }) {
  const row = await data.getPublication(ctx.env, slug);
  if (!row) return null;
  const { site, ui } = ctx.siteCtx;
  const insight = publicationModel(row, ui);
  const more = (await data.listPublications(ctx.env, { limit: 3, excludeSlug: slug })).map((r) => publicationModel(r, ui));
  const trail = [crumb(ui.crumb_home, "/"), crumb(heading_for(ui, "insights"), "/insights"), crumb(insight.title, insight.url)];
  const head = buildHead({
    site,
    title: row.seo_title || insight.title,
    description: row.seo_description || insight.excerpt,
    path: insight.url,
    image: safeUrl(row.og_image) || insight.featured_image,
    type: "article",
    article: { published: insight.date_iso, modified: insight.modified_iso, author: insight.author_name },
    jsonLd: articleJsonLd(site, insight, "insight", trail)
  });
  return renderPage(ctx, { template: "insight", data: { insight, more, has_more: more.length > 0, crumbs: crumbs(trail) }, head, bodyClass: "page-article" });
}

// ------------------------------------------------------------- partners

export async function partnersPage(ctx) {
  const { site, settings, ui } = ctx.siteCtx;
  const partners = (await data.listPartners(ctx.env, 200)).map(partnerModel);
  const heading = intro(settings, "partners", ui.title_partners || "");
  const head = buildHead({
    site,
    title: heading.title,
    description: heading.intro,
    path: "/partners",
    noindex: partners.length === 0,
    jsonLd: [{ "@type": "CollectionPage", name: heading.title, url: absoluteUrl(site, "/partners") }, breadcrumbLd(site, [crumb(ui.crumb_home, "/"), crumb(heading_for(ui, "partners"), "/partners")])]
  });
  return renderPage(ctx, { template: "partners", data: { ...heading, partners, crumbs: crumbs([crumb(ui.crumb_home, "/"), crumb(heading.title, "/partners")]) }, head, bodyClass: "page-partners" });
}

// -------------------------------------------------------------- authors

export async function authorPage(ctx, { slug }) {
  const row = await data.getAuthor(ctx.env, slug);
  if (!row) return null;
  const { site, ui } = ctx.siteCtx;
  const author = authorModel(row);
  const work = await data.listAuthorWork(ctx.env, row.id);
  const updates = work.updates.map(updateModel);
  const insights = work.publications.map((r) => publicationModel(r, ui));
  const trail = [crumb(ui.crumb_home, "/"), crumb(author.name, author.url)];
  const description = author.bio || `${author.name}${author.title ? `, ${author.title}` : ""} at ${site.name}.`;
  const head = buildHead({
    site,
    title: author.name,
    description,
    path: author.url,
    noindex: updates.length + insights.length === 0,
    type: "profile",
    jsonLd: [organizationLd(site), { "@type": "Person", name: author.name, url: absoluteUrl(site, author.url), jobTitle: author.title || undefined, description: author.bio || undefined }, breadcrumbLd(site, trail)]
  });
  return renderPage(ctx, {
    template: "author",
    data: { author, updates, insights, has_updates: updates.length > 0, has_insights: insights.length > 0, crumbs: crumbs(trail) },
    head,
    bodyClass: "page-author"
  });
}

// ---------------------------------------------------- CMS pages (/p/:slug)

export async function cmsPage(ctx, { slug }) {
  const row = await data.getPage(ctx.env, slug);
  if (!row) return null;
  const { site, ui } = ctx.siteCtx;
  const path = pageCanonicalPath(slug);
  const contentHtml = sanitizeHtml(row.content || "");
  const trail = [crumb(ui.crumb_home, "/"), crumb(row.title, path)];
  const description = row.seo_description || row.excerpt || truncate(stripTags(contentHtml), 170);
  const page = {
    title: row.title,
    excerpt: row.excerpt || "",
    content_html: contentHtml,
    updated_iso: (row.updated_at || "").slice(0, 10),
    reading_minutes: readingMinutes(contentHtml),
    author_name: row.author_name || "",
    author_url: row.author_slug ? `/authors/${row.author_slug}` : ""
  };
  const head = buildHead({
    site,
    title: row.seo_title || row.title,
    description,
    path,
    image: safeUrl(row.og_image),
    jsonLd: [organizationLd(site), { "@type": "WebPage", name: row.title, url: absoluteUrl(site, path), description }, breadcrumbLd(site, trail)]
  });
  return renderPage(ctx, { template: "page", data: { page, crumbs: crumbs(trail) }, head, bodyClass: "page-content" });
}

// ------------------------------------------------------------------ 404

export async function notFoundPage(ctx) {
  const { site, ui } = ctx.siteCtx;
  const head = buildHead({ site, title: ui.not_found_title || "", description: "", path: ctx.url.pathname, noindex: true });
  return renderPage(ctx, { template: "404", data: {}, head, status: 404, bodyClass: "page-404" });
}


// -------------------------------------------------------------- pricing (v7G)

export const MONEY = (cents, currency) => {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD", minimumFractionDigits: Number.isInteger(amount) ? 0 : 2 }).format(amount);
  } catch (_) { return `${amount} ${currency || ""}`.trim(); }
};
const count = (v, one, many) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? `${n} ${n === 1 ? one : many}` : null; };

/** The feature lines for a plan, from its entitlements. Only things a visitor can act on. */
export function pricingFeatures(ent) {
  const out = [
    count(ent["sites.max"], "site", "sites"),
    count(ent["domains.custom.max"], "custom domain", "custom domains"),
    count(ent["users.max"], "team member", "team members"),
    count(ent["ai.credits_monthly"], "AI credit a month", "AI credits a month"),
    ent["analytics.level"] && ent["analytics.level"] !== "none" ? `${ent["analytics.level"][0].toUpperCase()}${ent["analytics.level"].slice(1)} analytics` : null,
    ent["reports.enabled"] === "true" ? "Scheduled reports" : null,
    ent["alerts.enabled"] === "true" ? "Alerts" : null,
    ent["affiliate.enabled"] === "true" ? "Affiliate tools" : null,
    ent["api.enabled"] === "true" ? "API access" : null
  ];
  return out.filter(Boolean);
}

/** Feature lines staff wrote for the card, when there are any; otherwise the lines derived from entitlements (the original behaviour). */
function planFeatureTexts(p) {
  const custom = (p.feature_lines || []).filter((f) => f.included).map((f) => f.text);
  return custom.length ? custom : pricingFeatures(p.entitlements);
}
function planFeatureItems(p) {
  const lines = p.feature_lines || [];
  return lines.length ? lines.map((f) => ({ text: f.text, off: !f.included, strong: f.highlight })) : pricingFeatures(p.entitlements).map((text) => ({ text, off: false, strong: false }));
}

/** Groups plans by product for one billing period; an annual plan says what it saves against its monthly twin. */
export function pricingGroups(plans, period, ui = {}) {
  const monthlyOf = new Map();
  for (const p of plans) if (p.billing_period === "monthly") monthlyOf.set(`${p.product_id}|${p.name}`, p);
  const groups = new Map();
  for (const p of plans.filter((x) => x.billing_period === period)) {
    const base = p.name.replace(/ \(annual\)$/, "");
    const monthly = period === "annual" ? monthlyOf.get(`${p.product_id}|${base}`) : null;
    let saving = "";
    if (monthly && monthly.price_cents * 12 > p.price_cents) {
      saving = (ui.pricing_saving || "Save {pct}% compared with paying monthly").replace("{pct}", String(Math.round((1 - p.price_cents / (monthly.price_cents * 12)) * 100)));
    }
    if (!groups.has(p.product_id)) groups.set(p.product_id, { id: String(p.product_id), name: p.product_name, category: p.category || "", plans: [] });
    groups.get(p.product_id).plans.push({
      name: base,
      price_cents: p.price_cents,
      currency: p.currency,
      price: MONEY(p.price_cents, p.currency),
      period: period === "annual" ? (ui.pricing_per_year || "per year") : (ui.pricing_per_month || "per month"),
      trial: p.trial_days > 0 ? (ui.pricing_trial || "{n}-day free trial").replace("{n}", String(p.trial_days)) : "",
      saving,
      features: planFeatureTexts(p),
      featureItems: planFeatureItems(p),
      tagline: p.tagline || "",
      labels: p.labels || [],
      has_labels: !!(p.labels && p.labels.length),
      promo: p.promo ? { text: p.promo.text, code_note: p.promo.code ? (ui.pricing_promo_code || "Use code {code} at checkout").replace("{code}", p.promo.code) : "" } : null,
      cta: p.cta_label || "",
      sort_order: p.sort_order || 0,
      staffFeatured: !!p.is_featured,
      seo_description: p.seo_description || "",
      planId: p.id,
      signupPeriod: period,
      productId: String(p.product_id),
      featuresText: planFeatureTexts(p).join(", ") || "Core platform",
      featured: false,
      href: `/app/signup?plan=${encodeURIComponent(p.id)}&period=${period}`
    });
  }
  for (const g of groups.values()) {
    // Staff order first (sort_order, default 0 = the existing price order; the sort is stable).
    g.plans.sort((a, b) => a.sort_order - b.sort_order);
    // A plan staff marked as recommended wins; otherwise a three-tier family highlights its middle plan (layout only; the price is unchanged).
    const picked = g.plans.filter((x) => x.staffFeatured);
    if (picked.length) for (const x of picked) x.featured = true;
    else if (g.plans.length === 3) g.plans[1].featured = true;
  }
  return [...groups.values()];
}

/** One schema.org Offer per listed plan. The description is the staff-written SEO text, or the tagline; nothing is invented. */
function pricingOffersLd(groups, period) {
  const offers = groups.flatMap((g) => g.plans.map((p) => ({
    "@type": "Offer", name: `${g.name}: ${p.name}`, price: String((p.price_cents ?? 0) / 100), priceCurrency: String(p.currency || "USD").toUpperCase(),
    ...(p.seo_description || p.tagline ? { description: p.seo_description || p.tagline } : {}),
    eligibleDuration: { "@type": "QuantitativeValue", unitCode: period === "annual" ? "ANN" : "MON", value: 1 }
  })));
  return offers.length ? [{ "@type": "ItemList", name: "Plans", itemListElement: offers.map((o, i) => ({ "@type": "ListItem", position: i + 1, item: o })) }] : [];
}

export async function pricingPage(ctx) {
  const { site, settings, ui } = ctx.siteCtx;
  const plans = withEffectiveTrial(ctx.env, await pricingRepo.listPricing(ctx.env, { requirePrice: cardRequiredTrial(ctx.env) }));
  const hasAnnual = plans.some((p) => p.billing_period === "annual");
  const period = hasAnnual && ctx.url.searchParams.get("billing") === "annual" ? "annual" : "monthly";
  const groups = pricingGroups(plans, period, ui);
  const heading = intro(settings, "pricing", ui.title_pricing || "Pricing");
  const description = heading.intro || `Plans and prices for ${site.name}.`;
  const head = buildHead({
    site,
    title: heading.title,
    description,
    path: "/pricing",
    noindex: groups.length === 0,
    jsonLd: [
      { "@type": "WebPage", name: heading.title, url: absoluteUrl(site, "/pricing") },
      breadcrumbLd(site, [crumb(ui.crumb_home, "/"), crumb(heading.title, "/pricing")]),
      ...pricingOffersLd(groups, period)
    ]
  });
  return renderPage(ctx, {
    template: "pricing",
    data: {
      ...heading, intro: description, groups, has_groups: groups.length > 0, has_annual: hasAnnual, monthly: period === "monthly", annual: period === "annual",
      families: groups.map((g) => ({ id: g.id, name: g.name })),
      comparisonPlans: groups.flatMap((g) => g.plans.map((plan) => ({ ...plan, family: g.name }))),
      crumbs: crumbs([crumb(ui.crumb_home, "/"), crumb(heading.title, "/pricing")])
    },
    head,
    bodyClass: "page-pricing"
  });
}


// ---------------------------------------------------------- trust pages (6.2A)
// PUBLIC_TRUST_PAGES: off (default) = routes are inert and behave exactly as before;
// shadow = pages render for owner review (noindex, preview notice, [OPEN] markers, no outbound link);
// on = live pages without [OPEN] markers. The pages avoid unverified operational, legal or compliance claims.
export function trustMode(env) {
  const v = String(env?.PUBLIC_TRUST_PAGES || "off").trim().toLowerCase();
  return v === "on" || v === "shadow" ? v : "off";
}

const escAttr = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escText = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function trustPage(ctx, { title, path, description, content }) {
  const mode = trustMode(ctx.env);
  if (mode === "off") return null;
  const { site } = ctx.siteCtx;
  const head = buildHead({ site, title: `${title} | ${site.name}`, description, path, noindex: mode !== "on" });
  return renderPage(ctx, {
    template: "trust",
    data: { trust: { title, description, content_html: sanitizeHtml(content), preview: mode !== "on", preview_text: "Preview: public trust-page rollout is not enabled. Owner review is still required." } },
    head,
    bodyClass: "page-trust"
  });
}

export async function statusPage(ctx) {
  const mode = trustMode(ctx.env);
  const configured = String(ctx.env.STATUS_PROVIDER_URL || "").trim();
  const validUrl = /^https:\/\/[^\s]+$/i.test(configured) && safeUrl(configured) === configured;
  let link;
  if (mode === "on") {
    link = validUrl
      ? `<p><a href="${escAttr(configured)}" rel="noopener noreferrer" target="_blank">View the service status page</a></p>`
      : `<p>Service status information is not available right now.</p>`;
  } else {
    link = validUrl
      ? `<p><strong>[OPEN]</strong> The status-provider link is configured but stays unpublished until the owner sets the trust-page rollout to on.</p>`
      : `<p><strong>[OPEN]</strong> Status-provider URL has not been configured. Service availability is not asserted on this page.</p>`;
  }
  return trustPage(ctx, {
    title: "Service status", path: "/status",
    description: "Link to the service-status provider.",
    content: `<p>This page links to the external status provider.</p>${link}<p>Provider and incident data are maintained by that provider; this page does not independently verify service health.</p>`
  });
}

export async function securityPage(ctx) {
  const mode = trustMode(ctx.env);
  const contact = String(ctx.env.SECURITY_CONTACT || "").trim();
  const safeContact = /^(mailto:[^\s]+|https:\/\/[^\s]+)$/i.test(contact) ? contact : "";
  const contactHtml = safeContact
    ? `<p>Security contact: <a href="${escAttr(safeContact)}">${escText(safeContact)}</a></p>`
    : mode === "on" ? "" : `<p>Security contact: <strong>[OPEN]</strong> owner must provide a monitored security contact.</p>`;
  const openNote = mode === "on" ? "" : `<p><strong>[OPEN]</strong> Disclosure policy, response expectations and scope require owner review. No response-time commitment is made here.</p>`;
  const txt = mode === "on" ? `<p>See also <a href="/.well-known/security.txt">security.txt</a>.</p>` : "";
  return trustPage(ctx, {
    title: "Security", path: "/security",
    description: "Security reporting contact and general vulnerability disclosure information.",
    content: `<p>We welcome responsible reports of potential security vulnerabilities. Please avoid accessing, modifying, or deleting data that does not belong to you, and do not disrupt service while investigating.</p>${contactHtml}${openNote}${txt}`
  });
}

export async function changelogPage(ctx) {
  const mode = trustMode(ctx.env);
  const openNote = mode === "on" ? "" : `<p><strong>[OPEN]</strong> Additional customer-facing release history requires owner-approved entries.</p>`;
  return trustPage(ctx, {
    title: "Changelog", path: "/changelog",
    description: "Release notes.",
    content: `<h2>Release 2.6.0.5</h2><p>Added API documentation and an OpenAPI description of the public API.</p><h2>Release 2.6.0.4</h2><p>Added public trust pages and configurable security contact and status-provider information.</p>${openNote}`
  });
}


// ---------------------------------------------------------- legal drafts and API docs (6.2B)
// PUBLIC_LEGAL_PAGES: off (default) = /legal/* behaves as an unknown path;
// draft = skeleton pages with a DRAFT FOR COUNSEL watermark, noindex, never cached, every clause an [OPEN] placeholder;
// on = a page is published only for a market whose counsel approval is recorded for that exact page, and only with the
// counsel-supplied text (a published CMS page `legal-<market>-<slug>`). Lummet never supplies legal wording itself.
export const LEGAL_PAGE_META = {
  terms: { title: "Terms of service", description: "Terms of service. Draft for counsel review." },
  privacy: { title: "Privacy notice", description: "Privacy notice. Draft for counsel review." },
  dpa: { title: "Data processing agreement", description: "Data processing agreement. Draft for counsel review." },
  subprocessors: { title: "Subprocessors", description: "Subprocessor register. Draft for owner and counsel review." },
  sla: { title: "Service level agreement", description: "Service level agreement. Draft for counsel review." },
  refunds: { title: "Refund policy", description: "Refund policy. Draft for counsel review." },
  "acceptable-use": { title: "Acceptable use", description: "Acceptable-use policy. Draft for counsel review." },
  cookies: { title: "Cookies notice", description: "Cookies notice. Draft for counsel review." }
};
export const LEGAL_SLUGS = Object.keys(LEGAL_PAGE_META);

// Headings only. Each is an owner/counsel question; no clause, number, time window or commitment is invented here.
const LEGAL_DRAFT_SECTIONS = {
  terms: ["Parties, service scope and definitions", "Account obligations", "Fees, taxes, billing and termination", "Liability, warranties and dispute process"],
  privacy: ["Controller and contact details", "Personal data categories and purposes", "Legal basis, retention and rights by market", "International transfers and complaints"],
  dpa: ["Processing instructions and subject matter", "Security measures", "Subprocessors", "Data-subject requests and incident handling", "Deletion, return and audit terms"],
  subprocessors: ["Subprocessor register (names, purpose, data location)", "Notice and objection procedure"],
  sla: ["Service scope and how it is measured", "Availability commitment and exclusions", "Support channels and response commitments", "Remedies and claim process"],
  refunds: ["Eligibility by product and market", "Request process and deadlines", "Statutory rights", "Payment method handling"],
  "acceptable-use": ["Age gating and eligibility by market", "Responsible-gambling disclosures where applicable", "Local advertising and promotion rules by market", "Prohibited conduct and enforcement"],
  cookies: ["Cookie and similar-technology inventory", "Purpose, duration and providers", "Consent choices and withdrawal", "Market-specific disclosures"]
};

export function legalMode(env) {
  const v = String(env?.PUBLIC_LEGAL_PAGES || "off").trim().toLowerCase();
  return v === "draft" || v === "on" ? v : "off";
}

function jsonObjectSetting(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

const MARKET_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The market a request host belongs to (LEGAL_MARKET_BY_HOST = {"host":"market"}), or null. */
export function legalMarketForHost(env, hostname) {
  const map = jsonObjectSetting(env?.LEGAL_MARKET_BY_HOST);
  const market = map ? map[String(hostname || "").toLowerCase()] : null;
  return typeof market === "string" && MARKET_RE.test(market) ? market : null;
}

/** True only for a recorded approval: who, when (valid, not in the future) for exactly this market and page. */
export function legalApprovalRecorded(env, market, slug) {
  const approval = jsonObjectSetting(env?.LEGAL_COUNSEL_APPROVALS)?.[market]?.[slug];
  if (!approval || typeof approval.approvedBy !== "string" || !approval.approvedBy.trim()) return false;
  if (typeof approval.approvedAt !== "string" || !ISO_TS_RE.test(approval.approvedAt)) return false;
  const at = Date.parse(approval.approvedAt);
  return Number.isFinite(at) && at <= Date.now();
}

export async function approvedLegalPage(ctx, slug) {
  const market = legalMarketForHost(ctx.env, ctx.url.hostname);
  if (!market || !legalApprovalRecorded(ctx.env, market, slug)) return null;
  const row = await data.getPage(ctx.env, `legal-${market}-${slug}`);
  const html = row ? sanitizeHtml(row.content || "") : "";
  // Text that still carries a placeholder or the draft watermark is not counsel-approved text.
  if (!html.trim() || /\[OPEN|DRAFT FOR COUNSEL/i.test(html)) return null;
  return { market, html };
}

function legalResponse(ctx, { title, path, description, content, draft }) {
  const { site } = ctx.siteCtx;
  const shownTitle = draft ? `${title} (DRAFT FOR COUNSEL)` : title;
  const head = buildHead({ site, title: `${shownTitle} | ${site.name}`, description, path, noindex: draft });
  return renderPage(ctx, {
    template: "trust",
    data: { trust: { title: shownTitle, description, content_html: sanitizeHtml(content), preview: draft, preview_text: "DRAFT FOR COUNSEL: not approved for use or publication. Counsel approval and final text are required for each market." } },
    head,
    bodyClass: draft ? "page-trust page-legal-draft" : "page-trust page-legal",
    cacheControl: "no-store"
  });
}

export async function legalIndexPage(ctx) {
  const mode = legalMode(ctx.env);
  if (mode === "off") return null;
  let slugs = LEGAL_SLUGS;
  if (mode === "on") {
    const approved = [];
    for (const slug of LEGAL_SLUGS) if (await approvedLegalPage(ctx, slug)) approved.push(slug);
    slugs = approved;
    if (!slugs.length) return null;
  }
  const links = slugs.map((slug) => `<li><a href="/legal/${slug}">${escText(LEGAL_PAGE_META[slug].title)}</a></li>`).join("");
  return legalResponse(ctx, {
    title: "Legal", path: "/legal", description: "Legal documents by market.", draft: mode === "draft",
    content: `<p>Documents are market-specific. Each one is published only with counsel-approved text for the relevant market.</p><ul>${links}</ul>`
  });
}

export async function legalPage(ctx, { slug }) {
  const meta = LEGAL_PAGE_META[slug];
  const mode = legalMode(ctx.env);
  if (!meta || mode === "off") return null;
  const path = `/legal/${slug}`;
  if (mode === "draft") {
    const items = LEGAL_DRAFT_SECTIONS[slug].map((x) => `<li>${escText(x)}: <strong>[OPEN]</strong> counsel-supplied wording required</li>`).join("");
    return legalResponse(ctx, {
      title: meta.title, path, description: meta.description, draft: true,
      content: `<p><strong>[OPEN]</strong> No approved ${escText(meta.title.toLowerCase())} text is present. This page is a placeholder outline, not legal advice, and not a contract, policy or commitment.</p><h2>Sections counsel must supply</h2><ul>${items}</ul>`
    });
  }
  const approved = await approvedLegalPage(ctx, slug);
  if (!approved) return null;
  return legalResponse(ctx, { title: meta.title, path, description: meta.description, content: approved.html, draft: false });
}

export async function docsPage(ctx) {
  const mode = trustMode(ctx.env);
  if (mode === "off") return null;
  const scopes = API_V1_SCOPES.map((s) => `<code>${escText(s)}</code>`).join(", ");
  const events = WEBHOOK_EVENT_TYPES.map((s) => `<code>${escText(s)}</code>`).join(", ");
  const content = `<p>The machine-readable description is at <a href="/openapi.json">/openapi.json</a> (OpenAPI 3.1). It covers the API-key endpoints under <code>/api/v1/</code> only. Routes that are not listed are not part of the public API and carry no stability promise.</p>
<h2>Authentication</h2><p>Send a customer API key as <code>Authorization: Bearer &lt;key&gt;</code>. Keys are created by an organization owner and carry scopes (${scopes}); a key may also be limited to one site. Repeated invalid keys from one address are rate limited and answered with 429.</p>
<h2>Webhook signing</h2><p>Each outgoing delivery is a JSON <code>POST</code> carrying <code>Lummet-Signature: t=&lt;unix seconds&gt;,v1=&lt;hex&gt;</code>, <code>Lummet-Delivery-Id</code> and <code>Lummet-Delivery-Attempt</code>. Compute HMAC-SHA256, keyed with the endpoint secret, over the exact string <code>{t}.{raw request body}</code>, hex-encode it and compare it with <code>v1</code> in constant time. Reject timestamps outside a replay window you choose. A retry is signed again with a new timestamp and carries the same delivery id, so use the delivery id to ignore duplicates. Event types: ${events}.</p>
<p><strong>[OPEN]</strong> API support policy, versioning policy and a recommended replay window are owner decisions and are not stated here.</p>`;
  return trustPage(ctx, { title: "API documentation", path: "/docs", description: "OpenAPI description of the public API and webhook signing.", content });
}

export async function openApiJsonPage(ctx) {
  const mode = trustMode(ctx.env);
  if (mode === "off") return null;
  const body = JSON.stringify(buildOpenApiSpec());
  const response = textResponse(body, "application/json; charset=utf-8", { cacheControl: mode === "on" ? "public, max-age=300" : "no-store" });
  if (mode !== "on") response.headers.set("X-Robots-Tag", "noindex");
  return response;
}

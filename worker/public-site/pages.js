// =====================================================
// PUBLIC SITE — ROUTE HANDLERS
// One function per public page. Each loads published rows, builds the
// view model, the <head> (from the record's own seo_* fields) and the
// JSON-LD, then renders through renderPage().
// =====================================================

import * as data from "./data.js";
import { brandModel, updateModel, publicationModel, partnerModel, authorModel, typeLabel } from "./models.js";
import { PAGE_ALIASES } from "./links.js";
import { sanitizeHtml } from "./sanitize.js";
import { renderPage } from "./render.js";
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

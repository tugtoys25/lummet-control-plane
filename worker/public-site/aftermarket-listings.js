// =====================================================
// PUBLIC SITE — MARKETPLACE: BUSINESSES FOR SALE, BY CATEGORY
//
//   /aftermarket                        the hub: domains + every category with its count
//   /aftermarket/businesses             all listed businesses
//   /aftermarket/businesses/:category   one category
//   /aftermarket/listings/:slug         one listing + the enquiry form (the same form mechanism the domains use: forms.js)
//
// Only listings with status 'listed' are ever shown. Sellers create listings in the portal (Aftermarket tab); an admin approves them.
// =====================================================

import * as data from "./data.js";
import * as forms from "./forms.js";
import { renderPage } from "./render.js";
import { buildHead, breadcrumbLd } from "./seo.js";
import { fill } from "./format.js";

export const LISTING_FORM_KEY = "listing-enquiry";
export const LISTING_REF_PREFIX = "listing:";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

function crumbs(ui, extra) {
  return [{ label: ui.crumb_home, href: "/" }, ...extra].map((c, i, a) => ({ ...c, last: i === a.length - 1 }));
}

const listingHref = (slug) => `/aftermarket/listings/${encodeURIComponent(slug)}`;

export async function hubPage(ctx) {
  const { env, siteCtx } = ctx;
  const { site, ui } = siteCtx;
  const [categories, counts, domains] = await Promise.all([data.listListingCategories(env), data.countListedByCategory(env), data.listAftermarketDomains(env, 500)]);
  const countOf = Object.fromEntries(counts.map((c) => [c.category_slug, c.n]));
  const sections = [
    { name: ui.listings_hub_domains, blurb: ui.listings_hub_domains_blurb, href: "/aftermarket/list-of-domains", count: fill(ui.listings_hub_count, { count: domains.length }), has_count: domains.length > 0 },
    ...categories.map((c) => ({ name: c.name, blurb: c.description || "", href: `/aftermarket/businesses/${encodeURIComponent(c.slug)}`, count: fill(ui.listings_hub_count, { count: countOf[c.slug] || 0 }), has_count: (countOf[c.slug] || 0) > 0 }))
  ];
  const trail = crumbs(ui, [{ label: ui.listings_hub_title, href: "/aftermarket" }]);
  const head = buildHead({ site, title: ui.listings_hub_title, description: ui.listings_hub_intro, path: "/aftermarket", jsonLd: [breadcrumbLd(site, trail.map((t) => ({ label: t.label, href: t.href })))] });
  return renderPage(ctx, {
    template: "aftermarket-hub",
    data: { title: ui.listings_hub_title, intro: ui.listings_hub_intro, sections, sell_href: "/app/aftermarket", crumbs: trail },
    head,
    bodyClass: "page-aftermarket"
  });
}

export async function businessesPage(ctx, params = {}) {
  const { env, siteCtx } = ctx;
  const { site, ui } = siteCtx;
  let category = null;
  if (params.category) {
    category = SLUG_RE.test(String(params.category).toLowerCase()) ? await data.getListingCategory(env, String(params.category).toLowerCase()) : null;
    if (!category) return null;
  }
  const [rows, categories] = await Promise.all([data.listPublicListings(env, { category: category?.slug || null }), data.listListingCategories(env)]);
  const title = category ? fill(ui.listings_category_title, { category: category.name }) : ui.listings_title;
  const intro = category?.description || ui.listings_intro;
  const path = category ? `/aftermarket/businesses/${category.slug}` : "/aftermarket/businesses";
  const items = rows.map((r) => ({
    title: r.title, href: listingHref(r.slug), category: r.category_name || "", location: r.location || "", revenue: r.revenue || "",
    price: String(r.asking_price || "").trim() || ui.aftermarket_price_on_request
  }));
  const tabs = [{ name: ui.listings_all_categories, href: "/aftermarket/businesses", active: !category }, ...categories.map((c) => ({ name: c.name, href: `/aftermarket/businesses/${encodeURIComponent(c.slug)}`, active: category?.slug === c.slug }))];
  const trail = crumbs(ui, [{ label: ui.listings_hub_title, href: "/aftermarket" }, ...(category ? [{ label: ui.listings_crumb, href: "/aftermarket/businesses" }, { label: category.name, href: path }] : [{ label: ui.listings_crumb, href: path }])]);
  const head = buildHead({ site, title, description: intro, path, jsonLd: [breadcrumbLd(site, trail.map((t) => ({ label: t.label, href: t.href })))] });
  return renderPage(ctx, {
    template: "aftermarket-businesses",
    data: { title, intro, items, has_items: items.length > 0, tabs, sell_href: "/app/aftermarket", crumbs: trail },
    head,
    bodyClass: "page-aftermarket"
  });
}

async function subjectFor(ctx, slug) {
  const s = String(slug || "").toLowerCase();
  const row = SLUG_RE.test(s) ? await data.getListedListing(ctx.env, s) : null;
  return row ? { kind: "listing", row, ref: `${LISTING_REF_PREFIX}${row.slug}`, source: "landing" } : null;
}

export async function listingPage(ctx, params) {
  const subject = await subjectFor(ctx, params.slug);
  if (!subject) return null;
  return forms.formPage(ctx, { key: LISTING_FORM_KEY, path: listingHref(subject.row.slug), subject });
}

export async function listingSubmit(ctx, params) {
  const subject = await subjectFor(ctx, params.slug);
  if (!subject) return null;
  return forms.submitForm(ctx, { key: LISTING_FORM_KEY, path: listingHref(subject.row.slug), subject });
}

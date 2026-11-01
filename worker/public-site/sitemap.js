// =====================================================
// PUBLIC SITE — sitemap.xml and robots.txt (generated from the DB)
// Only URLs that actually resolve to published content are listed.
// =====================================================

import * as pricingRepo from "../repositories/pricing.js";
import * as data from "./data.js";
import { xmlEscape } from "./format.js";
import { pageCanonicalPath, trustMode, legalMode, LEGAL_SLUGS, approvedLegalPage } from "./pages.js";
import { formPath, CONTACT_SALES_KEY } from "./forms.js";
import { textResponse } from "./render.js";

const day = (v) => (v ? String(v).slice(0, 10) : "");

export async function sitemapXml(ctx) {
  const { env, siteCtx } = ctx;
  const { site, counts } = siteCtx;
  const base = site.base_url;

  const [brands, updates, publications, pages, authors, partners, publishedForms] = await Promise.all([
    data.listBrands(env, 500),
    data.listUpdates(env, { limit: 500 }),
    data.listPublications(env, { limit: 500 }),
    data.listPublishedPages(env),
    data.listAuthorsWithPublishedWork(env),
    counts.partners ? data.listPartners(env, 1) : Promise.resolve([]),
    data.listPublishedForms(env)
  ]);

  const urls = [{ loc: `${base}/` }];
  if (brands.length) urls.push({ loc: `${base}/brands` });
  for (const b of brands) urls.push({ loc: `${base}/brands/${b.slug}`, lastmod: day(b.updated_at) });
  if (updates.length) urls.push({ loc: `${base}/updates` });
  for (const u of updates) urls.push({ loc: `${base}/updates/${u.slug}`, lastmod: day(u.updated_at || u.published_at) });
  if (publications.length) urls.push({ loc: `${base}/insights` });
  for (const p of publications) urls.push({ loc: `${base}/insights/${p.slug}`, lastmod: day(p.updated_at || p.published_at) });
  if (partners.length) urls.push({ loc: `${base}/partners` });
  if ((await pricingRepo.listPricing(env)).length) urls.push({ loc: `${base}/pricing` });
  for (const pg of pages) urls.push({ loc: `${base}${pageCanonicalPath(pg.slug)}`, lastmod: day(pg.updated_at) });
  const trustLive = trustMode(env) === "on";
  for (const f of publishedForms) {
    if (f.form_key === CONTACT_SALES_KEY && !trustLive) continue;   // a trust route: listed only below, and only when live
    urls.push({ loc: `${base}${formPath(f.form_key)}`, lastmod: day(f.updated_at) });
  }
  for (const a of authors) urls.push({ loc: `${base}/authors/${a.slug}`, lastmod: day(a.updated_at) });

  // Trust and legal routes (H.5, I-14). Listed only when they are live and indexable: PUBLIC_TRUST_PAGES=on, and for legal pages only
  // those with a recorded counsel approval and approved text (PUBLIC_LEGAL_PAGES=on). Shadow and draft pages are noindex and stay out.
  if (trustLive) {
    for (const p of ["/status", "/security", "/changelog", "/docs", "/contact-sales"]) urls.push({ loc: `${base}${p}` });
  }
  if (legalMode(env) === "on") {
    const approved = [];
    for (const slug of LEGAL_SLUGS) if (await approvedLegalPage(ctx, slug)) approved.push(slug);
    if (approved.length) urls.push({ loc: `${base}/legal` });
    for (const slug of approved) urls.push({ loc: `${base}/legal/${slug}` });
  }

  const seen = new Set();
  const unique = urls.filter((u) => (seen.has(u.loc) ? false : (seen.add(u.loc), true)));
  const body = unique
    .map((u) => `  <url><loc>${xmlEscape(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`)
    .join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
  return textResponse(xml, "application/xml; charset=utf-8", { cacheControl: "public, max-age=300, s-maxage=600" });
}

export function robotsTxt(ctx) {
  const { site } = ctx.siteCtx;
  const lines = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /login",
    "Disallow: /account/",
    "Disallow: /tenants",
    "Disallow: /content/",
    "Disallow: /system/",
    "Disallow: /cms/",
    "Disallow: /platform/",
    "",
    `Sitemap: ${site.base_url}/sitemap.xml`,
    ""
  ];
  return textResponse(lines.join("\n"), "text/plain; charset=utf-8", { cacheControl: "public, max-age=3600" });
}

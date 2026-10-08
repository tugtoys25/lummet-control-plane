// =====================================================
// PUBLIC SITE — sitemap.xml and robots.txt (generated from the DB)
// Only URLs that actually resolve to published content are listed.
// =====================================================

import * as data from "./data.js";
import { xmlEscape } from "./format.js";
import { pageCanonicalPath } from "./pages.js";
import { formPath } from "./forms.js";
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
  for (const pg of pages) urls.push({ loc: `${base}${pageCanonicalPath(pg.slug)}`, lastmod: day(pg.updated_at) });
  for (const f of publishedForms) urls.push({ loc: `${base}${formPath(f.form_key)}`, lastmod: day(f.updated_at) });
  for (const a of authors) urls.push({ loc: `${base}/authors/${a.slug}`, lastmod: day(a.updated_at) });

  const body = urls
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

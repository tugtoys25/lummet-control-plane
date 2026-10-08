// =====================================================
// PUBLIC SITE — SEO / OPEN GRAPH / JSON-LD
// Canonical, Open Graph and Twitter tags come from the page's own
// seo_* fields when set, and otherwise from the record's real title
// and excerpt. Nothing is hardcoded per page.
// =====================================================

import { escapeHtml } from "./template.js";
import { jsonForScript, truncate } from "./format.js";

export function absoluteUrl(site, pathOrUrl) {
  if (!pathOrUrl) return "";
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${site.base_url}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

export function pageTitle(site, title) {
  if (!title) return site.title;
  return title.toLowerCase().includes(site.name.toLowerCase()) ? title : `${title} · ${site.name}`;
}

export function organizationLd(site) {
  const ld = { "@type": "Organization", "@id": `${site.base_url}/#organization`, name: site.name, url: `${site.base_url}/` };
  if (site.description) ld.description = site.description;
  if (site.logo_url) ld.logo = absoluteUrl(site, site.logo_url);
  return ld;
}

export function websiteLd(site) {
  return { "@type": "WebSite", "@id": `${site.base_url}/#website`, name: site.name, url: `${site.base_url}/`, publisher: { "@id": `${site.base_url}/#organization` } };
}

export function breadcrumbLd(site, trail) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: trail.map((t, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: t.label,
      item: absoluteUrl(site, t.href)
    }))
  };
}

/**
 * @param {object} o
 * @param {object} o.site       from context.js
 * @param {string} o.title      page title WITHOUT the site suffix (omit for the homepage)
 * @param {string} o.description
 * @param {string} o.path       canonical path, e.g. "/brands/level-casino"
 * @param {string} [o.image]    social image (record og_image, featured image, or site default)
 * @param {string} [o.type]     og:type — website | article
 * @param {boolean} [o.noindex]
 * @param {object} [o.article]  { published, modified, author }
 * @param {string} [o.prev] @param {string} [o.next]
 * @param {object[]} [o.jsonLd] objects merged into one @graph
 */
export function buildHead(o) {
  const { site } = o;
  const title = o.rawTitle || pageTitle(site, o.title);
  const description = truncate(o.description || site.description || "", 200);
  const canonical = absoluteUrl(site, o.path || "/");
  const image = absoluteUrl(site, o.image || site.og_image || "");
  const tags = [];

  tags.push(`<title>${escapeHtml(title)}</title>`);
  if (description) tags.push(`<meta name="description" content="${escapeHtml(description)}">`);
  tags.push(`<link rel="canonical" href="${escapeHtml(canonical)}">`);
  tags.push(o.noindex ? `<meta name="robots" content="noindex, follow">` : `<meta name="robots" content="index, follow, max-image-preview:large">`);
  if (o.prev) tags.push(`<link rel="prev" href="${escapeHtml(absoluteUrl(site, o.prev))}">`);
  if (o.next) tags.push(`<link rel="next" href="${escapeHtml(absoluteUrl(site, o.next))}">`);

  tags.push(`<meta property="og:site_name" content="${escapeHtml(site.name)}">`);
  tags.push(`<meta property="og:type" content="${o.type === "article" ? "article" : "website"}">`);
  tags.push(`<meta property="og:title" content="${escapeHtml(title)}">`);
  if (description) tags.push(`<meta property="og:description" content="${escapeHtml(description)}">`);
  tags.push(`<meta property="og:url" content="${escapeHtml(canonical)}">`);
  if (image) tags.push(`<meta property="og:image" content="${escapeHtml(image)}">`);
  if (o.article?.published) tags.push(`<meta property="article:published_time" content="${escapeHtml(o.article.published)}">`);
  if (o.article?.modified) tags.push(`<meta property="article:modified_time" content="${escapeHtml(o.article.modified)}">`);
  if (o.article?.author) tags.push(`<meta property="article:author" content="${escapeHtml(o.article.author)}">`);

  tags.push(`<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">`);
  tags.push(`<meta name="twitter:title" content="${escapeHtml(title)}">`);
  if (description) tags.push(`<meta name="twitter:description" content="${escapeHtml(description)}">`);
  if (image) tags.push(`<meta name="twitter:image" content="${escapeHtml(image)}">`);

  if (o.jsonLd?.length) {
    tags.push(`<script type="application/ld+json">${jsonForScript({ "@context": "https://schema.org", "@graph": o.jsonLd })}</script>`);
  }
  return tags.join("\n  ");
}

// =====================================================
// PUBLIC SITE — VIEW MODELS
// Turns database rows into the exact, already-safe objects the
// templates print. All URLs pass through safeUrl(), all rich text
// through sanitizeHtml(), and derived text (excerpts, reading time,
// dates) is computed from the row's own content, never made up.
// =====================================================

import { sanitizeHtml } from "./sanitize.js";
import { formatDate, stripTags, truncate, readingMinutes, initials, safeUrl, hostOf, isExternal } from "./format.js";
import { iconSvg } from "./icons.js";

/** Label for a publication type, from lummet_ui_strings (type_<type>); unknown types fall back to type_blog. */
export function typeLabel(ui, type) {
  return (ui && (ui[`type_${type}`] || ui.type_blog)) || "";
}

export function brandModel(row) {
  const website = safeUrl(row.website_url);
  const logo = safeUrl(row.logo_url);
  const descriptionHtml = sanitizeHtml(row.description || "");
  const plain = stripTags(descriptionHtml);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    url: `/brands/${row.slug}`,
    category: row.category || "",
    tagline: row.tagline || "",
    description_html: descriptionHtml,
    summary: truncate(row.tagline || plain, 150),
    logo_url: logo,
    has_logo: Boolean(logo),
    initials: initials(row.name),
    website_url: website,
    website_host: hostOf(website),
    website_external: isExternal(website)
  };
}

function contentBase(row, urlBase) {
  const date = formatDate(row.published_at || row.created_at);
  const modified = formatDate(row.updated_at);
  const contentHtml = sanitizeHtml(row.content || "");
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    url: `${urlBase}/${row.slug}`,
    excerpt: row.excerpt || truncate(stripTags(contentHtml), 170),
    content_html: contentHtml,
    date_iso: date.iso,
    date_label: date.label,
    modified_iso: modified.iso,
    author_name: row.author_name || "",
    author_url: row.author_slug ? `/authors/${row.author_slug}` : "",
    featured_image: safeUrl(row.featured_image),
    reading_minutes: readingMinutes(contentHtml)
  };
}

export function updateModel(row) {
  return contentBase(row, "/updates");
}

export function publicationModel(row, ui) {
  const base = contentBase(row, "/insights");
  const sourceUrl = safeUrl(row.source_url);
  return {
    ...base,
    type: row.publication_type,
    type_label: typeLabel(ui, row.publication_type),
    is_press: row.publication_type === "press",
    source_name: row.source_name || "",
    source_url: sourceUrl,
    source_host: hostOf(sourceUrl)
  };
}

export function partnerModel(row) {
  const website = safeUrl(row.website_url);
  const logo = safeUrl(row.logo_url);
  return {
    name: row.name,
    slug: row.slug,
    type: row.partner_type || "",
    description: row.description || "",
    logo_url: logo,
    has_logo: Boolean(logo),
    initials: initials(row.name),
    website_url: website,
    website_host: hostOf(website)
  };
}

export function featureModel(row) {
  return {
    key: row.feature_key,
    title: row.title,
    body: row.body || "",
    icon_svg: iconSvg(row.icon, { size: 22 }),
    check_svg: iconSvg("check", { size: 18 }),
    link_label: row.link_label || "",
    link_href: safeUrl(row.link_href)
  };
}

export function faqModel(row) {
  return { question: row.question, answer_html: sanitizeHtml(row.answer || ""), answer_text: stripTags(row.answer) };
}

export function authorModel(row) {
  let social = [];
  try {
    const parsed = row.social_links ? JSON.parse(row.social_links) : {};
    social = Object.entries(parsed)
      .map(([label, href]) => ({ label, href: safeUrl(href) }))
      .filter((s) => s.href && isExternal(s.href));
  } catch {
    social = [];
  }
  return {
    name: row.name,
    slug: row.slug,
    url: `/authors/${row.slug}`,
    title: row.title || "",
    bio: row.bio || "",
    avatar_url: safeUrl(row.avatar_url),
    has_avatar: Boolean(safeUrl(row.avatar_url)),
    initials: initials(row.name),
    social
  };
}

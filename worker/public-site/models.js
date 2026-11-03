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

// ---- Brand strip (moving, under the homepage header) --------------------------------------------------------------
// Accent colours for brands with no colour of their own: deep, saturated hues that hold 4.5:1 text contrast on white and stay legible on dark.
const STRIP_PALETTE = ["#4f46e5", "#0e7490", "#047857", "#b45309", "#be123c", "#7e22ce", "#1d4ed8", "#0f766e"];

function hashSlug(slug) {
  let h = 0;
  for (const ch of String(slug || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/** The stored #RRGGBB when valid (nothing user-typed reaches CSS otherwise), else a stable colour derived from the slug. */
export function brandAccent(row) {
  const stored = String(row?.accent_color || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(stored)) return stored.toLowerCase();
  return STRIP_PALETTE[hashSlug(row?.slug) % STRIP_PALETTE.length];
}

/**
 * Chips for the marquee. Only published brands with show_in_strip on (absent before migration 0082 = shown).
 * `track` is the list repeated until it is long enough to loop without a gap; repeats are flagged aria_hidden so
 * assistive tech and the tab order see each brand once. `dup` is the second, fully hidden copy the CSS animation slides in.
 */
export function brandStripModels(rows, { limit = 24, minItems = 12 } = {}) {
  const base = (rows || [])
    .filter((r) => r && r.slug && r.status !== "draft" && r.show_in_strip !== 0 && r.show_in_strip !== "0")
    .slice(0, limit)
    .map((r) => {
      const logo = safeUrl(r.logo_url);
      return { name: r.name, url: `/brands/${encodeURIComponent(r.slug)}`, logo_url: logo, has_logo: Boolean(logo), initials: initials(r.name), accent: brandAccent(r), aria_hidden: false };
    });
  if (!base.length) return { items: [], track: [], dup: [], seconds: 0 };
  const track = [];
  while (track.length < minItems) for (const b of base) track.push({ ...b, aria_hidden: track.length >= base.length });
  const dup = track.map((b) => ({ ...b, aria_hidden: true }));
  // ~4.5 s per chip keeps the pace readable however many brands there are.
  return { items: base, track, dup, seconds: Math.max(30, Math.round(track.length * 4.5)) };
}

// =====================================================
// PUBLIC SITE — HOMEPAGE COMPOSITION
// The homepage is an ordered list of rows from
// lummet_homepage_sections. Each row's `kind` selects a component
// template. A section whose data source is empty is simply omitted
// (no placeholder copy, no invented numbers).
// =====================================================

import {
  listHomepageSections, listFeatures, listFaqs, listBrands, listUpdates,
  listPublications, listPartners, getBannerAd
} from "./data.js";
import { brandModel, updateModel, publicationModel, partnerModel, featureModel, faqModel } from "./models.js";
import { sanitizeHtml } from "./sanitize.js";
import { safeUrl, isExternal, formatDate } from "./format.js";
import { heroGraphSvg } from "./hero-graph.js";
import { isLiveHref } from "./links.js";

const KINDS = new Set([
  "text", "features", "steps", "checklist", "panel", "brands", "stats",
  "updates", "insights", "partners", "faq", "cta", "contact"
]);

function groupBy(rows, key) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r[key])) map.set(r[key], []);
    map.get(r[key]).push(r);
  }
  return map;
}

function sectionShell(row, extra = {}) {
  const ctaHref = safeUrl(row.cta_href);
  return {
    key: row.section_key || `section-${row.id}`,
    kind: row.kind,
    [`is_${row.kind}`]: true,
    bg: ["soft", "dark"].includes(row.background) ? row.background : "default",
    title: row.title,
    eyebrow: row.subtitle || "",
    body_html: sanitizeHtml(row.body || ""),
    cta_label: row.cta_label && ctaHref ? row.cta_label : "",
    cta_href: ctaHref,
    cta_external: isExternal(ctaHref),
    image_url: safeUrl(row.image_url),
    image_left: row.layout === "image_left" && Boolean(safeUrl(row.image_url)),
    image_right: row.layout === "image_right" && Boolean(safeUrl(row.image_url)),
    ...extra
  };
}

export async function buildHome(ctx) {
  const { env, siteCtx } = ctx;
  const { site, settings, counts, ui } = siteCtx;

  const [rows, features, faqs, brands, updates, publications, partners, banner] = await Promise.all([
    listHomepageSections(env),
    listFeatures(env),
    listFaqs(env),
    listBrands(env, 12),
    listUpdates(env, { limit: 3 }),
    listPublications(env, { limit: 3 }),
    listPartners(env, 8),
    getBannerAd(env)
  ]);

  const featuresByGroup = groupBy(features, "group_key");
  const faqsByGroup = groupBy(faqs, "group_key");
  const brandCards = brands.map(brandModel);
  const sections = [];

  for (const row of rows) {
    if (!KINDS.has(row.kind)) continue;
    const group = row.feature_group || "";
    const items = (featuresByGroup.get(group) || []).map(featureModel);

    switch (row.kind) {
      case "features":
      case "steps":
      case "checklist":
        if (items.length) sections.push(sectionShell(row, { items: items.map((it, i) => ({ ...it, number: String(i + 1).padStart(2, "0") })) }));
        break;
      case "panel":
        if (row.body || items.length) sections.push(sectionShell(row, { items }));
        break;
      case "brands":
        if (brandCards.length) sections.push(sectionShell(row, { items: brandCards.slice(0, 6) }));
        break;
      case "updates":
        if (updates.length) sections.push(sectionShell(row, { items: updates.map(updateModel) }));
        break;
      case "insights":
        if (publications.length) sections.push(sectionShell(row, { items: publications.map((p) => publicationModel(p, ui)) }));
        break;
      case "partners":
        if (partners.length) sections.push(sectionShell(row, { items: partners.map(partnerModel) }));
        break;
      case "faq": {
        const list = (faqsByGroup.get(group || "general") || []).map(faqModel);
        if (list.length) sections.push(sectionShell(row, { items: list }));
        break;
      }
      case "stats": {
        const stats = [];
        const one = (n, a, b) => (n === 1 ? ui[a] : ui[b]);
        if (counts.brands) stats.push({ value: String(counts.brands), label: one(counts.brands, "stat_brand_one", "stat_brand_many") });
        if (counts.updates) stats.push({ value: String(counts.updates), label: one(counts.updates, "stat_update_one", "stat_update_many") });
        if (counts.publications) stats.push({ value: String(counts.publications), label: one(counts.publications, "stat_insight_one", "stat_insight_many") });
        const latest = formatDate(counts.latestUpdate);
        if (latest.label && ui.stat_latest) stats.push({ value: latest.label, label: ui.stat_latest, is_text: true });
        for (const st of stats) if (!st.label) st.label = "";
        if (stats.length) sections.push(sectionShell(row, { items: stats }));
        break;
      }
      case "cta":
      case "contact":
        sections.push(sectionShell(row)); // kept or dropped in the liveness pass below
        break;
      default: // text
        if (row.title || row.body) sections.push(sectionShell(row));
    }
  }

  // Liveness pass: a button whose destination has no published content (or is an
  // anchor to a section that is not on this page) is removed, not left dead.
  const present = new Set(sections.map((s) => s.key));
  for (const sec of sections) {
    if (sec.cta_label && !isLiveHref(sec.cta_href, { counts, anchors: present })) {
      sec.cta_label = "";
      sec.cta_href = "";
    }
  }
  for (let i = sections.length - 1; i >= 0; i--) {
    const sec = sections[i];
    if (sec.is_cta && !sec.cta_label) sections.splice(i, 1);
    else if (sec.is_contact && !sec.cta_label && !site.has_contact) sections.splice(i, 1);
    else if (sec.is_panel && !sec.cta_label && !sec.body_html && !(sec.items || []).length) sections.splice(i, 1);
  }
  const liveKeys = new Set(sections.map((s) => s.key));

  const heroTitle = (settings.hero_title || "").trim();
  const hero = heroTitle
    ? {
        eyebrow: settings.hero_eyebrow || "",
        title: heroTitle,
        subtitle: settings.hero_subtitle || "",
        primary_label: settings.hero_cta_primary_label || "",
        primary_href: safeUrl(settings.hero_cta_primary_href),
        secondary_label: settings.hero_cta_secondary_label || "",
        secondary_href: safeUrl(settings.hero_cta_secondary_href),
        graph_svg: heroGraphSvg(site.name, brandCards, ui)
      }
    : null;
  if (hero) {
    const live = (href) => isLiveHref(href, { counts, anchors: liveKeys });
    hero.has_primary = Boolean(hero.primary_label && hero.primary_href && live(hero.primary_href));
    hero.has_secondary = Boolean(hero.secondary_label && hero.secondary_href && live(hero.secondary_href));
  }

  const bannerAd = banner && safeUrl(banner.image_url)
    ? { image_url: safeUrl(banner.image_url), link_url: safeUrl(banner.link_url), alt: banner.alt_text || banner.name || "", has_link: Boolean(safeUrl(banner.link_url)) }
    : null;

  const faqSection = sections.find((s) => s.is_faq);
  return { hero, sections, banner: bannerAd, faqItems: faqSection ? faqSection.items : [] };
}

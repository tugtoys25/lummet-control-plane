// =====================================================
// PUBLIC SITE — SHARED CONTEXT
// Everything the shared layout (base/header/footer) needs on EVERY
// public page: branding, navigation, footer columns, canonical base
// URL. Loaded once per request from the database, so the header and
// footer are content, not markup.
// =====================================================

import { getSettings, getNavLinks, getSiteCounts, listHomepageAnchors, getUiStrings } from "./data.js";
import { safeUrl, safeCssColor, initials } from "./format.js";
import { iconSvg } from "./icons.js";
import { isLiveHref } from "./links.js";

// Column titles come from lummet_ui_strings (footer_<name>_title).
const FOOTER_COLUMNS = [
  { placement: "footer_platform", titleKey: "footer_platform_title" },
  { placement: "footer_company", titleKey: "footer_company_title" },
  { placement: "footer_legal", titleKey: "footer_legal_title" }
];

/** Decide whether a nav link should show, based on whether its destination has content. */
export function isLinkVisible(rule, { counts, hasContact }) {
  const r = (rule || "always").trim();
  if (r === "always") return true;
  if (r === "has_brands") return counts.brands > 0;
  if (r === "has_updates") return counts.updates > 0;
  if (r === "has_publications") return counts.publications > 0;
  if (r === "has_partners") return counts.partners > 0;
  if (r === "has_faq") return counts.faqs > 0;
  if (r === "has_contact") return hasContact;
  if (r.startsWith("page:")) return counts.pageSlugs.has(r.slice(5));
  if (r.startsWith("form:")) return counts.formKeys.has(r.slice(5));
  return false; // unknown rule: hide rather than guess
}

function isActive(href, path) {
  if (!href || href.startsWith("#") || href.includes("#")) return false;
  if (href === "/") return path === "/";
  return path === href || path.startsWith(`${href}/`);
}

function baseUrlFor(settings, requestUrl) {
  const configured = safeUrl(settings.canonical_url);
  if (/^https?:\/\//i.test(configured)) return configured.replace(/\/+$/, "");
  return requestUrl.origin;
}

function accentCss(settings) {
  const a = safeCssColor(settings.accent_color);
  const b = safeCssColor(settings.accent_color_secondary);
  if (!a && !b) return "";
  const decls = [a ? `--accent:${a};` : "", b ? `--accent-2:${b};` : ""].join("");
  return `:root,:root[data-theme="light"],:root[data-theme="dark"]{${decls}}`;
}

/**
 * Anchor links ("/#brands", "#faq") are only shown when the homepage really
 * has that section. Contact-dependent sections (a contact block, or a CTA that
 * points at #contact) do not count when no contact email is configured, and a
 * data-driven section that would render empty is checked by its kind.
 */
export function liveAnchors(rows, counts, hasContact) {
  const keys = new Set();
  for (const r of rows) {
    if (r.kind === "contact" && !hasContact) continue;
    if (r.kind === "cta" && r.cta_href === "#contact" && !hasContact) continue;
    if (r.kind === "brands" && !counts.brands) continue;
    if (r.kind === "updates" && !counts.updates) continue;
    if (r.kind === "insights" && !counts.publications) continue;
    if (r.kind === "partners" && !counts.partners) continue;
    if (r.kind === "faq" && !counts.faqs) continue;
    keys.add(r.section_key);
  }
  return keys;
}

function anchorOf(href) {
  const m = /^\/?#([\w-]+)$/.exec(href || "");
  return m ? m[1] : null;
}

export async function loadSite(env, url) {
  const [settings, counts, links, anchorRows, ui] = await Promise.all([
    getSettings(env),
    getSiteCounts(env),
    getNavLinks(env),
    listHomepageAnchors(env),
    getUiStrings(env)
  ]);

  const contactEmail = (settings.contact_email && settings.contact_email.trim()) || env.CONTACT_EMAIL || "";
  const hasContact = Boolean(contactEmail);
  const visibility = { counts, hasContact };
  const path = url.pathname;

  const anchors = liveAnchors(anchorRows, counts, hasContact);
  const visible = links.filter((l) => {
    if (!isLinkVisible(l.visible_when, visibility)) return false;
    const anchor = anchorOf(l.href);
    if (anchor !== null && !anchors.has(anchor)) return false;
    return isLiveHref(l.href, { counts });
  });
  const byPlacement = (p) =>
    visible
      .filter((l) => l.placement === p)
      .map((l) => ({ label: l.label, href: safeUrl(l.href) }))
      .filter((l) => l.href);

  const navMain = byPlacement("header").map((l) => ({ ...l, active: isActive(l.href, path) }));
  const navCta = byPlacement("header_cta").map((l, i, arr) => ({ ...l, is_primary: i === arr.length - 1 }));
  const footerColumns = FOOTER_COLUMNS.map((c) => ({ title: ui[c.titleKey] || "", links: byPlacement(c.placement) })).filter(
    (c) => c.links.length
  );

  const name = (settings.site_name && settings.site_name.trim()) || "Lummet";
  const logo = safeUrl(settings.logo_url);

  // Where "talk to us" links should go: the contact form if one is published,
  // otherwise a mailto link if an address is configured, otherwise nowhere.
  const contactUrl = counts.formKeys.has("contact") ? "/contact" : hasContact ? `mailto:${contactEmail}` : "";

  return {
    settings,
    counts,
    ui,
    site: {
      contact_url: contactUrl,
      has_contact_url: Boolean(contactUrl),
      name,
      title: (settings.site_title && settings.site_title.trim()) || name,
      description: (settings.site_description && settings.site_description.trim()) || "",
      base_url: baseUrlFor(settings, url),
      og_image: safeUrl(settings.og_image),
      logo_url: logo,
      has_logo: Boolean(logo),
      initials: initials(name),
      accent_css: accentCss(settings),
      footer_text: (settings.footer_text && settings.footer_text.trim()) || "",
      contact_email: contactEmail,
      has_contact: hasContact,
      year: new Date().getUTCFullYear(),
      nav_main: navMain,
      nav_cta: navCta,
      nav_mobile_all: [...navMain, ...navCta],
      footer_columns: footerColumns,
      has_footer_columns: footerColumns.length > 0
    },
    icons: {
      menu: iconSvg("menu", { size: 22 }),
      close: iconSvg("x", { size: 22 }),
      sun: iconSvg("sun", { size: 18 }),
      moon: iconSvg("moon", { size: 18 }),
      arrow: iconSvg("arrow-right", { size: 18 }),
      external: iconSvg("external", { size: 16 }),
      calendar: iconSvg("calendar", { size: 16 }),
      clock: iconSvg("clock", { size: 16 }),
      link: iconSvg("link", { size: 16 })
    }
  };
}

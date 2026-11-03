// =====================================================
// SITES ON THE PUBLIC BRANDS PAGE ("Powered by Lummet")
//
// Every site that goes live gets a brand profile on lummet.com/brands, and the staff dashboard's brand band lists the same rows.
// sites.transitionSiteStatus() calls syncSiteBrand() after each status change, so the listing follows the site:
//   active (first time)         -> created as an UNPUBLISHED draft: nothing is shown publicly until an admin publishes it
//   suspended / deleting / ...  -> a published brand is taken offline, flagged auto_hidden so reactivation can restore it
//   active again               -> only a brand the system itself took offline is restored; drafts stay drafts
// Staff can edit any row under Lummet Site > Brand profiles; the sync never rewrites a name, logo, tagline or description, it only
// creates the draft row and takes a published one offline / restores it. Organizations that pay to hide Lummet branding (white label) are never listed.
//
// Best effort by design: a failure here must never block or roll back a site's status change, so every error is logged and swallowed.
// =====================================================

import * as brands from "./repositories/brands.js";

export const BRAND_CATEGORY = "Powered by Lummet";
const LIVE_STATUSES = new Set(["active"]);

export function brandSlugFor(site) {
  // Accent-folded, url-safe, capped: matches how /brands/:slug is routed.
  return String(site.slug || site.name || "site").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "site";
}

/** First free slug: the base, then base-<site id>, then base-<site id>-2, -3 ... (a taken suffixed slug must not silently skip the listing). */
async function freeSlug(env, site) {
  const base = brandSlugFor(site);
  const tag = String(site.id || "").replace(/[^a-z0-9]/gi, "").slice(0, 6).toLowerCase() || "x";
  for (const candidate of [base, `${base}-${tag}`, ...Array.from({ length: 8 }, (_, i) => `${base}-${tag}-${i + 2}`)]) {
    if (!(await brands.slugTaken(env, candidate))) return candidate;
  }
  return `${base}-${tag}-${Date.now().toString(36)}`;
}


/** Creates the draft brand row for a live site, or takes a published one offline / restores it. Returns { action } and never throws. */
export async function syncSiteBrand(env, siteId) {
  try {
    const site = await brands.getSiteForBrand(env, siteId);
    if (!site) return { action: "none", reason: "site_not_found" };

    const existing = await brands.findBySite(env, siteId);
    const visible = LIVE_STATUSES.has(site.status) && !(await brands.hidesLummetBranding(env, site.organization_id));
    const website = site.primary_domain ? `https://${site.primary_domain}` : null;

    if (!existing) {
      if (!visible) return { action: "none" };
      const slug = await freeSlug(env, site);
      const written = await brands.insertSiteBrand(env, {
        tenantId: site.tenant_id, name: site.name, slug, category: BRAND_CATEGORY, tagline: BRAND_CATEGORY, websiteUrl: website, siteId: site.id
      });
      // INSERT OR IGNORE swallows a unique-index clash (same site or tenant already listed): report it honestly.
      if (written === 0) return { action: "none", reason: "already_listed" };
      return { action: "created", slug };
    }

    if (visible && existing.status !== "published" && Number(existing.auto_hidden) === 1) {
      await brands.republish(env, existing.id, { tenantId: site.tenant_id, websiteUrl: website });
      return { action: "republished" };
    }
    if (visible && !existing.website_url && website) {
      await brands.fillWebsiteUrl(env, existing.id, website);
    }
    if (!visible && existing.status === "published") {
      await brands.autoHide(env, existing.id);
      return { action: "unpublished" };
    }
    return { action: "none" };
  } catch (error) {
    console.error(JSON.stringify({ msg: "site_brand_sync_failed", siteId, error: error?.message || String(error) }));
    return { action: "error" };
  }
}

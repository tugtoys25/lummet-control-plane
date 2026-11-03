// =====================================================
// SITES ON THE PUBLIC BRANDS PAGE ("Powered by Lummet")
//
// Every site that goes live gets a brand profile on lummet.com/brands, and the staff dashboard's brand band lists the same rows.
// sites.transitionSiteStatus() calls syncSiteBrand() after each status change, so the listing follows the site:
//   active                      -> published (created on the first time the site is live)
//   suspended / deleting / ...  -> taken offline, flagged auto_hidden so reactivation can restore it
// Staff can edit any row under Lummet Site > Brand profiles; the sync never rewrites a name, logo, tagline or description, it only
// creates the row and moves it between published and offline. Organizations that pay to hide Lummet branding (white label) are never listed.
//
// Best effort by design: a failure here must never block or roll back a site's status change, so every error is logged and swallowed.
// =====================================================

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
    const taken = await env.LUMMET_DB.prepare(`SELECT 1 AS x FROM lummet_brands WHERE slug = ?`).bind(candidate).first();
    if (!taken) return candidate;
  }
  return `${base}-${tag}-${Date.now().toString(36)}`;
}

async function hidesLummetBranding(env, organizationId) {
  const row = await env.LUMMET_DB.prepare(`SELECT hide_lummet_branding FROM organization_branding WHERE organization_id = ?`).bind(organizationId).first();
  return Boolean(row && Number(row.hide_lummet_branding) === 1);
}

/** Creates, publishes or takes offline the brand row for one site. Returns { action } and never throws. */
export async function syncSiteBrand(env, siteId) {
  try {
    const site = await env.LUMMET_DB.prepare(
      `SELECT id, organization_id, tenant_id, name, slug, status, primary_domain FROM sites WHERE id = ?`
    ).bind(siteId).first();
    if (!site) return { action: "none", reason: "site_not_found" };

    const existing = await env.LUMMET_DB.prepare(`SELECT id, status, auto_hidden, website_url FROM lummet_brands WHERE site_id = ?`).bind(siteId).first();
    const visible = LIVE_STATUSES.has(site.status) && !(await hidesLummetBranding(env, site.organization_id));
    const website = site.primary_domain ? `https://${site.primary_domain}` : null;

    if (!existing) {
      if (!visible) return { action: "none" };
      const slug = await freeSlug(env, site);
      const ins = await env.LUMMET_DB.prepare(
        `INSERT OR IGNORE INTO lummet_brands (tenant_id, name, slug, tagline, category, website_url, status, sort_order, source, site_id)
         VALUES (?, ?, ?, ?, ?, ?, 'published', 100, 'site', ?)`
      ).bind(site.tenant_id || null, site.name, slug, BRAND_CATEGORY, BRAND_CATEGORY, website, site.id).run();
      // INSERT OR IGNORE swallows a unique-index clash (same site or tenant already listed): report it honestly.
      if (ins?.meta && ins.meta.changes === 0) return { action: "none", reason: "already_listed" };
      return { action: "created", slug };
    }

    if (visible && existing.status !== "published" && Number(existing.auto_hidden) === 1) {
      await env.LUMMET_DB.prepare(
        `UPDATE lummet_brands SET status = 'published', auto_hidden = 0, tenant_id = COALESCE(?, tenant_id), website_url = COALESCE(website_url, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).bind(site.tenant_id || null, website, existing.id).run();
      return { action: "republished" };
    }
    if (visible && !existing.website_url && website) {
      await env.LUMMET_DB.prepare(`UPDATE lummet_brands SET website_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND (website_url IS NULL OR website_url = '')`).bind(website, existing.id).run();
    }
    if (!visible && existing.status === "published") {
      await env.LUMMET_DB.prepare(`UPDATE lummet_brands SET status = 'draft', auto_hidden = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(existing.id).run();
      return { action: "unpublished" };
    }
    return { action: "none" };
  } catch (error) {
    console.error(JSON.stringify({ msg: "site_brand_sync_failed", siteId, error: error?.message || String(error) }));
    return { action: "error" };
  }
}

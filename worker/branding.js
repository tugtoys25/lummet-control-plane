// =====================================================
// WHITE-LABEL BRANDING (master prompt section 35)
//
// One row per organization. Gated on the existing
// white_label.enabled entitlement (migration 0006) — no new
// entitlement key was needed for this.
// =====================================================

import { checkEntitlement } from "./entitlements.js";

function isHttpsUrl(value) {
  if (!value) return true; // optional fields — absent is fine
  try {
    return new URL(value).protocol === "https:";
  } catch (_) {
    return false;
  }
}

export async function getBranding(env, organizationId) {
  const row = await env.LUMMET_DB.prepare(`SELECT * FROM organization_branding WHERE organization_id = ?`)
    .bind(organizationId)
    .first();

  return (
    row || {
      organization_id: organizationId,
      brand_name: null,
      logo_url: null,
      favicon_url: null,
      primary_color: null,
      support_url: null,
      hide_lummet_branding: 0
    }
  );
}

/**
 * Refuses outright for an organization without white_label.enabled —
 * never silently accepts the write and just fails to apply it later
 * (rule #5). Logo/favicon/support URLs must be https or absent, same
 * validation posture as webhooks.js's URL check.
 */
export async function updateBranding(env, organizationId, updates) {
  const entitled = await checkEntitlement(env, organizationId, "white_label.enabled");
  if (entitled !== true) {
    return { ok: false, status: 403, error: "not_entitled" };
  }

  for (const field of ["logoUrl", "faviconUrl", "supportUrl"]) {
    if (updates[field] !== undefined && !isHttpsUrl(updates[field])) {
      return { ok: false, status: 422, error: `${field}_must_be_https` };
    }
  }

  const existing = await env.LUMMET_DB.prepare(`SELECT organization_id FROM organization_branding WHERE organization_id = ?`)
    .bind(organizationId)
    .first();

  const brandName = updates.brandName !== undefined ? updates.brandName : null;
  const logoUrl = updates.logoUrl !== undefined ? updates.logoUrl : null;
  const faviconUrl = updates.faviconUrl !== undefined ? updates.faviconUrl : null;
  const primaryColor = updates.primaryColor !== undefined ? updates.primaryColor : null;
  const supportUrl = updates.supportUrl !== undefined ? updates.supportUrl : null;
  const hideLummetBranding = updates.hideLummetBranding ? 1 : 0;

  if (existing) {
    await env.LUMMET_DB.prepare(
      `UPDATE organization_branding SET brand_name = ?, logo_url = ?, favicon_url = ?, primary_color = ?, support_url = ?, hide_lummet_branding = ?, updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = ?`
    )
      .bind(brandName, logoUrl, faviconUrl, primaryColor, supportUrl, hideLummetBranding, organizationId)
      .run();
  } else {
    await env.LUMMET_DB.prepare(
      `INSERT INTO organization_branding (organization_id, brand_name, logo_url, favicon_url, primary_color, support_url, hide_lummet_branding)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(organizationId, brandName, logoUrl, faviconUrl, primaryColor, supportUrl, hideLummetBranding)
      .run();
  }

  return { ok: true };
}

// =====================================================
// WHITE-LABEL BRANDING (master prompt section 35)
//
// One row per organization. Gated on the existing
// white_label.enabled entitlement (migration 0006) — no new
// entitlement key was needed for this.
// =====================================================

import * as brandingRepo from "./repositories/branding.js";
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
  const row = await brandingRepo.find(env, organizationId);

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

  const existing = await brandingRepo.exists(env, organizationId);

  const brandName = updates.brandName !== undefined ? updates.brandName : null;
  const logoUrl = updates.logoUrl !== undefined ? updates.logoUrl : null;
  const faviconUrl = updates.faviconUrl !== undefined ? updates.faviconUrl : null;
  const primaryColor = updates.primaryColor !== undefined ? updates.primaryColor : null;
  const supportUrl = updates.supportUrl !== undefined ? updates.supportUrl : null;
  const hideLummetBranding = updates.hideLummetBranding ? 1 : 0;

  const values = { brandName, logoUrl, faviconUrl, primaryColor, supportUrl, hideLummetBranding };
  if (existing) await brandingRepo.update(env, organizationId, values);
  else await brandingRepo.insert(env, organizationId, values);

  return { ok: true };
}

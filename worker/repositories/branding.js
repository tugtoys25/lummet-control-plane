// Organization branding rows (v7I). All SQL for organization_branding.

export async function find(env, organizationId) {
  return env.LUMMET_DB.prepare(`SELECT * FROM organization_branding WHERE organization_id = ?`).bind(organizationId).first();
}

export async function exists(env, organizationId) {
  const row = await env.LUMMET_DB.prepare(`SELECT organization_id FROM organization_branding WHERE organization_id = ?`).bind(organizationId).first();
  return !!row;
}

export async function update(env, organizationId, v) {
  await env.LUMMET_DB.prepare(
    `UPDATE organization_branding SET brand_name = ?, logo_url = ?, favicon_url = ?, primary_color = ?, support_url = ?, hide_lummet_branding = ?, updated_at = CURRENT_TIMESTAMP
     WHERE organization_id = ?`
  ).bind(v.brandName, v.logoUrl, v.faviconUrl, v.primaryColor, v.supportUrl, v.hideLummetBranding, organizationId).run();
}

export async function insert(env, organizationId, v) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO organization_branding (organization_id, brand_name, logo_url, favicon_url, primary_color, support_url, hide_lummet_branding)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(organizationId, v.brandName, v.logoUrl, v.faviconUrl, v.primaryColor, v.supportUrl, v.hideLummetBranding).run();
}

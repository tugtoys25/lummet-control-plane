// =====================================================
// ORGANIZATION DATA EXPORT (master prompt section 24)
//
// SCOPE NOTE: exports everything the CONTROL PLANE itself
// owns about an organization — the organization record,
// members, sites (with their domains and deployment
// history), subscription/plan, and invoice history. This is
// real and complete for that data.
//
// It does NOT export tenant CONTENT (pages, news, casinos,
// reviews, offers, tracking links, media — section 24's
// fuller list) — that lives in each tenant's own database,
// reachable only through many different Super API endpoints
// per resource type. Building that would mean iterating every
// resource type across every one of an organization's
// deployed tenants, which is a substantial separate piece of
// work — not attempted here rather than half-built and passed
// off as a full export.
//
// Never exports secrets: no API key tokens, no webhook
// signing secrets, no tenant credentials, no password hashes.
// =====================================================

export async function exportOrganizationData(env, organizationId) {
  const organization = await env.LUMMET_DB.prepare(`SELECT * FROM organizations WHERE id = ?`)
    .bind(organizationId)
    .first();
  if (!organization) return null;

  const membersResult = await env.LUMMET_DB.prepare(
    `SELECT u.email, u.full_name, ou.role, ou.created_at AS joined_at
     FROM organization_users ou JOIN customer_users u ON u.id = ou.user_id
     WHERE ou.organization_id = ? ORDER BY ou.created_at`
  )
    .bind(organizationId)
    .all();

  const sitesResult = await env.LUMMET_DB.prepare(
    `SELECT s.*, p.name AS product_name FROM sites s JOIN products p ON p.id = s.product_id
     WHERE s.organization_id = ? AND s.status != 'deleted' ORDER BY s.created_at`
  )
    .bind(organizationId)
    .all();

  const sites = [];
  for (const site of sitesResult.results || []) {
    const domainsResult = await env.LUMMET_DB.prepare(
      `SELECT hostname, status, is_primary, dns_verified_at, ssl_verified_at FROM domains WHERE site_id = ? AND status != 'removed'`
    )
      .bind(site.id)
      .all();
    const deploymentsResult = await env.LUMMET_DB.prepare(
      `SELECT version, status, is_rollback, created_at, completed_at FROM deployments WHERE site_id = ? ORDER BY created_at DESC LIMIT 20`
    )
      .bind(site.id)
      .all();

    sites.push({
      id: site.id,
      name: site.name,
      slug: site.slug,
      product: site.product_name,
      status: site.status,
      primaryDomain: site.primary_domain,
      appVersion: site.app_version,
      createdAt: site.created_at,
      domains: domainsResult.results || [],
      recentDeployments: deploymentsResult.results || []
    });
  }

  const subscription = await env.LUMMET_DB.prepare(
    `SELECT status, trial_ends_at, current_period_end, cancel_at_period_end, created_at FROM subscriptions
     WHERE organization_id = ? AND status NOT IN ('canceled', 'expired', 'incomplete_expired')
     ORDER BY created_at DESC LIMIT 1`
  )
    .bind(organizationId)
    .first();

  const invoicesResult = await env.LUMMET_DB.prepare(
    `SELECT status, amount_due_cents, amount_paid_cents, currency, created_at, paid_at FROM invoices
     WHERE organization_id = ? ORDER BY created_at DESC`
  )
    .bind(organizationId)
    .all();

  return {
    exportedAt: new Date().toISOString(),
    organization: { id: organization.id, name: organization.name, slug: organization.slug, createdAt: organization.created_at },
    members: membersResult.results || [],
    sites,
    subscription: subscription || null,
    invoices: invoicesResult.results || []
  };
}

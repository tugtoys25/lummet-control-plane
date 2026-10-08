// =====================================================
// GLOBAL SEARCH (master prompt section 32)
//
// SCOPE NOTE: searches only what the control plane itself
// owns — sites, domains, team members. Tenant CONTENT
// (casinos, reviews, news, pages — section 32's fuller list)
// lives in each tenant's own database and isn't indexed
// anywhere centrally; searching it would mean fanning this
// query out to every one of an organization's tenant Super
// APIs, which no tenant endpoint currently supports as a
// single search call. Not built here — see the completion
// report.
//
// Every result is already implicitly scoped to one
// organization by the WHERE clause — never returns a record
// the caller isn't authorized to see (section 32's own
// requirement), since the route handler only ever calls this
// with an organizationId the customer is a verified member of.
// =====================================================

export async function searchOrganization(env, organizationId, query) {
  const trimmed = (query || "").trim();
  if (!trimmed) return { sites: [], domains: [], members: [] };

  const likeTerm = `%${trimmed}%`;

  const sitesResult = await env.LUMMET_DB.prepare(
    `SELECT id, name, slug, status FROM sites
     WHERE organization_id = ? AND status != 'deleted' AND (name LIKE ? OR slug LIKE ?)
     ORDER BY name LIMIT 20`
  )
    .bind(organizationId, likeTerm, likeTerm)
    .all();

  const domainsResult = await env.LUMMET_DB.prepare(
    `SELECT d.id, d.hostname, d.status, d.site_id, s.name AS site_name FROM domains d
     JOIN sites s ON s.id = d.site_id
     WHERE s.organization_id = ? AND d.status != 'removed' AND d.hostname LIKE ?
     ORDER BY d.hostname LIMIT 20`
  )
    .bind(organizationId, likeTerm)
    .all();

  const membersResult = await env.LUMMET_DB.prepare(
    `SELECT u.id, u.email, u.full_name, ou.role FROM organization_users ou
     JOIN customer_users u ON u.id = ou.user_id
     WHERE ou.organization_id = ? AND (u.email LIKE ? OR u.full_name LIKE ?)
     ORDER BY u.email LIMIT 20`
  )
    .bind(organizationId, likeTerm, likeTerm)
    .all();

  return {
    sites: sitesResult.results || [],
    domains: domainsResult.results || [],
    members: membersResult.results || []
  };
}

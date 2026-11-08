// Active products for the customer-facing lists (site types and plan families). All SQL for them lives here.

/**
 * scope: "all" | "site_types" | "plan_families" (migration 0089 switches). Falls back to the original query when the
 * migration is not applied yet, so a deploy never breaks the site picker or the plan chooser.
 */
export async function listActiveProducts(env, scope = "all") {
  const where = scope === "site_types" ? " AND show_in_site_creation = 1" : scope === "plan_families" ? " AND show_on_pricing = 1" : "";
  try {
    const r = await env.LUMMET_DB.prepare(`SELECT * FROM products WHERE status = 'active'${where} ORDER BY sort_order, category, COALESCE(public_name, name)`).all();
    return (r.results || []).map((p) => ({ ...p, staff_name: p.name, name: p.public_name || p.name }));
  } catch {
    const r = await env.LUMMET_DB.prepare(`SELECT * FROM products WHERE status = 'active' ORDER BY category, name`).all();
    return r.results || [];
  }
}

// Provider customer records. (Repository: SQL for billing_customers lookups.)

export async function findProviderCustomerId(env, organizationId, provider) {
  const row = await env.LUMMET_DB.prepare(
    `SELECT provider_customer_id FROM billing_customers WHERE organization_id = ? AND provider = ?`
  ).bind(organizationId, provider).first();
  return row ? row.provider_customer_id : null;
}

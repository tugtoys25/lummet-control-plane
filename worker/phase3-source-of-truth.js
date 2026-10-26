// Phase 3 source-of-truth services. Stripe is authoritative for money; Lummet remains authoritative for access.
// All writes are idempotent and drift is surfaced rather than silently overwriting customer state.
import { planIdForPrice } from "./plan-prices.js";

const id = () => crypto.randomUUID();
const jsonValue = (v) => v === null || v === undefined ? null : String(v);

export async function saveBillingProfile(env, organizationId, input) {
  if (!organizationId) throw new TypeError("organizationId is required");
  const allowed = ["legal_name","billing_email","address_line1","address_line2","city","region","postal_code","country","tax_exempt","po_number","stripe_customer_id"];
  const v = Object.fromEntries(allowed.map(k => [k, input?.[k] ?? null]));
  if (v.billing_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.billing_email)) throw new TypeError("billing_email is invalid");
  if (v.country && !/^[A-Za-z]{2}$/.test(v.country)) throw new TypeError("country must be a two-letter ISO code");
  await env.LUMMET_DB.prepare(`INSERT INTO organization_billing_profiles
    (organization_id, legal_name, billing_email, address_line1, address_line2, city, region, postal_code, country, tax_id_type, tax_id, tax_exempt, po_number, stripe_customer_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(organization_id) DO UPDATE SET legal_name=excluded.legal_name, billing_email=excluded.billing_email,
    address_line1=excluded.address_line1, address_line2=excluded.address_line2, city=excluded.city, region=excluded.region,
    postal_code=excluded.postal_code, country=excluded.country, tax_exempt=excluded.tax_exempt, po_number=excluded.po_number, stripe_customer_id=excluded.stripe_customer_id,
    updated_at=CURRENT_TIMESTAMP`).bind(organizationId, v.legal_name, v.billing_email, v.address_line1, v.address_line2, v.city, v.region, v.postal_code, v.country?.toUpperCase() || null, null, null, v.tax_exempt ? 1 : 0, v.po_number, v.stripe_customer_id).run();
  return await env.LUMMET_DB.prepare("SELECT * FROM organization_billing_profiles WHERE organization_id = ?").bind(organizationId).first();
}

export async function recordDrift(env, finding) {
  const existing = await env.LUMMET_DB.prepare("SELECT id FROM reconciliation_findings WHERE organization_id=? AND subscription_id IS ? AND field=? AND status='open'")
    .bind(finding.organizationId, finding.subscriptionId ?? null, finding.field).first();
  if (existing) {
    await env.LUMMET_DB.prepare("UPDATE reconciliation_findings SET lummet_value=?, stripe_value=?, found_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(jsonValue(finding.lummetValue), jsonValue(finding.stripeValue), existing.id).run();
    return existing.id;
  }
  // A deliberate "keep Lummet" decision should not create the same alert every day. Reopen only if either side changed.
  const prior = await env.LUMMET_DB.prepare(`SELECT id, status, lummet_value, stripe_value FROM reconciliation_findings
    WHERE organization_id=? AND subscription_id IS ? AND field=? ORDER BY found_at DESC LIMIT 1`)
    .bind(finding.organizationId, finding.subscriptionId ?? null, finding.field).first();
  if (prior?.status === "kept_lummet" && prior.lummet_value === jsonValue(finding.lummetValue) && prior.stripe_value === jsonValue(finding.stripeValue)) return null;
  const findingId = id();
  await env.LUMMET_DB.prepare("INSERT INTO reconciliation_findings (id, organization_id, subscription_id, field, lummet_value, stripe_value) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(findingId, finding.organizationId, finding.subscriptionId ?? null, finding.field, jsonValue(finding.lummetValue), jsonValue(finding.stripeValue)).run();
  return findingId;
}

export async function resolveDrift(env, { findingId, decision, actorId, reason }) {
  if (!["accept_stripe","keep_lummet"].includes(decision)) throw new TypeError("decision must be accept_stripe or keep_lummet");
  if (!actorId || !reason?.trim()) throw new TypeError("actorId and resolution reason are required");
  const finding = await env.LUMMET_DB.prepare("SELECT * FROM reconciliation_findings WHERE id=? AND status='open'").bind(findingId).first();
  if (!finding) throw new Error("finding not found or already resolved");
  if (decision === "accept_stripe") {
    if (!finding.subscription_id) throw new Error("finding has no subscription to reconcile");
    const sub = await env.LUMMET_DB.prepare("SELECT id FROM subscriptions WHERE id=? AND organization_id=?").bind(finding.subscription_id, finding.organization_id).first();
    if (!sub) throw new Error("finding subscription not found");
    const value = finding.stripe_value;
    if (finding.field === "status") {
      const allowed = new Set(["trialing","active","past_due","canceled","unpaid","incomplete","incomplete_expired","paused","expired"]);
      if (!allowed.has(value)) throw new Error("Stripe status is not an allowed local subscription status");
      await env.LUMMET_DB.prepare("UPDATE subscriptions SET status=?, stripe_status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(value, value, sub.id).run();
    } else if (finding.field === "price_id") {
      const planId = await planIdForPrice(env, value);
      if (!planId) throw new Error("Stripe price is not mapped to a Lummet plan; sync the catalog first");
      await env.LUMMET_DB.prepare("UPDATE subscriptions SET plan_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(planId, sub.id).run();
    } else if (finding.field === "current_period_end") {
      await env.LUMMET_DB.prepare("UPDATE subscriptions SET current_period_end=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(value, sub.id).run();
    } else if (finding.field === "cancel_at_period_end") {
      if (!["true","false","1","0"].includes(String(value))) throw new Error("invalid Stripe cancellation flag");
      await env.LUMMET_DB.prepare("UPDATE subscriptions SET cancel_at_period_end=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(["true","1"].includes(String(value)) ? 1 : 0, sub.id).run();
    } else throw new Error("unsupported drift field");
  }
  const status = decision === "accept_stripe" ? "accepted_stripe" : "kept_lummet";
  const result = await env.LUMMET_DB.prepare("UPDATE reconciliation_findings SET status=?, resolved_at=CURRENT_TIMESTAMP, resolved_by=?, resolution_reason=? WHERE id=? AND status='open'")
    .bind(status, actorId, reason.trim().slice(0,1000), findingId).run();
  if (!(result.meta?.changes > 0)) throw new Error("finding not found or already resolved");
  return { findingId, status };
}

// `fetchSubscription` is injected to keep tests offline and to make provider failures explicit.
export async function reconcileSubscriptions(env, { fetchSubscription, limit = 100, afterId = "" }) {
  if (typeof fetchSubscription !== "function") throw new TypeError("fetchSubscription is required");
  const rows = await env.LUMMET_DB.prepare(`SELECT id, organization_id, provider_subscription_id, plan_id, status, current_period_end, cancel_at_period_end
    FROM subscriptions WHERE provider_subscription_id IS NOT NULL AND provider_subscription_id <> '' AND id > ? ORDER BY id LIMIT ?`).bind(afterId, Math.max(1, Math.min(500, limit))).all();
  const findings = [];
  for (const row of rows.results || []) {
    // Do not swallow network/rate-limit failures: the scheduler should report failure and retry on the next run.
    const stripe = await fetchSubscription(row.provider_subscription_id);
    const priceId = stripe.items?.data?.[0]?.price?.id || null;
    const localPrice = await env.LUMMET_DB.prepare(`SELECT pp.stripe_price_id FROM subscriptions s LEFT JOIN plan_prices pp ON pp.plan_id=s.plan_id AND pp.active=1
      WHERE s.id=? ORDER BY pp.created_at DESC LIMIT 1`).bind(row.id).first();
    const mappedRemotePlanId = priceId ? await planIdForPrice(env, priceId) : null;
    // Retired price versions remain valid for existing subscribers. A price is drift only when it is unknown or maps to a different plan.
    const expectedPriceForDrift = mappedRemotePlanId === row.plan_id ? priceId : (localPrice?.stripe_price_id ?? null);
    const values = [
      ["status", row.status, stripe.status],
      ["price_id", expectedPriceForDrift, priceId],
      ["current_period_end", row.current_period_end, stripe.current_period_end ? new Date(stripe.current_period_end*1000).toISOString() : null],
      ["cancel_at_period_end", Boolean(row.cancel_at_period_end), Boolean(stripe.cancel_at_period_end)]
    ];
    for (const [field, local, remote] of values) {
      if (jsonValue(local) !== jsonValue(remote)) {
        const findingId = await recordDrift(env, { organizationId: row.organization_id, subscriptionId: row.id, field, lummetValue: local, stripeValue: remote });
        if (findingId) findings.push({ id: findingId, organizationId: row.organization_id, field });
      }
    }
  }
  return { checked: rows.results?.length || 0, findings, nextCursor: rows.results?.length === Math.max(1, Math.min(500, limit)) ? rows.results.at(-1).id : null };
}

export async function listDrift(env, { status = "open", limit = 50, offset = 0 } = {}) {
  const allowed = new Set(["open","accepted_stripe","kept_lummet","resolved"]);
  const selected = allowed.has(status) ? status : "open";
  const rows = await env.LUMMET_DB.prepare(`SELECT rf.*, o.name AS organization_name, s.provider_subscription_id FROM reconciliation_findings rf JOIN organizations o ON o.id=rf.organization_id LEFT JOIN subscriptions s ON s.id=rf.subscription_id WHERE rf.status=? ORDER BY rf.found_at DESC LIMIT ? OFFSET ?`).bind(selected, Math.max(1,Math.min(100,limit)),Math.max(0,offset)).all();
  return rows.results || [];
}

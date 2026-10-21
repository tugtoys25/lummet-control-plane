// =====================================================
// STAFF SAAS OPERATIONS (master prompt section 45)
// Data + actions behind the /platform/saas/* super-admin screens.
// Every mutating function returns {ok, ...} and the route layer
// audits it — staff actions never bypass audit logging.
// =====================================================
import * as domainZonesRepo from "./repositories/domain-zones.js";
import * as orgLifecycle from "./repositories/org-lifecycle.js";
import * as couponRepo from "./repositories/coupons.js";
import * as sites from "./sites.js";
import * as entitlementsService from "./entitlements.js";
import { addCredits, getBalance } from "./ai-credits.js";
import { getMonthlyUsage } from "./usage.js";
import * as jobsModule from "./jobs.js";
import { outboxStats } from "./email.js";

const like = (q) => `%${String(q || "").trim().replace(/[%_]/g, "")}%`;

export async function listOrganizations(env, { q = "", status = "", limit = 50, offset = 0 } = {}) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT o.id, o.name, o.slug, o.status, o.created_at,
       (SELECT COUNT(*) FROM organization_users WHERE organization_id = o.id) AS members,
       (SELECT COUNT(*) FROM sites WHERE organization_id = o.id AND status != 'deleted') AS sites,
       (SELECT p.name || ' (' || s.status || ')' FROM subscriptions s JOIN plans p ON p.id = s.plan_id
          WHERE s.organization_id = o.id ORDER BY s.created_at DESC LIMIT 1) AS subscription
     FROM organizations o
     WHERE (o.name LIKE ? OR o.slug LIKE ? OR o.id = ?) AND (? = '' OR o.status = ?)
     ORDER BY o.created_at DESC, o.id LIMIT ? OFFSET ?`
  ).bind(like(q), like(q), String(q).trim(), status, status, Math.min(limit, 200), off(offset)).all();
  return r.results;
}

export async function getOrganizationDetail(env, organizationId) {
  const org = await env.LUMMET_DB.prepare(`SELECT * FROM organizations WHERE id = ?`).bind(organizationId).first();
  if (!org) return null;
  const [members, orgSites, subs, overrides, entitlements, usage, ai, jobs] = await Promise.all([
    env.LUMMET_DB.prepare(`SELECT u.email, ou.role, ou.created_at FROM organization_users ou JOIN customer_users u ON u.id = ou.user_id WHERE ou.organization_id = ? ORDER BY ou.created_at`).bind(organizationId).all(),
    env.LUMMET_DB.prepare(`SELECT id, name, status, suspension_reason, created_at FROM sites WHERE organization_id = ? ORDER BY created_at`).bind(organizationId).all(),
    env.LUMMET_DB.prepare(`SELECT s.id, s.status, s.trial_ends_at, s.current_period_end, s.created_at, p.name AS plan, p.key AS plan_key FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.organization_id = ? ORDER BY s.created_at DESC`).bind(organizationId).all(),
    env.LUMMET_DB.prepare(`SELECT o.subscription_id, o.key, o.value, o.reason FROM subscription_entitlement_overrides o JOIN subscriptions s ON s.id = o.subscription_id WHERE s.organization_id = ?`).bind(organizationId).all(),
    entitlementsService.resolveForOrganization(env, organizationId),
    getMonthlyUsage(env, organizationId),
    getBalance(env, organizationId),
    env.LUMMET_DB.prepare(`SELECT id, type, status, progress, error_message, created_at FROM jobs WHERE organization_id = ? ORDER BY created_at DESC LIMIT 10`).bind(organizationId).all()
  ]);
  return { org, members: members.results, sites: orgSites.results, subscriptions: subs.results, overrides: overrides.results, entitlements, usage, aiBalance: ai, jobs: jobs.results };
}

export async function setOrganizationStatus(env, organizationId, status, reason) {
  if (!["active", "suspended", "closed"].includes(status)) return { ok: false, status: 422, error: "invalid_status" };
  const org = await env.LUMMET_DB.prepare(`SELECT id, status, scheduled_deletion_at, erased_at FROM organizations WHERE id = ?`).bind(organizationId).first();
  if (!org) return { ok: false, status: 404, error: "not_found" };
  // An organization with an erasure scheduled must not look "active" while the sweep is still going to erase it.
  if (status === "active" && (org.scheduled_deletion_at || org.erased_at)) return { ok: false, status: 409, error: org.erased_at ? "organization_erased" : "deletion_scheduled_stop_it_first" };
  await env.LUMMET_DB.prepare(`UPDATE organizations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(status, organizationId).run();
  if (status !== "active") {
    // Invalidate customer sessions' access indirectly: routes check org status on every request.
    await env.LUMMET_DB.prepare(`UPDATE sites SET updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?`).bind(organizationId).run();
  }
  return { ok: true, from: org.status, to: status, reason: reason || null };
}

/** Staff stop a scheduled erasure before it runs (support request, mistaken or fraudulent closure). Never after erasure. */
export async function stopScheduledDeletion(env, organizationId) {
  const org = await orgLifecycle.findDeletionState(env, organizationId);
  if (!org) return { ok: false, status: 404, error: "not_found" };
  if (org.erased_at) return { ok: false, status: 409, error: "organization_erased" };
  if (!org.scheduled_deletion_at) return { ok: false, status: 409, error: "no_deletion_scheduled" };
  await orgLifecycle.clearScheduledDeletion(env, organizationId);
  return { ok: true, was: org.scheduled_deletion_at };
}

export async function setSiteStatus(env, siteId, toStatus, reason, staffId) {
  if (!["suspended", "active"].includes(toStatus)) return { ok: false, status: 422, error: "invalid_status" };
  return sites.transitionSiteStatus(env, siteId, toStatus, { reason, actorType: "lummet_admin", actorId: staffId });
}

const OVERRIDE_TYPES = new Set(["boolean", "number", "text"]);
export async function setEntitlementOverride(env, subscriptionId, key, valueType, value, reason) {
  if (!/^[a-z_]+(\.[a-z_]+)+$/.test(String(key))) return { ok: false, status: 422, error: "invalid_key" };
  if (!OVERRIDE_TYPES.has(valueType)) return { ok: false, status: 422, error: "invalid_value_type" };
  if (valueType === "number" && !/^-?\d+$/.test(String(value))) return { ok: false, status: 422, error: "invalid_number" };
  if (valueType === "boolean" && !["true", "false"].includes(String(value))) return { ok: false, status: 422, error: "invalid_boolean" };
  if (!reason || !String(reason).trim()) return { ok: false, status: 422, error: "reason_required" };
  const sub = await env.LUMMET_DB.prepare(`SELECT id FROM subscriptions WHERE id = ?`).bind(subscriptionId).first();
  if (!sub) return { ok: false, status: 404, error: "subscription_not_found" };
  await env.LUMMET_DB.prepare(
    `INSERT INTO subscription_entitlement_overrides (subscription_id, key, value_type, value, reason) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(subscription_id, key) DO UPDATE SET value_type = excluded.value_type, value = excluded.value, reason = excluded.reason`
  ).bind(subscriptionId, key, valueType, String(value), String(reason).trim()).run();
  return { ok: true };
}

export async function removeEntitlementOverride(env, subscriptionId, key) {
  const r = await env.LUMMET_DB.prepare(`DELETE FROM subscription_entitlement_overrides WHERE subscription_id = ? AND key = ?`).bind(subscriptionId, key).run();
  return r.meta.changes ? { ok: true } : { ok: false, status: 404, error: "not_found" };
}

export async function grantAiCredits(env, organizationId, amount, reason, staffId) {
  if (!reason || !String(reason).trim()) return { ok: false, status: 422, error: "reason_required" };
  const org = await env.LUMMET_DB.prepare(`SELECT id FROM organizations WHERE id = ?`).bind(organizationId).first();
  if (!org) return { ok: false, status: 404, error: "not_found" };
  return addCredits(env, organizationId, amount, { kind: "adjust", note: `staff ${staffId}: ${String(reason).trim()}`.slice(0, 300) });
}

export async function listPlansCatalog(env) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT p.id, p.key, p.name, p.billing_period, p.price_cents, p.currency, p.trial_days, p.status, p.stripe_price_id, pr.name AS product, pr.category,
       (SELECT COUNT(*) FROM subscriptions s WHERE s.plan_id = p.id AND s.status IN ('trialing','active','past_due')) AS live_subscriptions
     FROM plans p JOIN products pr ON pr.id = p.product_id ORDER BY pr.category, pr.name, p.price_cents`
  ).all();
  return r.results;
}

export async function updatePlan(env, planId, { priceCents, status, trialDays, stripePriceId }) {
  const plan = await env.LUMMET_DB.prepare(`SELECT * FROM plans WHERE id = ?`).bind(planId).first();
  if (!plan) return { ok: false, status: 404, error: "not_found" };
  const sets = [], vals = [];
  if (priceCents !== undefined) {
    if (priceCents !== null && (!Number.isInteger(priceCents) || priceCents < 0)) return { ok: false, status: 422, error: "invalid_price" };
    sets.push("price_cents = ?"); vals.push(priceCents);
  }
  if (status !== undefined) {
    if (!["active", "retired"].includes(status)) return { ok: false, status: 422, error: "invalid_status" };
    sets.push("status = ?"); vals.push(status);
  }
  if (trialDays !== undefined) {
    if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 90) return { ok: false, status: 422, error: "invalid_trial_days" };
    sets.push("trial_days = ?"); vals.push(trialDays);
  }
  if (stripePriceId !== undefined) {
    if (stripePriceId !== null && !/^price_[A-Za-z0-9]+$/.test(stripePriceId)) return { ok: false, status: 422, error: "invalid_stripe_price_id" };
    sets.push("stripe_price_id = ?"); vals.push(stripePriceId);
  }
  if (!sets.length) return { ok: false, status: 422, error: "nothing_to_update" };
  await env.LUMMET_DB.prepare(`UPDATE plans SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, planId).run();
  return { ok: true, before: { price_cents: plan.price_cents, status: plan.status, trial_days: plan.trial_days, stripe_price_id: plan.stripe_price_id } };
}

export async function listSubscriptions(env, { status = "", limit = 100, offset = 0 } = {}) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT s.id, s.status, s.trial_ends_at, s.current_period_end, s.created_at, o.id AS organization_id, o.name AS organization, p.name AS plan
     FROM subscriptions s JOIN organizations o ON o.id = s.organization_id JOIN plans p ON p.id = s.plan_id
     WHERE (? = '' OR s.status = ?) ORDER BY s.created_at DESC, s.id LIMIT ? OFFSET ?`
  ).bind(status, status, Math.min(limit, 500), off(offset)).all();
  return r.results;
}

export async function listJobs(env, { status = "", type = "", limit = 100, offset = 0 } = {}) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT j.id, j.type, j.status, j.progress, j.error_message, j.retry_count, j.auto_retries, j.dead_lettered_at, j.created_at, j.site_id, o.name AS organization
     FROM jobs j LEFT JOIN organizations o ON o.id = j.organization_id
     WHERE (? = '' OR j.status = ?) AND (? = '' OR j.type = ?) ORDER BY j.created_at DESC, j.id LIMIT ? OFFSET ?`
  ).bind(status, status, type, type, Math.min(limit, 500), off(offset)).all();
  return r.results;
}

export async function getJobDetail(env, jobId) {
  const job = await jobsModule.getJob(env, jobId);
  if (!job) return null;
  return { job, history: await jobsModule.getJobHistory(env, jobId) };
}

export async function opsSummary(env) {
  const one = (sql) => env.LUMMET_DB.prepare(sql).first();
  const [orgs, subs, failedJobs, failedSites, failedEmails, queuedEmails, stuck, mrr] = await Promise.all([
    one(`SELECT COUNT(*) n FROM organizations`),
    one(`SELECT COUNT(*) n FROM subscriptions WHERE status IN ('trialing','active','past_due')`),
    one(`SELECT COUNT(*) n FROM jobs WHERE status = 'failed'`),
    one(`SELECT COUNT(*) n FROM sites WHERE status = 'failed'`),
    one(`SELECT COUNT(*) n FROM email_outbox WHERE status = 'failed'`),
    one(`SELECT COUNT(*) n FROM email_outbox WHERE status = 'queued'`),
    one(`SELECT COUNT(*) n FROM jobs WHERE status IN ('queued','running') AND created_at < datetime('now','-30 minutes')`),
    one(`SELECT COALESCE(SUM(p.price_cents),0) n FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.status = 'active' AND p.billing_period = 'monthly'`)
  ]);
  return { organizations: orgs.n, liveSubscriptions: subs.n, failedJobs: failedJobs.n, failedSites: failedSites.n, failedEmails: failedEmails.n, queuedEmails: queuedEmails.n, stuckJobs: stuck.n, monthlyRecurringCents: mrr.n, email: await outboxStats(env) };
}

export async function listFailedEmails(env, limit = 50) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT id, to_email, template, attempts, last_error, created_at FROM email_outbox WHERE status = 'failed' ORDER BY created_at DESC LIMIT ?`
  ).bind(limit).all();
  return r.results;
}

export async function listStaffAuditForOrg(env, organizationId, limit = 50) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT created_at, actor_type, action, resource, resource_id, success, error_message FROM lummet_audit_logs WHERE organization_id = ? ORDER BY id DESC LIMIT ?`
  ).bind(organizationId, limit).all();
  return r.results;
}

// ---------------------------------------------------------
// Coupons (roadmap 1.5). The Stripe-side coupon must already exist:
// staff paste its id. This module records the rules Lummet enforces
// before a customer is sent to Stripe (expiry, limit, once per org)
// and never creates anything in Stripe itself.
// ---------------------------------------------------------
export async function listCoupons(env) {
  return couponRepo.list(env);
}

export async function createCoupon(env, input) {
  const code = String(input.code || "").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code)) return { ok: false, status: 422, error: "invalid_code" };
  const providerCouponId = String(input.providerCouponId || "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(providerCouponId)) return { ok: false, status: 422, error: "invalid_provider_coupon_id" };

  const hasPercent = input.percentOff != null && input.percentOff !== "";
  const hasAmount = input.amountOffCents != null && input.amountOffCents !== "";
  if (hasPercent === hasAmount) return { ok: false, status: 422, error: "percent_or_amount_required" };
  const percentOff = hasPercent ? Number(input.percentOff) : null;
  const amountOff = hasAmount ? Number(input.amountOffCents) : null;
  if (hasPercent && !(percentOff > 0 && percentOff <= 100)) return { ok: false, status: 422, error: "invalid_percent_off" };
  if (hasAmount && !(Number.isInteger(amountOff) && amountOff > 0)) return { ok: false, status: 422, error: "invalid_amount_off" };

  const duration = input.duration || "once";
  if (!["once", "repeating", "forever"].includes(duration)) return { ok: false, status: 422, error: "invalid_duration" };

  let maxRedemptions = null;
  if (input.maxRedemptions != null && input.maxRedemptions !== "") {
    maxRedemptions = Number(input.maxRedemptions);
    if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1) return { ok: false, status: 422, error: "invalid_max_redemptions" };
  }
  let expiresAt = null;
  if (input.expiresAt) {
    const d = new Date(input.expiresAt);
    if (Number.isNaN(d.getTime())) return { ok: false, status: 422, error: "invalid_expires_at" };
    if (d.getTime() <= Date.now()) return { ok: false, status: 422, error: "expires_at_in_past" };
    expiresAt = d.toISOString().replace("T", " ").slice(0, 19);
  }

  // Optional: restrict the code to one organization (partner-specific or one-off codes).
  let organizationId = null;
  if (input.organizationId != null && String(input.organizationId).trim() !== "") {
    organizationId = String(input.organizationId).trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(organizationId)) return { ok: false, status: 422, error: "invalid_organization_id" };
    const org = await couponRepo.findOrganization(env, organizationId);
    if (!org || org.erased_at) return { ok: false, status: 422, error: "organization_not_found" };
  }

  if (await couponRepo.codeExists(env, code)) return { ok: false, status: 409, error: "code_already_exists" };

  const id = crypto.randomUUID();
  await couponRepo.insert(env, { id, code, providerCouponId, percentOff, amountOff, duration, expiresAt, maxRedemptions, note: input.note ? String(input.note).slice(0, 300) : null, organizationId });
  return { ok: true, couponId: id };
}

/** Only enable/disable and the limit can change; the discount itself lives in Stripe and must not drift from it. The organization scope is fixed at creation: to change it, disable the coupon and create a new one. */
export async function updateCoupon(env, couponId, { status, maxRedemptions }) {
  const coupon = await couponRepo.findById(env, couponId);
  if (!coupon) return { ok: false, status: 404, error: "not_found" };
  const fields = {};
  if (status !== undefined) {
    if (!["active", "disabled"].includes(status)) return { ok: false, status: 422, error: "invalid_status" };
    fields.status = status;
  }
  if (maxRedemptions !== undefined) {
    if (maxRedemptions !== null && (!Number.isInteger(maxRedemptions) || maxRedemptions < coupon.redemption_count || maxRedemptions < 1)) {
      return { ok: false, status: 422, error: "invalid_max_redemptions" };
    }
    fields.maxRedemptions = maxRedemptions;
  }
  if (!Object.keys(fields).length) return { ok: false, status: 422, error: "nothing_to_update" };
  await couponRepo.update(env, couponId, fields);
  return { ok: true };
}

// ---------------------------------------------------------
// Cross-organization operational views (roadmap 1.4). Read-only
// except two safety actions: revoking an API key and disabling a
// webhook. Secrets (key hashes, webhook secrets, delivery payloads)
// are never selected.
// ---------------------------------------------------------
const cap = (n) => Math.min(Math.max(Number(n) || 100, 1), 500);
// Row offset for paging: a non-negative integer, bounded so a hand-edited URL can't ask for a huge scan.
const off = (n) => Math.min(Math.max(Math.floor(Number(n)) || 0, 0), 500000);

export async function listAllDomains(env, { status = "", limit = 100, offset = 0 } = {}) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT d.id, d.hostname, d.method, d.failure_reason, d.status, d.ssl_status, d.is_primary, d.created_at, d.dns_verified_at, s.id AS site_id, s.name AS site, o.id AS organization_id, o.name AS organization
     FROM domains d JOIN sites s ON s.id = d.site_id JOIN organizations o ON o.id = s.organization_id
     WHERE (? = '' OR d.status = ?) ORDER BY d.created_at DESC, d.id LIMIT ? OFFSET ?`
  ).bind(status, status, cap(limit), off(offset)).all();
  return r.results;
}

/** Delegated domains (nameserver flow) across all organizations, for the staff Domains screen. */
export async function listAllZones(env, opts = {}) {
  return (await domainZonesRepo.listAllForStaff(env, opts)).map((z) => ({ ...z, name_servers: JSON.parse(z.name_servers || "[]") }));
}

export async function listAllDeployments(env, { status = "", limit = 100, offset = 0 } = {}) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT dp.id, dp.version, dp.status, dp.is_rollback, dp.is_current, dp.error_message, dp.actor_type, dp.created_at, dp.completed_at, s.id AS site_id, s.name AS site, o.id AS organization_id, o.name AS organization
     FROM deployments dp JOIN sites s ON s.id = dp.site_id JOIN organizations o ON o.id = s.organization_id
     WHERE (? = '' OR dp.status = ?) ORDER BY dp.created_at DESC, dp.id LIMIT ? OFFSET ?`
  ).bind(status, status, cap(limit), off(offset)).all();
  return r.results;
}

export async function listAllWebhooks(env, { status = "", limit = 100, offset = 0 } = {}) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT w.id, w.url, w.status, w.event_types, w.created_at, o.id AS organization_id, o.name AS organization,
       (SELECT COUNT(*) FROM webhook_deliveries x WHERE x.webhook_id = w.id AND x.status = 'failed' AND x.created_at > datetime('now','-7 days')) AS failed_7d,
       (SELECT COUNT(*) FROM webhook_deliveries x WHERE x.webhook_id = w.id AND x.created_at > datetime('now','-7 days')) AS total_7d
     FROM webhooks w JOIN organizations o ON o.id = w.organization_id
     WHERE (? = '' OR w.status = ?) ORDER BY failed_7d DESC, w.created_at DESC, w.id LIMIT ? OFFSET ?`
  ).bind(status, status, cap(limit), off(offset)).all();
  return r.results.map((w) => ({ ...w, event_types: JSON.parse(w.event_types || "[]") }));
}

export async function setWebhookStatusAsStaff(env, webhookId, status) {
  if (!["active", "disabled"].includes(status)) return { ok: false, status: 422, error: "invalid_status" };
  const r = await env.LUMMET_DB.prepare(`UPDATE webhooks SET status = ? WHERE id = ?`).bind(status, webhookId).run();
  return r.meta.changes ? { ok: true } : { ok: false, status: 404, error: "not_found" };
}

export async function listAllApiKeys(env, { status = "", limit = 100, offset = 0 } = {}) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT k.id, k.name, k.key_prefix, k.scopes, k.status, k.created_at, k.last_used_at, k.expires_at, o.id AS organization_id, o.name AS organization
     FROM customer_api_keys k JOIN organizations o ON o.id = k.organization_id
     WHERE (? = '' OR k.status = ?) ORDER BY k.created_at DESC, k.id LIMIT ? OFFSET ?`
  ).bind(status, status, cap(limit), off(offset)).all();
  return r.results.map((k) => ({ ...k, scopes: JSON.parse(k.scopes || "[]") }));
}

export async function revokeApiKeyAsStaff(env, keyId) {
  const r = await env.LUMMET_DB.prepare(`UPDATE customer_api_keys SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'`).bind(keyId).run();
  if (r.meta.changes) return { ok: true };
  const exists = await env.LUMMET_DB.prepare(`SELECT id FROM customer_api_keys WHERE id = ?`).bind(keyId).first();
  return exists ? { ok: false, status: 409, error: "already_revoked" } : { ok: false, status: 404, error: "not_found" };
}

export async function listAllBackups(env, { status = "", limit = 100, offset = 0 } = {}) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT b.id, b.kind, b.status, b.size_bytes, b.verification_status, b.verified_at, b.error_message, b.created_at, s.id AS site_id, s.name AS site, o.id AS organization_id, o.name AS organization
     FROM site_backups b LEFT JOIN sites s ON s.id = b.site_id LEFT JOIN organizations o ON o.id = b.organization_id
     WHERE (? = '' OR b.status = ?) ORDER BY b.created_at DESC, b.id LIMIT ? OFFSET ?`
  ).bind(status, status, cap(limit), off(offset)).all();
  return r.results;
}

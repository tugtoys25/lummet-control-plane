// =====================================================
// SITES (SaaS lifecycle)
//
// Distinct from registry.js's `tenants` table — see
// migration 0006's header comment. A site here tracks what
// the CUSTOMER sees and owns; it is linked to a `tenants`
// row only once Phase 3 provisioning actually deploys a
// Worker/D1/KV/R2 for it (master prompt section 9).
// =====================================================

import { resolveCustomerChoice, hostFor, listChoosableDomains } from "./platform-domains.js";
import * as webhooks from "./webhooks.js";
import { evaluateWriteGate, refusalFor } from "./access.js";
import { syncSiteBrand } from "./site-brands.js";
import { planSetup, storeSetupRequest } from "./site-setup.js";
import * as siteLabels from "./site-labels.js";

export const SITE_STATUSES = [
  "pending",
  "provisioning",
  "provisioned",
  "configuring",
  "deploying",
  "active",
  "suspended",
  "maintenance",
  "failed",
  "deleting",
  "deleted"
];

// Which statuses may transition into which. Kept explicit and
// conservative rather than any-to-any, so a bug elsewhere can't
// silently skip states (e.g. pending -> active with no
// provisioning having actually run) — this is the state machine
// master prompt section 9/17 describes.
const ALLOWED_TRANSITIONS = {
  pending: ["provisioning", "failed", "deleting"],
  provisioning: ["provisioned", "failed", "deleting"],   // a site stuck mid-setup holds real resources; it must be deletable (its open jobs are cancelled first)
  provisioned: ["configuring", "failed", "deleting"],   // a site that stopped here (no release published) holds real resources; it must be deletable
  configuring: ["deploying", "failed", "deleting"],
  deploying: ["active", "failed", "deleting"],
  active: ["suspended", "maintenance", "deleting"],
  suspended: ["active", "deleting"],
  maintenance: ["active", "deleting"],
  failed: ["provisioning", "deleting"],
  deleting: ["deleted"],
  deleted: []
};

async function uniqueSlug(env, base) {
  let slug = base;
  let n = 1;
  while (await env.LUMMET_DB.prepare(`SELECT 1 FROM sites WHERE slug = ?`).bind(slug).first()) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

async function recordStatusEvent(env, { siteId, fromStatus, toStatus, reason, actorType, actorId }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO site_status_events (site_id, from_status, to_status, reason, actor_type, actor_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(siteId, fromStatus || null, toStatus, reason || null, actorType || "system", actorId || null)
    .run();
}

/** The refusal for an unusable address: why, what it would have been, and what the customer can pick instead. */
async function labelRefusal(env, { organizationId, label, domain, reason }) {
  const base = { ok: false, status: reason === "taken" ? 409 : 422, label, host: label && domain?.hostname ? hostFor({ slug: label }, domain) : null, reason, message: siteLabels.REASON_TEXT[reason] || siteLabels.REASON_TEXT.invalid };
  if (reason === "taken" || reason === "reserved") {
    const others = await listChoosableDomains(env, { organizationId });
    Object.assign(base, await siteLabels.suggestLabels(env, { label, domain, otherDomains: others }));
  }
  return { ...base, error: reason === "taken" ? "subdomain_taken" : reason === "reserved" ? "subdomain_reserved" : "invalid_subdomain" };
}

/**
 * Creates a site record in the "pending" state. This does NOT
 * provision any Cloudflare infrastructure — that is Phase 3
 * (automated provisioning, master prompt section 17), which does
 * not exist yet. Creating this row is real and visible to the
 * customer; it is not a fake success for a deployment that hasn't
 * happened.
 */
export async function createSite(env, { organizationId, name, productId, actorUserId, preset, cloneFromSiteId, cloneFromTenantId, sections, platformDomainId, subdomain }) {
  const gate = await evaluateWriteGate(env, { organizationId, method: "POST", subPath: "/sites" });
  if (gate.blocked) return { ok: false, status: 402, ...refusalFor(gate.access) };
  const trimmedName = (name || "").trim();
  if (!trimmedName) return { ok: false, status: 422, error: "name_required" };
  if (!productId) return { ok: false, status: 422, error: "product_required" };

  const product = await env.LUMMET_DB.prepare(`SELECT id, template_line FROM products WHERE id = ? AND status = 'active'`)
    .bind(productId)
    .first();
  if (!product) return { ok: false, status: 422, error: "invalid_product" };

  // Phase 9: how the new site is first configured. Checked BEFORE anything is written, so a bad preset or clone source creates no site.
  // With no choice the request carries the default for the plan or product, and "full" when there is none: every new site starts the wizard.
  // Only the casino application has a first-run wizard and presets; a brokerage site is set up by its own administrator.
  const hasWizard = (product.template_line || "casino") === "casino";
  const planned = hasWizard ? await planSetup(env, { preset, cloneFromSiteId, cloneFromTenantId, sections, organizationId, productId, staff: false }) : null;
  if (planned && !planned.ok) return { ok: false, status: planned.status, error: planned.error };

  // Platform domain (migration 0085): validated server-side against what this organisation may choose, before anything is written.
  const chosen = await resolveCustomerChoice(env, { organizationId, platformDomainId });
  if (!chosen.ok) return { ok: false, status: 422, error: chosen.error };

  // The address label: what the customer typed, or their site name turned into one. It is checked against the chosen domain
  // and NEVER changed on the customer's behalf: a taken or invalid label is refused with suggestions (no "-2" is added).
  const hasTyped = subdomain !== undefined && subdomain !== null && String(subdomain).trim() !== "";
  const label = hasTyped ? siteLabels.normalizeLabel(subdomain) : siteLabels.slugifyLabel(trimmedName);
  const labelCheck = await siteLabels.checkLabel(env, { label, domain: chosen.domain });
  if (!labelCheck.available) return await labelRefusal(env, { organizationId, label, domain: chosen.domain, reason: labelCheck.reason });

  const id = crypto.randomUUID();
  // The slug stays globally unique and internal: the Worker, D1, KV and R2 names derive from it. The customer never sees it.
  const slug = await uniqueSlug(env, label);

  try {
    await env.LUMMET_DB.prepare(
      `INSERT INTO sites (id, organization_id, name, slug, host_label, product_id, status, platform_domain_id) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
    )
      .bind(id, organizationId, trimmedName, slug, label, productId, chosen.domain.id || null)
      .run();
  } catch (error) {
    // Someone took the label between the check and the write: the unique index (migration 0088) decided.
    if (/UNIQUE|constraint/i.test(String(error?.message))) return await labelRefusal(env, { organizationId, label, domain: chosen.domain, reason: "taken" });
    throw error;
  }

  await recordStatusEvent(env, {
    siteId: id,
    fromStatus: null,
    toStatus: "pending",
    actorType: "customer_user",
    actorId: actorUserId
  });

  // The site exists either way: a failure to record the request must not lose it (the first-deploy seed still starts the wizard).
  let setupRequestId = null;
  try {
    if (planned) setupRequestId = await storeSetupRequest(env, { siteId: id, plan: planned.plan, requestedBy: actorUserId });
  } catch (_) { /* fail-open */ }

  await webhooks.dispatchEvent(env, organizationId, "site.created", { siteId: id, name: trimmedName, slug });

  return {
    ok: true, siteId: id, slug, label, platformDomain: { id: chosen.domain.id || null, hostname: chosen.domain.hostname, host: hostFor({ slug, host_label: label }, chosen.domain) },
    setup: planned ? { requestId: setupRequestId, kind: planned.plan.kind, presetId: planned.plan.presetId, presetSource: planned.plan.presetSource, status: "pending" } : null
  };
}

export async function getSite(env, siteId) {
  return env.LUMMET_DB.prepare(`SELECT * FROM sites WHERE id = ?`).bind(siteId).first();
}

export async function listSitesForOrganization(env, organizationId) {
  const result = await env.LUMMET_DB.prepare(
    `SELECT s.*, p.name AS product_name, p.category AS product_category, p.template_line AS template_line
     FROM sites s JOIN products p ON p.id = s.product_id
     WHERE s.organization_id = ? AND s.status != 'deleted'
     ORDER BY s.created_at`
  )
    .bind(organizationId)
    .all();
  return result.results || [];
}

export async function countActiveSitesForOrganization(env, organizationId) {
  const row = await env.LUMMET_DB.prepare(
    `SELECT COUNT(*) c FROM sites WHERE organization_id = ? AND status NOT IN ('deleted', 'deleting')`
  )
    .bind(organizationId)
    .first();
  return row?.c || 0;
}

/**
 * The only sanctioned way to change a site's status. Rejects any
 * transition not explicitly allowed above, so nothing can fake a
 * site into "active" without going through provisioning/deploying
 * first (master prompt rule #5 — don't fake deployment success).
 */
export async function transitionSiteStatus(env, siteId, toStatus, { reason, actorType, actorId } = {}) {
  if (!SITE_STATUSES.includes(toStatus)) return { ok: false, status: 422, error: "invalid_status" };

  const site = await getSite(env, siteId);
  if (!site) return { ok: false, status: 404, error: "not_found" };

  const allowedNext = ALLOWED_TRANSITIONS[site.status] || [];
  if (!allowedNext.includes(toStatus)) {
    return { ok: false, status: 409, error: "invalid_transition", from: site.status, to: toStatus };
  }

  const deletedAt = toStatus === "deleted" ? new Date().toISOString() : null;

  await env.LUMMET_DB.prepare(
    `UPDATE sites SET status = ?, suspension_reason = ?, updated_at = CURRENT_TIMESTAMP, deleted_at = COALESCE(?, deleted_at) WHERE id = ?`
  )
    .bind(toStatus, toStatus === "suspended" ? reason || null : site.suspension_reason, deletedAt, siteId)
    .run();

  await recordStatusEvent(env, { siteId, fromStatus: site.status, toStatus, reason, actorType, actorId });

  // Keep the public "Powered by Lummet" brand listing in step with the site (best effort, never throws).
  await syncSiteBrand(env, siteId);

  return { ok: true };
}

export async function listStatusEvents(env, siteId) {
  const result = await env.LUMMET_DB.prepare(
    `SELECT * FROM site_status_events WHERE site_id = ? ORDER BY created_at DESC`
  )
    .bind(siteId)
    .all();
  return result.results || [];
}

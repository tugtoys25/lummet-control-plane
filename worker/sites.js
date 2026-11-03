// =====================================================
// SITES (SaaS lifecycle)
//
// Distinct from registry.js's `tenants` table — see
// migration 0006's header comment. A site here tracks what
// the CUSTOMER sees and owns; it is linked to a `tenants`
// row only once Phase 3 provisioning actually deploys a
// Worker/D1/KV/R2 for it (master prompt section 9).
// =====================================================

import * as webhooks from "./webhooks.js";
import { evaluateWriteGate, refusalFor } from "./access.js";

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
  provisioning: ["provisioned", "failed"],
  provisioned: ["configuring", "failed"],
  configuring: ["deploying", "failed"],
  deploying: ["active", "failed"],
  active: ["suspended", "maintenance", "deleting"],
  suspended: ["active", "deleting"],
  maintenance: ["active", "deleting"],
  failed: ["provisioning", "deleting"],
  deleting: ["deleted"],
  deleted: []
};

function slugify(name) {
  return (
    (name || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "site"
  );
}

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

/**
 * Creates a site record in the "pending" state. This does NOT
 * provision any Cloudflare infrastructure — that is Phase 3
 * (automated provisioning, master prompt section 17), which does
 * not exist yet. Creating this row is real and visible to the
 * customer; it is not a fake success for a deployment that hasn't
 * happened.
 */
export async function createSite(env, { organizationId, name, productId, actorUserId }) {
  const gate = await evaluateWriteGate(env, { organizationId, method: "POST", subPath: "/sites" });
  if (gate.blocked) return { ok: false, status: 402, ...refusalFor(gate.access) };
  const trimmedName = (name || "").trim();
  if (!trimmedName) return { ok: false, status: 422, error: "name_required" };
  if (!productId) return { ok: false, status: 422, error: "product_required" };

  const product = await env.LUMMET_DB.prepare(`SELECT id FROM products WHERE id = ? AND status = 'active'`)
    .bind(productId)
    .first();
  if (!product) return { ok: false, status: 422, error: "invalid_product" };

  const id = crypto.randomUUID();
  const slug = await uniqueSlug(env, slugify(trimmedName));

  await env.LUMMET_DB.prepare(
    `INSERT INTO sites (id, organization_id, name, slug, product_id, status) VALUES (?, ?, ?, ?, ?, 'pending')`
  )
    .bind(id, organizationId, trimmedName, slug, productId)
    .run();

  await recordStatusEvent(env, {
    siteId: id,
    fromStatus: null,
    toStatus: "pending",
    actorType: "customer_user",
    actorId: actorUserId
  });

  await webhooks.dispatchEvent(env, organizationId, "site.created", { siteId: id, name: trimmedName, slug });

  return { ok: true, siteId: id, slug };
}

export async function getSite(env, siteId) {
  return env.LUMMET_DB.prepare(`SELECT * FROM sites WHERE id = ?`).bind(siteId).first();
}

export async function listSitesForOrganization(env, organizationId) {
  const result = await env.LUMMET_DB.prepare(
    `SELECT s.*, p.name AS product_name, p.category AS product_category
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

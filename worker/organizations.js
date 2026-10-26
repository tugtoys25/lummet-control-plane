// =====================================================
// ORGANIZATIONS
// The customer-facing billing/ownership unit (master
// prompt section 7). A customer_user reaches an
// organization only through a row in organization_users —
// there is no implicit access, matching how canAccessTenant
// in rbac.js requires an explicit grant for staff.
// =====================================================

import { isValidRole } from "./customer-rbac.js";
import { billingConfig } from "./billing-config.js";
import { queueCancelPending } from "./billing-lifecycle.js";
import { resolveForOrganization } from "./entitlements.js";
import * as lifecycleRepo from "./repositories/billing-lifecycle.js";
import * as repository from "./repositories/organizations.js";

function slugify(name) {
  return (
    (name || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "org"
  );
}

async function uniqueSlug(env, base) {
  let slug = base;
  let n = 1;
  while (
    await env.LUMMET_DB.prepare(`SELECT 1 FROM organizations WHERE slug = ?`).bind(slug).first()
  ) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

export async function createOrganization(env, { name, ownerUserId }) {
  const trimmedName = (name || "").trim();
  if (!trimmedName) return { ok: false, status: 422, error: "name_required" };
  if (!ownerUserId) return { ok: false, status: 422, error: "owner_required" };

  const id = crypto.randomUUID();
  const slug = await uniqueSlug(env, slugify(trimmedName));

  await env.LUMMET_DB.prepare(`INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)`)
    .bind(id, trimmedName, slug)
    .run();

  await env.LUMMET_DB.prepare(
    `INSERT INTO organization_users (organization_id, user_id, role) VALUES (?, ?, 'owner')`
  )
    .bind(id, ownerUserId)
    .run();

  return { ok: true, organizationId: id, slug };
}

export async function getOrganization(env, organizationId) {
  return env.LUMMET_DB.prepare(`SELECT * FROM organizations WHERE id = ?`).bind(organizationId).first();
}

export async function listOrganizationsForUser(env, userId) {
  const result = await env.LUMMET_DB.prepare(
    `SELECT o.*, ou.role AS my_role
     FROM organizations o
     JOIN organization_users ou ON ou.organization_id = o.id
     WHERE ou.user_id = ?
     ORDER BY o.created_at`
  )
    .bind(userId)
    .all();
  return result.results || [];
}

export async function getMembership(env, organizationId, userId) {
  return env.LUMMET_DB.prepare(
    `SELECT * FROM organization_users WHERE organization_id = ? AND user_id = ?`
  )
    .bind(organizationId, userId)
    .first();
}

export async function listMembers(env, organizationId) {
  const result = await env.LUMMET_DB.prepare(
    `SELECT ou.user_id, ou.role, ou.created_at, u.email, u.full_name, u.status
     FROM organization_users ou
     JOIN customer_users u ON u.id = ou.user_id
     WHERE ou.organization_id = ?
     ORDER BY ou.created_at`
  )
    .bind(organizationId)
    .all();
  return result.results || [];
}

async function countOwners(env, organizationId) {
  const row = await env.LUMMET_DB.prepare(
    `SELECT COUNT(*) c FROM organization_users WHERE organization_id = ? AND role = 'owner'`
  )
    .bind(organizationId)
    .first();
  return row?.c || 0;
}

export async function updateMemberRole(env, organizationId, userId, newRole) {
  if (!isValidRole(newRole)) return { ok: false, status: 422, error: "invalid_role" };

  const membership = await getMembership(env, organizationId, userId);
  if (!membership) return { ok: false, status: 404, error: "not_a_member" };

  if (membership.role === "owner" && newRole !== "owner") {
    const owners = await countOwners(env, organizationId);
    if (owners <= 1) return { ok: false, status: 409, error: "must_keep_one_owner" };
  }

  await env.LUMMET_DB.prepare(
    `UPDATE organization_users SET role = ? WHERE organization_id = ? AND user_id = ?`
  )
    .bind(newRole, organizationId, userId)
    .run();

  return { ok: true };
}

export async function removeMember(env, organizationId, userId) {
  const membership = await getMembership(env, organizationId, userId);
  if (!membership) return { ok: false, status: 404, error: "not_a_member" };

  if (membership.role === "owner") {
    const owners = await countOwners(env, organizationId);
    if (owners <= 1) return { ok: false, status: 409, error: "must_keep_one_owner" };
  }

  await env.LUMMET_DB.prepare(
    `DELETE FROM organization_users WHERE organization_id = ? AND user_id = ?`
  )
    .bind(organizationId, userId)
    .run();

  return { ok: true };
}

// -----------------------------------------------------
// Invitations — the plaintext token is returned to the
// caller once, to deliver out of band, until real outbound
// email exists (master prompt section 28). Only its hash is
// stored, matching the pattern already used for tenant API
// credentials (registry.js) and staff temp passwords (auth.js).
// -----------------------------------------------------

async function hashToken(token) {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/[^a-zA-Z0-9]/g, "");
}

const INVITATION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

/**
 * Seats (Phase 1.4, closes F7): members PLUS pending, unexpired invitations must stay within `users.max`.
 * BILLING_ENFORCE=off never blocks; shadow records nothing here (it only reports); enforce refuses with a message the
 * UI can turn into an upgrade prompt. `ignoreInvitationId` lets an invitation being accepted not count against itself.
 */
export async function seatCheck(env, organizationId, { ignoreInvitationId = null } = {}) {
  const limit = (await resolveForOrganization(env, organizationId))["users.max"]?.value;
  const members = await lifecycleRepo.countMembers(env, organizationId);
  const pending = await lifecycleRepo.countPendingInvitations(env, organizationId, { nowIso: new Date().toISOString(), ignoreInvitationId });
  const used = members + pending;
  return { limit: typeof limit === "number" ? limit : null, members, pending, used, wouldExceed: typeof limit === "number" && used + 1 > limit };
}

export async function createInvitation(env, { organizationId, email, role, invitedBy }) {
  if (!isValidRole(role)) return { ok: false, status: 422, error: "invalid_role" };
  const trimmedEmail = (email || "").trim().toLowerCase();
  if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) return { ok: false, status: 422, error: "invalid_email" };
  const existing = await repository.findPendingInvitationByEmail(env, organizationId, trimmedEmail);
  if (existing) return { ok: false, status: 409, error: "invitation_already_pending" };

  const mode = billingConfig(env).mode;
  let seatLimitShadow = null;
  if (mode !== "off") {
    const seats = await seatCheck(env, organizationId);
    if (seats.wouldExceed && mode === "enforce") {
      return {
        ok: false, status: 402, error: "seat_limit_reached", limit: seats.limit, used: seats.used,
        message: `Your plan includes ${seats.limit} team member${seats.limit === 1 ? "" : "s"} (members plus pending invitations: ${seats.used}). Upgrade your plan or remove someone to invite more.`
      };
    }
    if (seats.wouldExceed && mode === "shadow") seatLimitShadow = { reason: "seat_limit_reached", limit: seats.limit, used: seats.used };
  }

  const id = crypto.randomUUID();
  const token = randomToken();
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS).toISOString();

  await env.LUMMET_DB.prepare(
    `INSERT INTO organization_invitations (id, organization_id, email, role, token_hash, invited_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, organizationId, trimmedEmail, role, tokenHash, invitedBy || null, expiresAt)
    .run();

  return { ok: true, invitationId: id, token, expiresAt, ...(seatLimitShadow ? { seatLimitShadow } : {}) };
}

export async function acceptInvitation(env, token, userId) {
  const tokenHash = await hashToken(token);
  const invitation = await env.LUMMET_DB.prepare(
    `SELECT * FROM organization_invitations WHERE token_hash = ? AND status = 'pending'`
  )
    .bind(tokenHash)
    .first();

  if (!invitation) return { ok: false, status: 404, error: "invalid_or_used_invitation" };

  if (new Date(invitation.expires_at).getTime() < Date.now()) {
    await env.LUMMET_DB.prepare(`UPDATE organization_invitations SET status = 'expired' WHERE id = ?`)
      .bind(invitation.id)
      .run();
    return { ok: false, status: 410, error: "invitation_expired" };
  }

  // The token alone must not be enough: an invitation is for one email
  // address. Without this, anyone holding the link (a forwarded email, the
  // inviter, a leaked log) could join with the invited role, including admin.
  const accepting = await env.LUMMET_DB.prepare(`SELECT email FROM customer_users WHERE id = ?`).bind(userId).first();
  if (!accepting || String(accepting.email).toLowerCase() !== String(invitation.email).toLowerCase()) {
    return { ok: false, status: 403, error: "invitation_email_mismatch" };
  }

  const existing = await getMembership(env, invitation.organization_id, userId);
  if (existing) {
    await env.LUMMET_DB.prepare(
      `UPDATE organization_invitations SET status = 'accepted', accepted_at = ? WHERE id = ?`
    )
      .bind(new Date().toISOString(), invitation.id)
      .run();
    return { ok: true, organizationId: invitation.organization_id, alreadyMember: true };
  }

  const mode = billingConfig(env).mode;
  let seatLimitShadow = null;
  if (mode !== "off") {
    // The accepting invitation is itself one of the pending seats, so it is excluded from the count.
    const seats = await seatCheck(env, invitation.organization_id, { ignoreInvitationId: invitation.id });
    if (seats.wouldExceed && mode === "enforce") return { ok: false, status: 402, error: "seat_limit_reached", limit: seats.limit, used: seats.used };
    if (seats.wouldExceed && mode === "shadow") seatLimitShadow = { reason: "seat_limit_reached", limit: seats.limit, used: seats.used };
  }

  await env.LUMMET_DB.prepare(
    `INSERT INTO organization_users (organization_id, user_id, role) VALUES (?, ?, ?)`
  )
    .bind(invitation.organization_id, userId, invitation.role)
    .run();

  await env.LUMMET_DB.prepare(
    `UPDATE organization_invitations SET status = 'accepted', accepted_at = ? WHERE id = ?`
  )
    .bind(new Date().toISOString(), invitation.id)
    .run();

  return { ok: true, organizationId: invitation.organization_id, alreadyMember: false, ...(seatLimitShadow ? { seatLimitShadow } : {}) };
}

export async function listPendingInvitations(env, organizationId) {
  const result = await env.LUMMET_DB.prepare(
    `SELECT id, email, role, status, expires_at, created_at FROM organization_invitations
     WHERE organization_id = ? ORDER BY created_at DESC`
  )
    .bind(organizationId)
    .all();
  return result.results || [];
}

export async function revokeInvitation(env, organizationId, invitationId) {
  await env.LUMMET_DB.prepare(
    `UPDATE organization_invitations SET status = 'revoked' WHERE id = ? AND organization_id = ? AND status = 'pending'`
  )
    .bind(invitationId, organizationId)
    .run();
  return { ok: true };
}

const GRACE_PERIOD_DAYS = 30;

/**
 * Transfer the primary ownership role to another existing member
 * (master prompt section 7). The caller must currently be an owner;
 * the target must already be a member. Does not remove the caller
 * from the organization — they become 'admin', keeping their access,
 * matching how a real handoff (agency selling a client site, a
 * founder stepping back) normally works.
 */
export async function transferOwnership(env, organizationId, { fromUserId, toUserId }) {
  const from = await getMembership(env, organizationId, fromUserId);
  if (!from || from.role !== "owner") return { ok: false, status: 403, error: "only_an_owner_can_transfer_ownership" };
  const to = await getMembership(env, organizationId, toUserId);
  if (!to) return { ok: false, status: 404, error: "target_is_not_a_member" };
  if (fromUserId === toUserId) return { ok: false, status: 422, error: "already_the_owner" };

  await env.LUMMET_DB.prepare(`UPDATE organization_users SET role = 'owner' WHERE organization_id = ? AND user_id = ?`)
    .bind(organizationId, toUserId).run();
  await env.LUMMET_DB.prepare(`UPDATE organization_users SET role = 'admin' WHERE organization_id = ? AND user_id = ?`)
    .bind(organizationId, fromUserId).run();
  return { ok: true };
}

/**
 * Deactivate (soft-close) an organization. Reversible — staff or the
 * owner can reopen it (see worker/staff-saas.js's setOrganizationStatus
 * for the staff side; this is the customer-initiated equivalent).
 * Deactivating does NOT schedule deletion or touch billing — a
 * customer who just wants to pause can do this without losing data or
 * committing to leaving. Cancelling the subscription, if any, is a
 * separate, explicit action (see requestDeletion below, which does both).
 */
export async function deactivateOrganization(env, organizationId, actorUserId) {
  const membership = await getMembership(env, organizationId, actorUserId);
  if (!membership || membership.role !== "owner") return { ok: false, status: 403, error: "only_an_owner_can_deactivate" };
  await env.LUMMET_DB.prepare(`UPDATE organizations SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(organizationId).run();
  return { ok: true };
}

export async function reactivateOrganization(env, organizationId, actorUserId) {
  const membership = await getMembership(env, organizationId, actorUserId);
  if (!membership || membership.role !== "owner") return { ok: false, status: 403, error: "only_an_owner_can_reactivate" };
  const org = await getOrganization(env, organizationId);
  if (!org) return { ok: false, status: 404, error: "not_found" };
  if (org.status === "suspended") return { ok: false, status: 403, error: "suspended_by_staff_contact_support" };
  if (org.status !== "closed") return { ok: false, status: 409, error: "not_closed" };
  if (org.scheduled_deletion_at) return { ok: false, status: 409, error: "deletion_already_scheduled_cancel_that_first" };
  await env.LUMMET_DB.prepare(`UPDATE organizations SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(organizationId).run();
  return { ok: true };
}

/**
 * Request deletion (master prompt section 7 + 13's grace-period
 * policy). Never deletes anything immediately: closes the
 * organization now (so it stops being usable/billable right away)
 * and records a scheduled_deletion_at GRACE_PERIOD_DAYS out. Actually
 * erasing data on that date is a separate, deliberately-not-yet-built
 * job (see roadmap item 1.3 — the retention rules that job must follow
 * need a legal/product decision this function does not make).
 * Cancels any active subscription so the customer is not charged
 * during or after the grace period.
 */
export async function requestDeletion(env, organizationId, actorUserId, { billingService = null, deleteNow = false } = {}) {
  const membership = await getMembership(env, organizationId, actorUserId);
  if (!membership || membership.role !== "owner") return { ok: false, status: 403, error: "only_an_owner_can_request_deletion" };
  const org = await getOrganization(env, organizationId);
  if (!org) return { ok: false, status: 404, error: "not_found" };
  if (org.scheduled_deletion_at) return { ok: true, alreadyScheduled: true, scheduledDeletionAt: org.scheduled_deletion_at };

  let billingCancelQueued = false;
  let billingEndsAt = null;
  if (billingService) {
    // A Stripe failure must never be swallowed (it used to be, which left customers billed after deleting). The
    // deletion still proceeds, because a billing outage must not stop someone leaving, but the failed cancellation
    // is queued, retried by the sweep, and alerts staff (`cancel_pending_stuck`) if it is still failing after 24 hours.
    // With the billing lifecycle on (BILLING_ENFORCE != off) cancellation is scheduled for the END of the paid period
    // by default; the owner may explicitly choose to delete now and forfeit the rest (deleteNow).
    const atPeriodEnd = billingConfig(env).mode !== "off" && !deleteNow;
    try {
      const r = await billingService.cancelSubscription(env, organizationId, { atPeriodEnd, actorUserId });
      if (!r.ok && r.error !== "no_active_subscription") {
        await queueCancelPending(env, { organizationId, atPeriodEnd, error: r.error });
        billingCancelQueued = true;
      }
    } catch (e) {
      await queueCancelPending(env, { organizationId, atPeriodEnd, error: e?.message || e });
      billingCancelQueued = true;
    }
    if (atPeriodEnd) {
      billingEndsAt = await lifecycleRepo.cancellingPeriodEnd(env, organizationId);
    }
  }

  const scheduledFor = new Date(Date.now() + GRACE_PERIOD_DAYS * 86400000).toISOString();
  await env.LUMMET_DB.prepare(
    `UPDATE organizations SET status = 'closed', scheduled_deletion_at = ?, deletion_requested_by = ?, deletion_requested_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(scheduledFor, actorUserId, organizationId).run();
  return { ok: true, scheduledDeletionAt: scheduledFor, billingCancelQueued, billingEndsAt };
}

export async function cancelScheduledDeletion(env, organizationId, actorUserId, { billingService = null } = {}) {
  const membership = await getMembership(env, organizationId, actorUserId);
  if (!membership || membership.role !== "owner") return { ok: false, status: 403, error: "only_an_owner_can_cancel_deletion" };
  const org = await getOrganization(env, organizationId);
  if (!org || !org.scheduled_deletion_at) return { ok: false, status: 409, error: "no_deletion_scheduled" };
  await env.LUMMET_DB.prepare(
    `UPDATE organizations SET status = 'active', scheduled_deletion_at = NULL, deletion_requested_by = NULL, deletion_requested_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(organizationId).run();
  // A queued cancellation that has not gone through yet is simply withdrawn.
  await lifecycleRepo.deleteCancelPending(env, organizationId);
  // Phase 1.5: if the subscription was only scheduled to end at period end and that has not happened, undo it.
  let subscriptionResumed = false;
  if (billingService && billingConfig(env).mode !== "off") {
    const r = await billingService.resumeSubscription(env, organizationId).catch((e) => ({ ok: false, error: e?.message || String(e) }));
    subscriptionResumed = !!r.ok;
  }
  return { ok: true, subscriptionResumed };
}

/** For staff visibility and, later, the actual deletion sweep (roadmap 1.3, not yet built). */
export async function listOrganizationsPendingDeletion(env) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT id, name, scheduled_deletion_at, deletion_requested_at FROM organizations WHERE scheduled_deletion_at IS NOT NULL ORDER BY scheduled_deletion_at`
  ).all();
  return r.results;
}

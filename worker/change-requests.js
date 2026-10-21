// =====================================================
// APPROVAL WORKFLOWS (master prompt section 34)
//
// SCOPE NOTE: section 34's examples (casino reviews,
// affiliate offers, SEO pages, news) are all tenant CONTENT
// this control plane doesn't manage directly. This module
// instead applies the same draft -> pending -> approved
// pattern to the highest-consequence action the control plane
// DOES own outright: deleting a site. `type` is deliberately
// a free column so a future content-approval feature could
// reuse this same table rather than inventing another one.
//
// For an organization WITHOUT approval_workflows.enabled,
// nothing here is in the path at all — site deletion proceeds
// exactly as it always has (see index.js's DELETE site route).
// This is opt-in extra friction for enterprise orgs, not a
// new restriction on everyone.
// =====================================================

import { checkEntitlement } from "./entitlements.js";
import * as sites from "./sites.js";
import * as requestsRepo from "./repositories/change-requests.js";

async function requiresApproval(env, organizationId) {
  return (await checkEntitlement(env, organizationId, "approval_workflows.enabled")) === true;
}

/**
 * Either deletes the site immediately (no approval workflow enabled)
 * or creates a pending change request and leaves the site untouched
 * until a DIFFERENT admin/owner approves it. Never allows the
 * requester to also be the approver — segregation of duties is the
 * entire point of an approval workflow.
 */
export async function requestSiteDeletion(env, { organizationId, siteId, actorUserId, reason }) {
  const site = await sites.getSite(env, siteId);
  if (!site || site.organization_id !== organizationId) return { ok: false, status: 404, error: "site_not_found" };

  if (!(await requiresApproval(env, organizationId))) {
    const result = await sites.transitionSiteStatus(env, siteId, "deleting", {
      reason: reason || "customer-requested deletion", actorType: "customer_user", actorId: actorUserId
    });
    if (!result.ok) return result;
    return { ok: true, requiresApproval: false };
  }

  if (await requestsRepo.findPendingSiteDeletion(env, organizationId, siteId)) return { ok: false, status: 409, error: "deletion_already_requested" };

  const id = crypto.randomUUID();
  await requestsRepo.insertSiteDeletion(env, { id, organizationId, siteId, requestedBy: actorUserId, reason });

  return { ok: true, requiresApproval: true, changeRequestId: id };
}

export async function listChangeRequests(env, organizationId, { status } = {}) {
  return requestsRepo.list(env, organizationId, status);
}

async function getPendingRequest(env, organizationId, changeRequestId) {
  return requestsRepo.findPending(env, organizationId, changeRequestId);
}

export async function approveChangeRequest(env, { organizationId, changeRequestId, approverUserId }) {
  const request = await getPendingRequest(env, organizationId, changeRequestId);
  if (!request) return { ok: false, status: 404, error: "not_found" };

  if (request.requested_by && request.requested_by === approverUserId) {
    return { ok: false, status: 403, error: "cannot_approve_own_request" };
  }

  if (request.type === "site_deletion") {
    const deletion = await sites.transitionSiteStatus(env, request.resource_id, "deleting", {
      reason: `approved change request ${request.id}`, actorType: "customer_user", actorId: approverUserId
    });
    if (!deletion.ok) return deletion;
  }

  await requestsRepo.markApproved(env, changeRequestId, approverUserId);

  return { ok: true };
}

export async function rejectChangeRequest(env, { organizationId, changeRequestId, approverUserId, reason }) {
  const request = await getPendingRequest(env, organizationId, changeRequestId);
  if (!request) return { ok: false, status: 404, error: "not_found" };

  await requestsRepo.markRejected(env, changeRequestId, approverUserId, reason);

  return { ok: true };
}

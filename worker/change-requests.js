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
import * as teardown from "./site-teardown.js";
import * as requestsRepo from "./repositories/change-requests.js";

// The workflow needs a SECOND person: the requester can never approve their own request, so with fewer than two active owners or
// admins nobody could ever approve and the organization would be locked out of deleting its own sites. Below that, deletion is direct
// (the typed-name confirmation still applies); it applies again as soon as a second admin joins.
export const MIN_APPROVERS_FOR_WORKFLOW = 2;
async function requiresApproval(env, organizationId) {
  if ((await checkEntitlement(env, organizationId, "approval_workflows.enabled")) !== true) return false;
  return (await requestsRepo.countApprovers(env, organizationId)) >= MIN_APPROVERS_FOR_WORKFLOW;
}

/**
 * Either deletes the site immediately (no approval workflow enabled)
 * or creates a pending change request and leaves the site untouched
 * until a DIFFERENT admin/owner approves it. Never allows the
 * requester to also be the approver — segregation of duties is the
 * entire point of an approval workflow.
 */
export async function requestSiteDeletion(env, { organizationId, siteId, actorUserId, reason, confirmName }) {
  const site = await sites.getSite(env, siteId);
  if (!site || site.organization_id !== organizationId) return { ok: false, status: 404, error: "site_not_found" };

  // Typed confirmation, checked HERE (not just in the page): the exact site name, so a script or a stray click cannot delete a site.
  if (String(confirmName ?? "").trim() !== String(site.name).trim()) return { ok: false, status: 422, error: "confirmation_required", detail: "Type the site's name exactly to confirm." };
  if (site.status === "deleting" || site.status === "deleted") return { ok: false, status: 409, error: "site_already_deleting" };

  if (!(await requiresApproval(env, organizationId))) {
    const result = await teardown.beginSiteDeletion(env, {
      siteId, organizationId, reason: reason || "customer-requested deletion", actorType: "customer_user", actorId: actorUserId
    });
    if (!result.ok) return result;
    // A request filed earlier (while a second admin still existed) must not stay pending for a site that is already going.
    await requestsRepo.cancelPendingSiteDeletions(env, organizationId, siteId, "site was deleted directly: no second admin is available to approve");
    return { ok: true, requiresApproval: false, jobId: result.jobId };
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

  let jobId = null;
  if (request.type === "site_deletion") {
    const deletion = await teardown.beginSiteDeletion(env, {
      siteId: request.resource_id, organizationId, reason: `approved change request ${request.id}`, actorType: "customer_user", actorId: approverUserId
    });
    if (!deletion.ok) return deletion;
    jobId = deletion.jobId;
  }

  await requestsRepo.markApproved(env, changeRequestId, approverUserId);

  return { ok: true, jobId };
}

export async function rejectChangeRequest(env, { organizationId, changeRequestId, approverUserId, reason }) {
  const request = await getPendingRequest(env, organizationId, changeRequestId);
  if (!request) return { ok: false, status: 404, error: "not_found" };

  await requestsRepo.markRejected(env, changeRequestId, approverUserId, reason);

  return { ok: true };
}

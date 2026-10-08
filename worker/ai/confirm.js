// =====================================================
// AI CONFIRM
// The only function in the entire AI layer that actually
// mutates tenant data. Deliberately re-does every check
// write.js already did at preview time -- nothing here
// trusts that the world hasn't changed since the preview
// was shown (permissions revoked, tenant access removed,
// the record edited by someone else, the admin having
// switched active tenant). Execution itself goes through
// crud.js's submitCreate/submitUpdate/submitDelete --
// exactly the functions the dashboard's own forms call --
// so tenant-side validation and business rules are
// identical regardless of who initiated the write.
// =====================================================

import { getTenant } from "../data.js";
import { getFromTenant } from "../client.js";
import { canAccessTenant } from "../rbac.js";
import { getSchema } from "./schema.js";
import { resourceRecordPath } from "./read.js";
import { checkPermission } from "./resolver.js";
import { buildProposedForm, buildMergedForm } from "./form-adapter.js";
import { getOwnedPendingOperation, isExpired, markStatus } from "./pending-operations.js";
import { submitCreate, submitUpdate, submitDelete } from "../views/pages/crud.js";
import { logAudit } from "../audit.js";
import { appendMessage } from "./chat.js";

function reject(op, error, message, extra = {}) {
  return { ok: false, error, message, pendingOperationId: op?.id, ...extra };
}

/**
 * @param {string} expectedHash - the payloadHash the client saw on the
 *   preview response. If provided, must match the stored hash exactly,
 *   or the confirm is refused -- this is what stops a client from
 *   confirming a pending operation whose preview it never actually
 *   saw/re-saw (e.g. a stale UI holding an old id after a new preview
 *   for the same conversation was generated).
 */
export async function confirmPendingOperation(env, admin, pendingOperationId, expectedHash = null) {
  const op = await getOwnedPendingOperation(env, admin, pendingOperationId);
  if (!op) {
    return reject(null, "not_found", "That pending operation does not exist or isn't yours.");
  }

  if (op.status !== "pending") {
    return reject(op, "already_" + op.status, `This operation was already ${op.status}.`);
  }

  if (isExpired(op)) {
    await markStatus(env, op.id, "expired");
    return reject(op, "expired", "This write preview has expired. Ask again to get a fresh one.");
  }

  if (expectedHash && expectedHash !== op.payload_hash) {
    return reject(op, "hash_mismatch", "This confirmation doesn't match the previewed operation. Ask again for a fresh preview.");
  }

  // The admin may have switched active tenant between preview and
  // confirm. crud.js's submitCreate/submitUpdate/submitDelete resolve
  // the tenant from the admin's CURRENT active tenant (resolveActiveTenant),
  // not from anything passed in here -- so if we let this proceed while
  // active != previewed, the write would silently land on the WRONG
  // tenant. Refuse instead of guessing which one the admin means.
  if (admin.activeTenantId !== op.tenant_id) {
    return reject(
      op,
      "active_tenant_changed",
      "Your active tenant has changed since this was previewed. Switch back to the previewed tenant, or ask again to get a fresh preview for the current one."
    );
  }

  const authorized = await canAccessTenant(env, admin, op.tenant_id);
  if (!authorized) {
    await markStatus(env, op.id, "rejected", { reason: "tenant_no_longer_authorized" });
    return reject(op, "forbidden", "You are no longer authorized for this tenant.");
  }

  const permission = await checkPermission(env, admin, op.resource, op.operation);
  if (!permission.ok) {
    await markStatus(env, op.id, "rejected", { reason: "permission_revoked" });
    return reject(op, "forbidden", "Your permission for this action has changed since it was previewed.");
  }

  const config = getSchema(op.resource);
  if (!config || (op.operation === "delete" && !config.supportsDelete) || (op.operation === "create" && !config.supportsCreate)) {
    await markStatus(env, op.id, "rejected", { reason: "operation_no_longer_supported" });
    return reject(op, "operation_not_supported", "This operation is not supported.");
  }

  const tenant = await getTenant(env, op.tenant_id);
  if (!tenant) {
    await markStatus(env, op.id, "rejected", { reason: "tenant_missing" });
    return reject(op, "tenant_not_found", "This tenant is no longer registered.");
  }

  let executionResult;
  let freshRecordForConflictCheck = null;

  if (op.operation !== "create") {
    const fetched = await getFromTenant(env, tenant, resourceRecordPath(op.resource, op.record_id));
    if (!fetched.ok) {
      await markStatus(env, op.id, "rejected", { reason: "record_no_longer_available" });
      return reject(op, fetched.reason || "record_not_found", "The record could not be re-fetched — it may have been deleted.");
    }
    freshRecordForConflictCheck = fetched.data.data ?? fetched.data;

    // Conflict detection: did any field this operation is about to
    // touch change since the preview was shown? If so, do NOT execute
    // against stale expectations -- report the conflict instead.
    const proposedValues = op.proposedValues || {};
    const previewedCurrent = op.currentValues || {};
    const conflictingFields = Object.keys(proposedValues).filter((field) => {
      const previewed = previewedCurrent[field] ?? null;
      const live = freshRecordForConflictCheck[field] ?? null;
      return JSON.stringify(previewed) !== JSON.stringify(live);
    });

    if (conflictingFields.length > 0) {
      await markStatus(env, op.id, "superseded", { reason: "conflicting_changes", fields: conflictingFields });
      return reject(op, "conflict", `This record changed since the preview (field(s): ${conflictingFields.join(", ")}). Ask again for a fresh preview.`, {
        conflictingFields
      });
    }
  }

  if (op.operation === "create") {
    const form = buildProposedForm(config, op.proposedValues);
    executionResult = await submitCreate(env, admin, op.resource, config, form);
  } else if (op.operation === "update") {
    const form = buildMergedForm(config, freshRecordForConflictCheck, op.proposedValues);
    executionResult = await submitUpdate(env, admin, op.resource, config, op.record_id, form);
  } else {
    executionResult = await submitDelete(env, admin, op.resource, op.record_id);
  }

  const success = !!executionResult.ok;

  await markStatus(
    env,
    op.id,
    success ? "executed" : "rejected",
    success ? executionResult.data : { reason: executionResult.reason, message: executionResult.message }
  );

  await logAudit(env, {
    adminId: admin.id,
    tenantId: op.tenant_id,
    endpoint: `/api/ai/confirm/${op.id}`,
    method: "POST",
    resource: op.resource,
    resourceId: op.record_id,
    action: op.operation,
    success,
    statusCode: success ? 200 : executionResult.status || 500,
    errorMessage: success ? null : executionResult.message,
    initiatedBy: "ai",
    aiConversationId: op.conversation_id
  });

  if (op.conversation_id) {
    const summary = success
      ? `Write completed.\n\n${op.resource} ${op.record_id ? `(${op.record_id})` : ""}: ${JSON.stringify(executionResult.data?.data ?? executionResult.data, null, 2)}`
      : `Write failed: ${executionResult.message || executionResult.reason}`;
    await appendMessage(env, op.conversation_id, "assistant", summary, op.id);
  }

  if (!success) {
    return reject(op, executionResult.reason || "write_failed", executionResult.message || "The write failed.", {
      status: executionResult.status
    });
  }

  return {
    ok: true,
    pendingOperationId: op.id,
    tenant: { id: tenant.id, name: tenant.name },
    resourceKey: op.resource,
    operation: op.operation,
    recordId: op.record_id,
    result: executionResult.data
  };
}

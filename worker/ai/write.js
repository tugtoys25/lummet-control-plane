// =====================================================
// AI WRITE (preview builder)
// Turns a resolved create/update/delete intent into a
// pending-operations row and a human-readable diff. This
// module NEVER calls submitCreate/submitUpdate/submitDelete
// -- only confirm.js does, and only after re-verifying
// everything a second time. This file's only output is
// "here is what would happen"; nothing here is destructive.
// =====================================================

import { getFromTenant } from "../client.js";
import { resourceRecordPath } from "./read.js";
import { validateProposedFields } from "./form-adapter.js";
import { createPendingOperation } from "./pending-operations.js";

/**
 * @returns preview result shape consumed by chat.js's formatResultAsText,
 * or an {ok:false,...} error.
 */
export async function buildWritePreview(env, admin, resolved, intent, { conversationId = null } = {}) {
  const { tenant, resourceKey, config, action } = resolved;
  const proposedValues = intent.fields || {};

  // confirm.js (via crud.js) always writes to the admin's ACTIVE tenant, and
  // refuses if that differs from the previewed one. Catch it here instead of
  // showing a preview that can never be confirmed.
  if (admin.activeTenantId !== tenant.id) {
    return {
      ok: false,
      error: "active_tenant_mismatch",
      message: `This targets ${tenant.name}, but your active tenant is different. Switch to ${tenant.name} with the tenant switcher at the top, then run it again.`
    };
  }

  const validation = validateProposedFields(config, proposedValues, { forUpdate: action === "update" });
  if (!validation.ok) {
    const parts = [];
    if (validation.unknownFields.length) parts.push(`unknown field(s): ${validation.unknownFields.join(", ")}`);
    if (validation.lockedFields.length) parts.push(`locked after creation: ${validation.lockedFields.join(", ")}`);
    return { ok: false, error: "invalid_fields", message: `Cannot proceed — ${parts.join("; ")}.` };
  }

  if (action === "create") {
    const missingRequired = config.fields
      .filter((f) => f.required && !f.lockOnEdit)
      .map((f) => f.name)
      .filter((name) => !(name in proposedValues) || proposedValues[name] === "" || proposedValues[name] == null);
    if (missingRequired.length) {
      return {
        ok: false,
        error: "missing_required_fields",
        message: `Cannot create ${config.label} — missing required field(s): ${missingRequired.join(", ")}.`
      };
    }

    const changes = Object.entries(proposedValues).map(([field, value]) => ({ field, current: null, proposed: value }));

    const { id, payloadHash, expiresAt } = await createPendingOperation(env, {
      adminId: admin.id,
      conversationId,
      tenantId: tenant.id,
      resourceKey,
      operation: "create",
      recordId: null,
      currentValues: null,
      proposedValues
    });

    return {
      ok: true,
      kind: "write_preview",
      pendingOperationId: id,
      payloadHash,
      expiresAt,
      tenant: { id: tenant.id, name: tenant.name },
      resourceKey,
      operation: "create",
      recordId: null,
      destructive: false,
      changes
    };
  }

  // update / delete both need the real, current record.
  if (!intent.recordId) {
    return { ok: false, error: "record_required", message: `Which ${config.label} record? Please give an id.` };
  }

  const fetched = await getFromTenant(env, tenant, resourceRecordPath(resourceKey, intent.recordId));
  if (!fetched.ok) {
    return { ok: false, error: fetched.reason || "record_not_found", message: fetched.message || "That record could not be found." };
  }
  const existingRecord = fetched.data.data ?? fetched.data;

  if (action === "delete") {
    const { id, payloadHash, expiresAt } = await createPendingOperation(env, {
      adminId: admin.id,
      conversationId,
      tenantId: tenant.id,
      resourceKey,
      operation: "delete",
      recordId: intent.recordId,
      currentValues: existingRecord,
      proposedValues: {}
    });

    return {
      ok: true,
      kind: "write_preview",
      pendingOperationId: id,
      payloadHash,
      expiresAt,
      tenant: { id: tenant.id, name: tenant.name },
      resourceKey,
      operation: "delete",
      recordId: intent.recordId,
      destructive: true,
      changes: [],
      recordSnapshot: existingRecord
    };
  }

  // update
  const changes = [];
  for (const [field, proposed] of Object.entries(proposedValues)) {
    changes.push({ field, current: existingRecord[field] ?? null, proposed });
  }
  if (changes.length === 0) {
    return { ok: false, error: "no_fields_specified", message: "No fields were specified to change." };
  }

  const currentValuesForDiff = Object.fromEntries(changes.map((c) => [c.field, c.current]));

  const { id, payloadHash, expiresAt } = await createPendingOperation(env, {
    adminId: admin.id,
    conversationId,
    tenantId: tenant.id,
    resourceKey,
    operation: "update",
    recordId: intent.recordId,
    currentValues: currentValuesForDiff,
    proposedValues
  });

  return {
    ok: true,
    kind: "write_preview",
    pendingOperationId: id,
    payloadHash,
    expiresAt,
    tenant: { id: tenant.id, name: tenant.name },
    resourceKey,
    operation: "update",
    recordId: intent.recordId,
    destructive: false,
    changes
  };
}

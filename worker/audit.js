// =====================================================
// LUMMET AUDIT LOG (control-plane side)
// Records every registry mutation and every outbound
// tenant call attempt, including failures that never
// reached the tenant (e.g. decrypt failure). Never logs
// secrets or credential material.
// =====================================================

import { streamAudit } from "./audit-stream.js";

export async function logAudit(env, entry) {
  streamAudit(env, entry);   // AUDIT_LOG_STREAM=on only; independent of the D1 insert below
  try {
    await env.LUMMET_DB.prepare(
      `INSERT INTO lummet_audit_logs
        (admin_id, tenant_id, endpoint, method, resource, resource_id, action, success, status_code, error_message, request_id, ip_hash, initiated_by, ai_conversation_id, actor_type, customer_user_id, organization_id, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        entry.adminId || null,
        entry.tenantId || null,
        entry.endpoint || null,
        entry.method || null,
        entry.resource || null,
        entry.resourceId != null ? String(entry.resourceId) : null,
        entry.action || null,
        entry.success ? 1 : 0,
        entry.statusCode || null,
        entry.errorMessage || null,
        entry.requestId || null,
        entry.ipHash || null,
        // Additive (migration 0005): every pre-existing staff call site
        // omits these two fields and keeps logging exactly as before —
        // 'dashboard' is the correct default for all of them. Only the
        // AI confirm path (worker/ai/confirm.js) passes 'ai' + a
        // conversation id.
        entry.initiatedBy || "dashboard",
        entry.aiConversationId || null,
        // Additive (migration, SaaS merge — see docs/SAAS_MERGE_NOTES.md):
        // every audit row now also records WHO acted — a Lummet staff
        // member, a customer user, or the system (e.g. a billing
        // webhook). Existing staff call sites never pass actorType, so
        // they keep defaulting to 'lummet_admin' — unchanged behavior.
        entry.actorType || "lummet_admin",
        entry.customerUserId || null,
        entry.organizationId || null,
        entry.reason || null
      )
      .run();
  } catch (_) {
    // Audit logging must never break the response.
  }
}

const DEFAULT_RETENTION_DAYS = 90;

/**
 * Deletes control-plane audit log rows older than the retention
 * window. Called opportunistically from the health-check cron
 * (see cron.js) so the table doesn't grow unbounded — this never
 * runs as part of a request path, so a slow prune never affects
 * response latency. Never touches tenant-side super_audit_logs;
 * each tenant prunes its own (see the tenant repo's
 * en/worker/super/auth.js), since Lummet never writes to a
 * tenant's D1 directly (rule #22).
 */
export async function pruneAuditLogs(env, retentionDays = DEFAULT_RETENTION_DAYS) {
  try {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const result = await env.LUMMET_DB.prepare(
      `DELETE FROM lummet_audit_logs WHERE created_at < ?`
    )
      .bind(cutoff)
      .run();
    return { ok: true, deleted: result.meta?.changes ?? null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

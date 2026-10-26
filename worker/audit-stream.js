// =====================================================
// AUDIT STREAM (Round 6.3C)
//
// Logpush cannot read D1, so audit rows reach a log destination only if the Worker also writes them as log lines.
// AUDIT_LOG_STREAM=off (default) | on. With "on", each audit row is written once as one JSON line (event "audit") with an
// allowlisted set of fields; every string passes through redact.js. The D1 row is unchanged and stays the system of record.
// Left out on purpose: ip_hash, and anything not listed below. production-required together with LOG_REDACTION=on
// (config-check), because the audit text fields (reason, error message) are free text.
// =====================================================
import { redactText } from "./redact.js";

/** "on" only for that exact word (any case, surrounding spaces ignored); everything else is "off". */
export function auditStreamMode(env) {
  return String(env?.AUDIT_LOG_STREAM ?? "").trim().toLowerCase() === "on" ? "on" : "off";
}

const s = (v, max) => (v === undefined || v === null || v === "" ? undefined : redactText(String(v), { max }));

/** The log line for an audit entry (the same object logAudit receives), or null when the stream is off. Never throws. */
export function auditStreamLine(env, entry) {
  try {
    if (auditStreamMode(env) !== "on" || !entry || typeof entry !== "object") return null;
    return JSON.stringify({
      level: "info", event: "audit",
      action: s(entry.action, 80), resource: s(entry.resource, 80), resource_id: s(entry.resourceId, 80),
      success: !!entry.success, status_code: Number.isInteger(entry.statusCode) ? entry.statusCode : undefined,
      method: s(entry.method, 12), endpoint: s(String(entry.endpoint ?? "").split("?")[0], 160),
      request_id: s(entry.requestId, 64), actor_type: s(entry.actorType || "lummet_admin", 40), initiated_by: s(entry.initiatedBy || "dashboard", 40),
      admin_id: s(entry.adminId, 64), tenant_id: s(entry.tenantId, 64), organization_id: s(entry.organizationId, 64), customer_user_id: s(entry.customerUserId, 64),
      reason: s(entry.reason, 300), error_message: s(entry.errorMessage, 300)
    });
  } catch (_) {
    return null;
  }
}

/** Writes the audit line when the stream is on. Never throws. */
export function streamAudit(env, entry) {
  const line = auditStreamLine(env, entry);
  if (line) console.log(line);
}

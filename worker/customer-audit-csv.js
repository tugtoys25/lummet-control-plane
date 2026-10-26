// =====================================================
// CUSTOMER AUDIT-LOG CSV  (Round 6.4B, release 2.6.0.10)
//
// An organization admin or owner can download the organization's own audit trail as CSV, one bounded page per request.
//
//   CUSTOMER_AUDIT_CSV=off   (default) the route answers 404.
//   CUSTOMER_AUDIT_CSV=on    the route serves pages.
//
// * Org-scoped: the query filters on the organization id from the already-authorized route, nothing from the request can widen it.
// * Role-gated: admin or owner (the same rule as the JSON audit-log route). Billing, editor, analyst and viewer get 403.
// * Escaped and formula-injection safe: every cell goes through csvCell (revenue-analytics.js), the same helper the staff export uses.
// * Paginated: at most MAX_ROWS per page, newest first; the next page is named in the X-Next-Cursor header (an audit row id).
// * The export is itself audited, and so is a refused attempt.
// * ip_hash, staff ids and tenant ids are not exported.
// =====================================================

import { logAudit } from "./audit.js";
import { getMembership } from "./organizations.js";
import { roleAtLeast } from "./customer-rbac.js";
import { toCsv } from "./revenue-analytics.js";
import * as repo from "./repositories/org-audit-log.js";

export const AUDIT_CSV_MODES = ["off", "on"];
export const DEFAULT_ROWS = 1000;
export const MAX_ROWS = 5000;
export const CSV_HEADERS = ["id", "created_at", "actor_type", "customer_user_id", "action", "resource", "resource_id", "endpoint", "method", "success", "status_code", "error_message", "reason", "request_id"];

export function auditCsvMode(env) {
  const v = String((env && env.CUSTOMER_AUDIT_CSV) || "off").trim().toLowerCase();
  return AUDIT_CSV_MODES.includes(v) ? v : "off";
}

function parseLimit(raw) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_ROWS) : DEFAULT_ROWS;
}

export async function exportAuditCsv(env, { organizationId, actorUserId, limit, cursor, requestId = null, ipHash = null, endpoint = null, method = null }) {
  if (auditCsvMode(env) === "off") return { ok: false, status: 404, error: "not_available" };
  const audit = (action, ok, status, error, note) => logAudit(env, {
    actorType: "customer_user", customerUserId: actorUserId || null, organizationId: organizationId || null, endpoint, method,
    resource: "audit_log", resourceId: organizationId || null, action, success: ok, statusCode: status, errorMessage: ok ? null : error, reason: note || null, requestId, ipHash
  });

  const membership = actorUserId && organizationId ? await getMembership(env, organizationId, actorUserId) : null;
  if (!membership || !roleAtLeast(membership.role, "admin")) {
    await audit("audit_log_export_csv_refused", false, 403, "forbidden", null);
    return { ok: false, status: 403, error: "forbidden" };
  }
  let beforeId = null;
  if (cursor != null && cursor !== "") {
    if (!/^\d{1,15}$/.test(String(cursor))) {
      await audit("audit_log_export_csv_refused", false, 422, "invalid_cursor", null);
      return { ok: false, status: 422, error: "invalid_cursor" };
    }
    beforeId = Number(cursor);
  }
  const size = parseLimit(limit);
  const rows = await repo.page(env, { organizationId, limit: size + 1, beforeId });
  const more = rows.length > size;
  const pageRows = more ? rows.slice(0, size) : rows;
  const csv = toCsv(CSV_HEADERS, pageRows.map((r) => [
    r.id, r.created_at, r.actor_type, r.customer_user_id, r.action, r.resource, r.resource_id, r.endpoint, r.method,
    r.success ? 1 : 0, r.status_code, r.error_message, r.reason, r.request_id
  ]));
  await audit("audit_log_export_csv", true, 200, null, `rows ${pageRows.length}; from ${beforeId == null ? "newest" : `before id ${beforeId}`}`);
  return { ok: true, csv, rows: pageRows.length, nextCursor: more ? String(pageRows[pageRows.length - 1].id) : null };
}

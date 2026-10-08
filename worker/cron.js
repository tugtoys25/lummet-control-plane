// =====================================================
// SCHEDULED HEALTH CHECKS
// Runs on a Cron Trigger (see wrangler.jsonc `triggers`)
// and periodically calls each registered tenant's
// handshake endpoint, exactly the way a manual
// "Test connection" click does — through registry.js's
// testConnection(), which itself routes through client.js
// (rule #23). A timeout or failure here is NEVER treated
// as "the tenant is deleted" — only an explicit admin
// delete removes a registry row (rule #15).
// =====================================================

import * as registry from "./registry.js";

const DEFAULT_CONCURRENCY = 5;
const AUDIT_LOG_RETENTION_DAYS = 180;

/**
 * Deletes lummet_audit_logs rows older than the retention window.
 * Audit logs are for recent operational/security review, not
 * indefinite storage — old entries are pruned so the table (and
 * the Audit Logs page) stay usable as the control plane ages.
 * Only ever deletes by age; never touches tenant_health, the
 * registry, or any tenant's own data.
 */
export async function pruneOldAuditLogs(env, { retentionDays = AUDIT_LOG_RETENTION_DAYS } = {}) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const result = await env.LUMMET_DB.prepare(
    `DELETE FROM lummet_audit_logs WHERE created_at < ?`
  ).bind(cutoff).run();

  return { deleted: result?.meta?.changes ?? 0, cutoff };
}

/**
 * Checks every registered tenant (active and disabled — disabled
 * ones resolve instantly to a "Disabled" status without making a
 * network call, via testConnection's own early return) in small
 * concurrent batches, to stay well within a scheduled Worker's
 * execution budget even with many tenants registered.
 */
export async function runHealthChecks(env, { concurrency = DEFAULT_CONCURRENCY } = {}) {
  const result = await env.LUMMET_DB.prepare(`SELECT id FROM tenants`).all();
  const tenantIds = (result.results || []).map((row) => row.id);

  const summary = {
    checked: 0,
    online: 0,
    disabled: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    results: []
  };

  for (let i = 0; i < tenantIds.length; i += concurrency) {
    const batch = tenantIds.slice(i, i + concurrency);

    const outcomes = await Promise.all(
      batch.map(async (tenantId) => {
        try {
          const outcome = await registry.testConnection(env, tenantId);
          return { tenantId, outcome };
        } catch (error) {
          // testConnection is designed not to throw for ordinary
          // failure modes, but guard against a genuine bug here so
          // one bad tenant can never abort the whole cron run.
          return {
            tenantId,
            outcome: { ok: false, status: 500, error: "unexpected_exception" }
          };
        }
      })
    );

    for (const { tenantId, outcome } of outcomes) {
      summary.checked += 1;

      if (outcome.ok) {
        summary.online += 1;
      } else if (outcome.error === "tenant_disabled") {
        summary.disabled += 1;
      } else {
        summary.failed += 1;
      }

      summary.results.push({ tenantId, ok: outcome.ok, error: outcome.ok ? null : outcome.error });
    }
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}

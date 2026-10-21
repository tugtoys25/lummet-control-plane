// =====================================================
// AUTOMATION ENGINE (master prompt section 29)
//
// Trigger -> conditions -> actions, driven by the same platform
// events webhooks use (payment.failed, site.failed,
// subscription.changed, ...). No arbitrary code: actions come from
// the fixed ACTIONS registry below, conditions are a closed set of
// comparison operators over the event payload.
//
// Safety:
//  - tenant-scoped: only rules of the event's own organization run
//  - idempotent: UNIQUE(rule_id, event_id) — a replayed event is a no-op
//  - rate-limited: max_runs_per_hour per rule
//  - loop-safe: actions never emit platform events, so an automation
//    cannot trigger itself or another automation
//  - plan-gated: needs entitlement automations.enabled
// =====================================================
import * as entitlementsService from "./entitlements.js";
import { queueEmail, flushOutbox, portalLink } from "./email.js";
import { recordUsage } from "./usage.js";
import { disableTrackingLinks } from "./tenant-links.js";
import { logAudit } from "./audit.js";

const OPS = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  gt: (a, b) => typeof a === "number" && a > b,
  gte: (a, b) => typeof a === "number" && a >= b,
  lt: (a, b) => typeof a === "number" && a < b,
  lte: (a, b) => typeof a === "number" && a <= b,
  in: (a, b) => Array.isArray(b) && b.includes(a)
};

export const TRIGGER_EVENTS = ["site.created", "site.provisioned", "site.deployed", "site.failed", "domain.verified", "subscription.changed", "payment.failed", "usage.limit_reached", "report.completed", "tracking_link.unhealthy"];

export const ACTIONS = {
  // Email every owner/admin of the organization.
  async notify_owners(env, { organizationId, rule, event }, params) {
    const subject = String(params.subject || `Automation: ${rule.name}`).slice(0, 120);
    const owners = await env.LUMMET_DB.prepare(
      `SELECT u.email FROM organization_users ou JOIN customer_users u ON u.id = ou.user_id WHERE ou.organization_id = ? AND ou.role IN ('owner','admin')`
    ).bind(organizationId).all();
    let queued = 0;
    for (const o of owners.results) {
      const q = await queueEmail(env, {
        to: o.email, template: "notification", organizationId, dedupeKey: `auto:${rule.id}:${event.id}:${o.email}`,
        vars: { link: portalLink(env, "/app/overview") || "", subject, message: String(params.message || `${rule.name} fired on ${event.type}`).slice(0, 500) }
      });
      if (q.ok && !q.duplicate) queued++;
    }
    if (queued) await flushOutbox(env).catch(() => {});
    return { queued };
  },
  // Record an in-app alert (visible to the organization).
  async create_alert(env, { organizationId, rule, event }, params) {
    await env.LUMMET_DB.prepare(`INSERT INTO automation_alerts (organization_id, rule_id, message) VALUES (?, ?, ?)`)
      .bind(organizationId, rule.id, String(params.message || `${rule.name}: ${event.type}`).slice(0, 500)).run();
    return { alert: true };
  },
  // Switch off the tracking link an event is about (tracking_link.unhealthy). Reversible on the site's dashboard.
  async disable_tracking_link(env, { organizationId, rule, event }) {
    const siteId = event.data?.siteId, linkId = event.data?.trackingLinkId;
    if (typeof siteId !== "string" || !Number.isInteger(linkId)) throw new Error("event_has_no_tracking_link");
    const r = await disableTrackingLinks(env, { organizationId, siteId, ids: [linkId] });
    await logAudit(env, {
      actorType: "system", initiatedBy: "automation", organizationId, endpoint: "automation:" + rule.id, method: "PUT",
      resource: "tracking_link", resourceId: `${siteId}:${linkId}`, action: "disable", success: r.ok && r.disabled === 1,
      statusCode: r.ok ? 200 : r.status, errorMessage: r.ok ? (r.results[0].ok ? null : r.results[0].error) : r.error
    });
    if (!r.ok) throw new Error(r.error);
    if (r.disabled !== 1) throw new Error(r.results[0].error || "tenant_error");
    return { disabled: linkId };
  },
  // Meter an automation execution for usage reporting.
  async count_usage(env, { organizationId, rule, event }) {
    await recordUsage(env, { organizationId, metric: "automation_runs", quantity: 1, idempotencyKey: `auto:${rule.id}:${event.id}` });
    return { counted: true };
  }
};

function getPath(obj, path) {
  return String(path).split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}

export function conditionsMatch(conditions, data) {
  return conditions.every((c) => OPS[c.op] && OPS[c.op](getPath(data, c.field), c.value));
}

export function validateRule({ name, triggerEvent, conditions = [], actions, maxRunsPerHour = 10 }) {
  if (!name || !String(name).trim() || String(name).length > 100) return "invalid_name";
  if (!TRIGGER_EVENTS.includes(triggerEvent)) return "invalid_trigger_event";
  if (!Array.isArray(conditions) || conditions.length > 10) return "invalid_conditions";
  for (const c of conditions) {
    if (!c || typeof c.field !== "string" || !/^[a-zA-Z0-9_.]{1,60}$/.test(c.field) || !OPS[c.op]) return "invalid_condition";
    if (!["string", "number", "boolean"].includes(typeof c.value) && !Array.isArray(c.value)) return "invalid_condition_value";
  }
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 5) return "invalid_actions";
  for (const a of actions) if (!a || !ACTIONS[a.type]) return "unknown_action";
  if (!Number.isInteger(maxRunsPerHour) || maxRunsPerHour < 1 || maxRunsPerHour > 100) return "invalid_rate_limit";
  return null;
}

export async function createRule(env, organizationId, input, createdBy) {
  if (!(await entitlementsService.requireEntitlement(env, organizationId, "automations.enabled"))) return { ok: false, status: 403, error: "automations_not_enabled" };
  const err = validateRule(input);
  if (err) return { ok: false, status: 422, error: err };
  const count = await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM automation_rules WHERE organization_id = ?`).bind(organizationId).first();
  if (count.n >= 25) return { ok: false, status: 409, error: "rule_limit_reached" };
  const id = crypto.randomUUID();
  await env.LUMMET_DB.prepare(
    `INSERT INTO automation_rules (id, organization_id, name, trigger_event, conditions, actions, max_runs_per_hour, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, organizationId, String(input.name).trim(), input.triggerEvent, JSON.stringify(input.conditions || []), JSON.stringify(input.actions), input.maxRunsPerHour || 10, createdBy).run();
  return { ok: true, ruleId: id };
}

export async function listRules(env, organizationId) {
  const r = await env.LUMMET_DB.prepare(`SELECT * FROM automation_rules WHERE organization_id = ? ORDER BY created_at DESC`).bind(organizationId).all();
  return r.results.map((x) => ({ ...x, conditions: JSON.parse(x.conditions), actions: JSON.parse(x.actions) }));
}

export async function setRuleStatus(env, organizationId, ruleId, status) {
  if (!["active", "paused"].includes(status)) return { ok: false, status: 422, error: "invalid_status" };
  const r = await env.LUMMET_DB.prepare(`UPDATE automation_rules SET status = ? WHERE id = ? AND organization_id = ?`).bind(status, ruleId, organizationId).run();
  return r.meta.changes ? { ok: true } : { ok: false, status: 404, error: "not_found" };
}

export async function deleteRule(env, organizationId, ruleId) {
  const r = await env.LUMMET_DB.prepare(`DELETE FROM automation_rules WHERE id = ? AND organization_id = ?`).bind(ruleId, organizationId).run();
  return r.meta.changes ? { ok: true } : { ok: false, status: 404, error: "not_found" };
}

export async function listRuns(env, organizationId, limit = 50) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT r.id, r.rule_id, r.event_id, r.status, r.action_results, r.created_at, ru.name AS rule_name
     FROM automation_runs r JOIN automation_rules ru ON ru.id = r.rule_id WHERE r.organization_id = ? ORDER BY r.created_at DESC LIMIT ?`
  ).bind(organizationId, Math.min(limit, 200)).all();
  return r.results;
}

/** Called for every platform event. Never throws. */
export async function runAutomations(env, organizationId, eventType, data, eventId = crypto.randomUUID()) {
  try {
    const rules = await env.LUMMET_DB.prepare(
      `SELECT * FROM automation_rules WHERE organization_id = ? AND trigger_event = ? AND status = 'active'`
    ).bind(organizationId, eventType).all();
    if (!rules.results.length) return { ran: 0 };
    if (!(await entitlementsService.requireEntitlement(env, organizationId, "automations.enabled"))) return { ran: 0, gated: true };
    const event = { id: eventId, type: eventType, data };
    let ran = 0;
    for (const rule of rules.results) {
      if (!conditionsMatch(JSON.parse(rule.conditions), data || {})) continue;
      // Claim the (rule, event) pair BEFORE running any action: the UNIQUE
      // constraint makes a replayed/duplicate event a no-op instead of
      // running side effects twice.
      const runId = crypto.randomUUID();
      try {
        await env.LUMMET_DB.prepare(`INSERT INTO automation_runs (id, rule_id, organization_id, event_id, status) VALUES (?, ?, ?, ?, 'running')`)
          .bind(runId, rule.id, organizationId, eventId).run();
      } catch (e) { if (/UNIQUE/i.test(String(e.message))) continue; throw e; }

      const recent = await env.LUMMET_DB.prepare(
        `SELECT COUNT(*) n FROM automation_runs WHERE rule_id = ? AND id != ? AND status NOT IN ('skipped_rate_limited') AND created_at >= datetime('now','-1 hour')`
      ).bind(rule.id, runId).first();
      const limited = recent.n >= rule.max_runs_per_hour;
      const results = []; let failures = 0;
      if (!limited) {
        for (const a of JSON.parse(rule.actions)) {
          try { results.push({ type: a.type, ok: true, ...(await ACTIONS[a.type](env, { organizationId, rule, event }, a.params || {})) }); }
          catch (e) { failures++; results.push({ type: a.type, ok: false, error: "action_failed" }); }
        }
      }
      const status = limited ? "skipped_rate_limited" : failures === 0 ? "success" : failures === results.length ? "failed" : "partial";
      await env.LUMMET_DB.prepare(`UPDATE automation_runs SET status = ?, action_results = ? WHERE id = ?`).bind(status, JSON.stringify(results), runId).run();
      if (!limited) ran++;
    }
    return { ran };
  } catch (_) { return { ran: 0, error: true }; }
}

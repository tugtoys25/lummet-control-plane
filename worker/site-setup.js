// =====================================================
// SITE SETUP (Phase 9)
//
// How a NEW tenant gets its first configuration: a preset ("News site only", ...) or a copy of another site's configuration.
// The control plane never touches a tenant's database; it asks the tenant's own Super API (worker/client.js requestTenant, the
// only way to reach one) to apply the setup:
//   preset  ->  POST /en/api/super/site-setup  { preset }
//   clone   ->  GET  /en/api/super/site-config-export on the SOURCE tenant, then POST /en/api/super/site-setup { envelope, sections } on the target
//
// Principles: safe by default (no preset = "full", the whole platform), fail-open (a failed apply never fails provisioning or the
// site; the tenant already starts in the setup wizard through the first-deploy seed in tenant-defaults.js), nothing is overwritten
// (a tenant that is already set up or already changed by its owner answers 409 and the request becomes "skipped"), and nothing secret
// is stored or logged: a request keeps ids, preset names and a short error code, never an envelope.
// =====================================================

import { requestTenant as realRequestTenant } from "./client.js";
import * as repo from "./repositories/site-setup.js";

/** Mirror of the tenant's presets (lummet-tenant en/worker/site-profile/registry.js PRESETS). Labels are for the staff and customer screens. */
export const SITE_PRESETS = Object.freeze([
  Object.freeze({ id: "full", label: "Full platform" }),
  Object.freeze({ id: "news", label: "News site only" }),
  Object.freeze({ id: "casino-list", label: "Casino listing only" }),
  Object.freeze({ id: "casino-only", label: "Casino listing, no homepage" }),
  Object.freeze({ id: "list-reviews", label: "Listing + reviews" }),
  Object.freeze({ id: "sportsbook", label: "Sportsbook listing" }),
  Object.freeze({ id: "research", label: "Research publication" }),
  Object.freeze({ id: "static", label: "Static website" })
]);
export const SITE_PRESET_IDS = Object.freeze(SITE_PRESETS.map((p) => p.id));
export const DEFAULT_PRESET_ID = "full";

export const SETUP_STATUSES = Object.freeze(["pending", "applied", "failed", "skipped"]);
export const MAX_ENVELOPE_BYTES = 900 * 1024;
const MAX_SECTIONS = 40;
const SECTION_RE = /^[A-Za-z0-9._-]{1,60}$/;

const SETUP_PATH = "/en/api/super/site-setup";
const EXPORT_PATH = "/en/api/super/site-config-export";
const SYSTEM_PATH = "/en/api/super/site-system";
const CLONE_TIMEOUT_MS = 20000;
const ERROR_CODE_RE = /^[a-z0-9_]{1,60}$/;
/** Tenant answers (HTTP 409 `reason`) that mean "leave the tenant as it is" and end the request as skipped, never failed. */
export const SKIP_REASONS = Object.freeze(["setup_not_pending", "already_configured", "config_system_off"]);

export const presetLabel = (id) => SITE_PRESETS.find((p) => p.id === id)?.label || null;

/** { ok: true, id } for one of the known preset ids (exact, case sensitive after trimming), else { ok: false, error: "unknown_preset" }. */
export function validatePresetId(value) {
  if (typeof value !== "string") return { ok: false, error: "unknown_preset" };
  const id = value.trim();
  return SITE_PRESET_IDS.includes(id) ? { ok: true, id } : { ok: false, error: "unknown_preset" };
}

/** Sections are plain strings; anything else is refused (never coerced). Empty or missing means "everything the tenant exports". */
export function cleanSections(value) {
  if (value === undefined || value === null) return { ok: true, sections: null };
  if (!Array.isArray(value) || value.length > MAX_SECTIONS) return { ok: false, error: "invalid_sections" };
  const out = [];
  for (const s of value) {
    if (typeof s !== "string" || !SECTION_RE.test(s.trim())) return { ok: false, error: "invalid_sections" };
    if (!out.includes(s.trim())) out.push(s.trim());
  }
  return { ok: true, sections: out.length ? out : null };
}

// -----------------------------------------------------
// Default preset per plan / product
// -----------------------------------------------------

export const listDefaults = (env) => repo.listDefaults(env);

/** Sets (or, with presetId null/empty, clears) the default for one plan or product. */
export async function setDefault(env, { scopeKind, scopeId, presetId, updatedBy }) {
  if (scopeKind !== "plan" && scopeKind !== "product") return { ok: false, status: 422, error: "invalid_scope_kind" };
  const id = typeof scopeId === "string" ? scopeId.trim() : "";
  if (!id || id.length > 120) return { ok: false, status: 422, error: "scope_id_required" };
  if (!(await repo.scopeExists(env, scopeKind, id))) return { ok: false, status: 404, error: scopeKind === "plan" ? "plan_not_found" : "product_not_found" };
  if (presetId === null || presetId === undefined || presetId === "") {
    await repo.deleteDefault(env, scopeKind, id);
    return { ok: true, cleared: true, scopeKind, scopeId: id };
  }
  const v = validatePresetId(presetId);
  if (!v.ok) return { ok: false, status: 422, error: v.error };
  await repo.upsertDefault(env, { scopeKind, scopeId: id, presetId: v.id, updatedBy: updatedBy ? String(updatedBy).slice(0, 80) : null });
  return { ok: true, scopeKind, scopeId: id, presetId: v.id };
}

async function defaultFor(env, kind, id) {
  if (!id) return null;
  const preset = await repo.findDefaultPreset(env, kind, id);
  // A stored id that is no longer a known preset is ignored rather than trusted (a tenant would refuse it anyway).
  return preset && SITE_PRESET_IDS.includes(preset) ? preset : null;
}

/**
 * Which preset a new site starts from: an explicit choice, else the default of the organization's current plan, else the default of
 * the product, else "full". Returns { presetId, source: "explicit" | "plan" | "product" | "fallback" }.
 */
export async function resolveDefaultPreset(env, { organizationId, productId, explicit } = {}) {
  if (explicit !== undefined && explicit !== null && explicit !== "") {
    const v = validatePresetId(explicit);
    return v.ok ? { presetId: v.id, source: "explicit" } : { presetId: null, source: "explicit", error: v.error };
  }
  if (organizationId) {
    const planId = await repo.currentPlanId(env, organizationId);
    const fromPlan = planId ? await defaultFor(env, "plan", planId) : null;
    if (fromPlan) return { presetId: fromPlan, source: "plan" };
  }
  const fromProduct = await defaultFor(env, "product", productId);
  if (fromProduct) return { presetId: fromProduct, source: "product" };
  return { presetId: DEFAULT_PRESET_ID, source: "fallback" };
}

// -----------------------------------------------------
// Requests
// -----------------------------------------------------

/**
 * Checks a setup choice and works out what to store, WITHOUT writing anything (createSite uses this before it inserts the site).
 *   input: { preset?, cloneFromSiteId?, cloneFromTenantId?, sections?, organizationId, productId, targetSiteId?, staff? }
 * A customer (staff falsy) may clone only from an ACTIVE site of the SAME organization; a missing site and a site of another
 * organization answer the same 404, so nothing leaks. Staff may clone from any registered, enabled tenant by id.
 * Returns { ok: true, plan: { kind, presetId, presetSource, sourceTenantId, sections } } or { ok: false, status, error }.
 */
export async function planSetup(env, input = {}) {
  const hasPreset = input.preset !== undefined && input.preset !== null && input.preset !== "";
  const hasSiteSource = input.cloneFromSiteId !== undefined && input.cloneFromSiteId !== null && input.cloneFromSiteId !== "";
  const hasTenantSource = input.cloneFromTenantId !== undefined && input.cloneFromTenantId !== null && input.cloneFromTenantId !== "";
  if ((hasSiteSource || hasTenantSource) && hasPreset) return { ok: false, status: 422, error: "choose_one" };
  if (hasSiteSource && hasTenantSource) return { ok: false, status: 422, error: "choose_one" };
  if (hasTenantSource && !input.staff) return { ok: false, status: 403, error: "forbidden" };

  const sec = cleanSections(input.sections);
  if (!sec.ok) return { ok: false, status: 422, error: sec.error };

  if (hasSiteSource || hasTenantSource) {
    let sourceTenantId = null;
    if (hasSiteSource) {
      if (typeof input.cloneFromSiteId !== "string") return { ok: false, status: 404, error: "clone_source_not_found" };
      const src = await repo.findSite(env, input.cloneFromSiteId);
      const sameOrg = src && input.organizationId && src.organization_id === input.organizationId;
      if (!src || (!input.staff && !sameOrg)) return { ok: false, status: 404, error: "clone_source_not_found" };
      if (src.status !== "active" || !src.tenant_id) return { ok: false, status: 409, error: "clone_source_not_active" };
      if (input.targetSiteId && src.id === input.targetSiteId) return { ok: false, status: 422, error: "clone_source_is_target" };
      sourceTenantId = src.tenant_id;
    } else {
      if (typeof input.cloneFromTenantId !== "string") return { ok: false, status: 404, error: "clone_source_not_found" };
      const t = await repo.findTenant(env, input.cloneFromTenantId);
      if (!t) return { ok: false, status: 404, error: "clone_source_not_found" };
      if (t.status !== "active") return { ok: false, status: 409, error: "clone_source_not_active" };
      // A tenant that belongs to a site must belong to a live one: a suspended or deleted customer site is not a source.
      const linked = await repo.findSiteByTenant(env, t.id);
      if (linked && linked.status !== "active") return { ok: false, status: 409, error: "clone_source_not_active" };
      if (input.targetTenantId && t.id === input.targetTenantId) return { ok: false, status: 422, error: "clone_source_is_target" };
      if (linked && input.targetSiteId && linked.id === input.targetSiteId) return { ok: false, status: 422, error: "clone_source_is_target" };
      sourceTenantId = t.id;
    }
    return { ok: true, plan: { kind: "clone", presetId: null, presetSource: null, sourceTenantId, sections: sec.sections } };
  }

  const resolved = await resolveDefaultPreset(env, { organizationId: input.organizationId, productId: input.productId, explicit: hasPreset ? input.preset : undefined });
  if (!resolved.presetId) return { ok: false, status: 422, error: resolved.error || "unknown_preset" };
  return { ok: true, plan: { kind: "preset", presetId: resolved.presetId, presetSource: resolved.source, sourceTenantId: null, sections: null } };
}

/** Stores a planned request. Earlier requests of the same target that are still open are marked skipped (superseded), never deleted. */
export async function storeSetupRequest(env, { siteId = null, tenantId = null, plan, requestedBy = null }) {
  const id = crypto.randomUUID();
  if (siteId) await repo.supersedeOpen(env, "site", siteId);
  else if (tenantId) await repo.supersedeOpen(env, "tenant", tenantId);
  await repo.insertRequest(env, {
    id, siteId, tenantId, kind: plan.kind, presetId: plan.presetId, sourceTenantId: plan.sourceTenantId,
    sections: plan.sections ? JSON.stringify(plan.sections) : null, requestedBy: requestedBy ? String(requestedBy).slice(0, 80) : null
  });
  return id;
}

/** Plan + store in one step: { ok, requestId, kind, presetId, presetSource } or { ok: false, status, error }. */
export async function createSetupRequest(env, input = {}) {
  const planned = await planSetup(env, input);
  if (!planned.ok) return planned;
  const requestId = await storeSetupRequest(env, { siteId: input.siteId || null, tenantId: input.tenantId || null, plan: planned.plan, requestedBy: input.requestedBy });
  return { ok: true, requestId, kind: planned.plan.kind, presetId: planned.plan.presetId, presetSource: planned.plan.presetSource, sourceTenantId: planned.plan.sourceTenantId };
}

const getRequest = repo.getRequest;

const latestRequestForSite = repo.latestRequestForSite;

function parseSections(raw) {
  if (!raw) return null;
  try { const v = JSON.parse(raw); const c = cleanSections(v); return c.ok ? c.sections : null; } catch (_) { return null; }
}

async function finish(env, id, status, lastError) {
  await repo.setOutcome(env, id, status, lastError);
  return { ok: status !== "failed", status, error: lastError || null, requestId: id };
}

// A short, safe description of a failed call: the tenant's error code (only if it looks like one) and the HTTP status. Never the body.
function describeFailure(res, prefix = "") {
  const code = ERROR_CODE_RE.test(String(res?.reason || "")) ? res.reason : "tenant_error";
  return `${prefix}${code} (HTTP ${Number(res?.status) || 0})`.slice(0, 120);
}

/**
 * Applies one request on its tenant. Safe to call again: an applied or skipped request is answered without calling the tenant, and
 * the tenant itself treats a repeat of the same preset as "alreadyApplied". Never throws; the outcome is recorded on the request.
 *   200 / alreadyApplied                      -> applied
 *   409 setup_not_pending | already_configured | config_system_off -> skipped  (the tenant keeps what it has; this is not an error.
 *       config_system_off: the owner switched the configurable platform off for that site, so there is nothing to apply and nothing to retry)
 *   anything else                              -> failed, with a short code in last_error (retry later)
 * opts.request replaces requestTenant (tests); env.SETUP_TENANT_REQUEST does the same for route tests.
 */
export async function applySetup(env, requestId, opts = {}) {
  const request = opts.request || env.SETUP_TENANT_REQUEST || realRequestTenant;
  let row;
  try {
    row = await getRequest(env, requestId);
    if (!row) return { ok: false, status: "not_found", error: "request_not_found", requestId };
    if (row.status === "applied" || row.status === "skipped") return { ok: true, status: row.status, alreadyDone: true, requestId };

    // The sweep passes the updated_at it read: if another driver already counted an attempt for this request, step aside (the tenant
    // call is idempotent, but the attempts count must not double). Deploy and manual retry pass nothing and always run.
    const counted = await repo.bumpAttempts(env, requestId, opts.expectedUpdatedAt || null);
    if (!counted) return { ok: true, status: "busy", busy: true, requestId };

    let tenantId = row.tenant_id;
    if (!tenantId && row.site_id) {
      const site = await repo.findSite(env, row.site_id);
      tenantId = site?.tenant_id || null;
    }
    if (!tenantId) return await finish(env, requestId, "failed", "no_tenant");

    const timeoutMs = opts.timeoutMs || (row.kind === "clone" ? CLONE_TIMEOUT_MS : undefined);
    let body;
    if (row.kind === "clone") {
      if (!row.source_tenant_id) return await finish(env, requestId, "failed", "no_clone_source");
      const sections = parseSections(row.sections);
      const path = sections ? `${EXPORT_PATH}?sections=${sections.map(encodeURIComponent).join(",")}` : EXPORT_PATH;
      const exported = await request(env, row.source_tenant_id, { method: "GET", path, timeoutMs });
      if (!exported || !exported.ok) return await finish(env, requestId, "failed", describeFailure(exported, "source_"));
      const envelope = exported.data?.envelope;
      if (!envelope || typeof envelope !== "object") return await finish(env, requestId, "failed", "source_empty_export");
      let size = 0;
      try { size = new TextEncoder().encode(JSON.stringify(envelope)).length; } catch (_) { size = Infinity; }
      if (size > MAX_ENVELOPE_BYTES) return await finish(env, requestId, "failed", "envelope_too_large");
      body = sections ? { envelope, sections } : { envelope };
    } else {
      const v = validatePresetId(row.preset_id);
      if (!v.ok) return await finish(env, requestId, "failed", "unknown_preset");
      body = { preset: v.id };
    }

    const res = await request(env, tenantId, { method: "POST", path: SETUP_PATH, body, timeoutMs });
    if (res && res.ok) return await finish(env, requestId, "applied", null);
    if (res && res.status === 409 && SKIP_REASONS.includes(res.reason)) {
      return await finish(env, requestId, "skipped", res.reason);
    }
    return await finish(env, requestId, "failed", describeFailure(res));
  } catch (error) {
    // Fail-open: whatever went wrong, the site stays as it is and the request says "failed" so it can be retried.
    try { return await finish(env, requestId, "failed", "internal_error"); } catch (_) { return { ok: false, status: "failed", error: "internal_error", requestId }; }
  }
}

/** Called after a site's first successful deploy: applies the site's newest request if it is still pending. Never throws. */
export async function applyPendingSetupForSite(env, siteId, opts = {}) {
  try {
    const row = await latestRequestForSite(env, siteId);
    if (!row) return { attempted: false, reason: "no_request" };
    if (row.status !== "pending") return { attempted: false, reason: `already_${row.status}`, requestId: row.id, status: row.status };
    const r = await applySetup(env, row.id, opts);
    return { attempted: true, requestId: row.id, kind: row.kind, status: r.status, ok: r.ok, error: r.error || undefined };
  } catch (_) {
    return { attempted: true, ok: false, status: "failed", error: "internal_error" };
  }
}

/** Re-runs the newest request of a site when it is pending or failed. { ok, status } or { ok: false, httpStatus, error }. */
export async function retrySetup(env, siteId, opts = {}) {
  const site = await repo.findSite(env, siteId);
  if (!site) return { ok: false, httpStatus: 404, error: "not_found" };
  const row = await latestRequestForSite(env, siteId);
  if (!row) return { ok: false, httpStatus: 404, error: "no_setup_request" };
  if (row.status === "applied" || row.status === "skipped") return { ok: false, httpStatus: 409, error: "nothing_to_retry", status: row.status };
  if (!site.tenant_id || !["active", "maintenance"].includes(site.status)) return { ok: false, httpStatus: 409, error: "site_not_ready", siteStatus: site.status };
  const r = await applySetup(env, row.id, opts);
  return { ok: r.ok, httpStatus: r.ok ? 200 : 502, status: r.status, error: r.error || null, requestId: row.id };
}

/** What a screen shows for a request. Staff also see where a copy comes from and who asked. */
export function publicView(row, { staff = false } = {}) {
  if (!row) return { status: "none" };
  const v = {
    id: row.id, kind: row.kind, presetId: row.preset_id, presetLabel: presetLabel(row.preset_id),
    sections: parseSections(row.sections), status: row.status, attempts: row.attempts, lastError: row.last_error,
    requestedAt: row.requested_at, appliedAt: row.applied_at, updatedAt: row.updated_at
  };
  if (staff) { v.sourceTenantId = row.source_tenant_id; v.requestedBy = row.requested_by; v.tenantId = row.tenant_id; v.siteId = row.site_id; }
  return v;
}

export async function getSetupForSite(env, siteId, { staff = false } = {}) {
  return publicView(await latestRequestForSite(env, siteId), { staff });
}

export async function getSetupRequestView(env, requestId, { staff = false } = {}) {
  return publicView(await getRequest(env, requestId), { staff });
}

// -----------------------------------------------------
// Picker (what the create-site screen offers)
// -----------------------------------------------------

/**
 * What a customer may choose when creating a site: every preset, the one that applies if they choose nothing (explicit > plan >
 * product > full), and their own active sites they may copy from. Read-only, names only.
 */
export async function getSetupOptions(env, { organizationId, productId = null } = {}) {
  const resolved = await resolveDefaultPreset(env, { organizationId, productId });
  const sources = organizationId ? await repo.listCloneSources(env, organizationId) : [];
  return {
    presets: SITE_PRESETS.map((p) => ({ id: p.id, label: p.label })),
    default: { presetId: resolved.presetId, label: presetLabel(resolved.presetId), source: resolved.source },
    cloneSources: sources.map((s) => ({ id: s.id, name: s.name, productName: s.product_name || null }))
  };
}

/** Newest setup request per site for an organization, as { [siteId]: view } (customer view, no staff fields). */
export async function getSetupViewsForOrganization(env, organizationId) {
  const out = {};
  for (const row of await repo.latestRequestsForOrganization(env, organizationId)) out[row.site_id] = publicView(row);
  return out;
}

// -----------------------------------------------------
// Retry sweep (runs on the 5 minute tick)
// -----------------------------------------------------

export const SWEEP_MAX_ATTEMPTS = 6;
export const SWEEP_MAX_PER_TICK = 5;
export const SWEEP_GRACE_MINUTES = 10;       // a request that was never attempted waits this long before the sweep takes it (the deploy path normally applies it first)
export const SWEEP_BASE_MINUTES = 5;
export const SWEEP_MAX_BACKOFF_MINUTES = 360;
const SWEEP_OFF = new Set(["off", "0", "false", "disabled", "no"]);

/** The sweep is on unless env.SETUP_RETRY_SWEEP says off. Anything else, or nothing, means on. */
export const sweepEnabled = (env) => !SWEEP_OFF.has(String(env?.SETUP_RETRY_SWEEP ?? "").trim().toLowerCase());

/** Minutes to wait after the last attempt: none yet -> grace; then 5, 10, 20, 40, 80 ... capped at 6 hours. */
export function backoffMinutes(attempts) {
  const n = Number(attempts) || 0;
  if (n <= 0) return SWEEP_GRACE_MINUTES;
  return Math.min(SWEEP_BASE_MINUTES * 2 ** (n - 1), SWEEP_MAX_BACKOFF_MINUTES);
}

// "YYYY-MM-DD HH:MM:SS" (SQLite CURRENT_TIMESTAMP, UTC) or ISO. NaN when unreadable, which counts as NOT due (never guess).
const stamp = (v) => { const s = String(v || ""); const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(" ", "T") : `${s.replace(" ", "T")}Z`); return t; };

export function isDue(row, now = Date.now()) {
  if (!row || (row.status !== "pending" && row.status !== "failed")) return false;
  if ((Number(row.attempts) || 0) >= SWEEP_MAX_ATTEMPTS) return false;
  const since = Number(row.attempts) > 0 ? stamp(row.updated_at) : stamp(row.requested_at);
  return Number.isFinite(since) && now - since >= backoffMinutes(row.attempts) * 60000;
}

/**
 * Retries pending and failed setup requests with exponential backoff, at most SWEEP_MAX_PER_TICK per run and SWEEP_MAX_ATTEMPTS
 * attempts per request (the deploy-time apply counts as attempt 1). A request that used every attempt stays "failed" and is shown to
 * staff as given up; staff or the customer can still retry it by hand. Never throws. Disabled with SETUP_RETRY_SWEEP=off.
 * opts.request / env.SETUP_TENANT_REQUEST replace the tenant call (tests); opts.now is a ms timestamp.
 */
export async function sweepSetupRetries(env, opts = {}) {
  const summary = { enabled: sweepEnabled(env), looked: 0, due: 0, applied: 0, skipped: 0, failed: 0, busy: 0 };
  if (!summary.enabled) return summary;
  try {
    const now = opts.now ?? Date.now();
    const candidates = await repo.listRetryCandidates(env, { maxAttempts: SWEEP_MAX_ATTEMPTS, limit: 50 });
    summary.looked = candidates.length;
    const due = candidates.filter((c) => isDue(c, now)).slice(0, opts.max ?? SWEEP_MAX_PER_TICK);
    summary.due = due.length;
    for (const c of due) {
      const r = await applySetup(env, c.id, { ...opts, expectedUpdatedAt: c.updated_at });
      if (r.status === "busy") { summary.busy += 1; continue; }
      if (r.status === "applied") summary.applied++; else if (r.status === "skipped") summary.skipped++; else summary.failed++;
    }
  } catch (_) { summary.error = "sweep_failed"; }
  return summary;
}

/** Numbers for the staff screen. */
export async function getSetupOverview(env) {
  const c = await repo.countByStatus(env, SWEEP_MAX_ATTEMPTS);
  return { ...c, sweep: { enabled: sweepEnabled(env), maxAttempts: SWEEP_MAX_ATTEMPTS, maxPerTick: SWEEP_MAX_PER_TICK, graceMinutes: SWEEP_GRACE_MINUTES } };
}

export async function listRecentSetupRequests(env, opts = {}) {
  const status = SETUP_STATUSES.includes(opts.status) ? opts.status : null;
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  return (await repo.listRecentRequests(env, { status, limit })).map((r) => ({
    id: r.id, siteId: r.site_id, siteName: r.site_name || null, tenantId: r.tenant_id, kind: r.kind, presetId: r.preset_id, presetLabel: presetLabel(r.preset_id),
    status: r.status, attempts: r.attempts, lastError: r.last_error, gaveUp: r.status === "failed" && r.attempts >= SWEEP_MAX_ATTEMPTS,
    requestedAt: r.requested_at, appliedAt: r.applied_at, updatedAt: r.updated_at
  }));
}

// -----------------------------------------------------
// Master switch of a site (Phase 10 B7). Read-only: the control plane only LOOKS at the tenant's switch (Super API v17), it never
// flips it. The tenant must run a release that has v17 first; an older tenant answers 404/405/501, which is reported as
// "tenant_not_updated" (deploy the release first), not as a failure of the site.
// -----------------------------------------------------

const SYSTEM_SOURCES = Object.freeze(["env", "setting", "default"]);
const NOT_UPDATED_STATUSES = Object.freeze([404, 405, 501]);

/** { ok: true, system: { enabled, source, envOverride } } or { ok: false, httpStatus, error }. Never throws; keeps no tenant body. */
export async function getSiteSystem(env, siteId, opts = {}) {
  const request = opts.request || env.SETUP_TENANT_REQUEST || realRequestTenant;
  try {
    const site = await repo.findSite(env, siteId);
    if (!site) return { ok: false, httpStatus: 404, error: "not_found" };
    if (!site.tenant_id) return { ok: false, httpStatus: 409, error: "site_has_no_tenant" };
    const res = await request(env, site.tenant_id, { method: "GET", path: SYSTEM_PATH, timeoutMs: opts.timeoutMs || 8000 });
    if (res && res.ok) {
      const sys = res.data?.system;
      if (!sys || typeof sys.enabled !== "boolean") return { ok: false, httpStatus: 502, error: "unexpected_answer" };
      return { ok: true, system: { enabled: sys.enabled, source: SYSTEM_SOURCES.includes(sys.source) ? sys.source : "unknown", envOverride: sys.envOverride === true } };
    }
    if (res && NOT_UPDATED_STATUSES.includes(Number(res.status))) return { ok: false, httpStatus: 409, error: "tenant_not_updated" };
    return { ok: false, httpStatus: 502, error: describeFailure(res) };
  } catch (_) {
    return { ok: false, httpStatus: 502, error: "internal_error" };
  }
}

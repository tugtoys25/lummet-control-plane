// Staff screen: Site presets (Phase 10 A5). What new sites start from (default preset per plan or product) and how the first-
// configuration requests are doing (counts, the failed ones, retry). Super admin only: the route layer enforces that; hiding the
// nav item is not security. Everything shown is an id, a preset name, a status and a short error code, never a tenant answer.
import { renderShell, escapeHtml as h } from "../layout.js";
import { nonceToken, onClick, onSubmit } from "../../csp.js";
import * as siteSetup from "../../site-setup.js";
import * as plans from "../../plans.js";
import { listPlansCatalog } from "../../staff-saas.js";

const STATUSES = siteSetup.SETUP_STATUSES;
const badge = (s) => `<span class="role-badge">${h(s)}</span>`;
const table = (heads, rows, empty) =>
  rows.length
    ? `<table><thead><tr>${heads.map((x) => `<th>${h(x)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`
    : `<p style="color:var(--text-dim)">${h(empty)}</p>`;

/** Pure: the whole page body from plain data, so it can be tested without a database. */
export function renderSitePresetsBody({ overview, requests, defaults, plansList, productsList, status = "" }) {
  const by = overview?.byStatus || {};
  const card = (label, v, warn) => `<div class="card" style="min-width:130px"><div style="color:var(--text-dim);font-size:12px">${h(label)}</div><div style="font-size:26px;${warn && v ? "color:#e5484d" : ""}">${h(v)}</div></div>`;
  const sweep = overview?.sweep || {};
  const sweepText = sweep.enabled
    ? `The retry sweep is on: a request is tried again with growing waits (up to ${h(sweep.maxAttempts)} tries, ${h(sweep.maxPerTick)} per run). After the last try it stays failed and shows as given up; use Retry to run it by hand.`
    : "The retry sweep is OFF (SETUP_RETRY_SWEEP). Failed requests are only retried by hand.";
  const cards = `<div style="display:flex;gap:12px;flex-wrap:wrap">${card("Pending", by.pending || 0)}${card("Applied", by.applied || 0)}${card("Failed", by.failed || 0, true)}${card("Given up", overview?.gaveUp || 0, true)}${card("Skipped", by.skipped || 0)}</div><p style="color:var(--text-dim)">${sweepText}</p>`;

  const filter = `<form method="get" style="display:flex;gap:8px;margin-bottom:12px"><select name="status" aria-label="Filter by status"><option value="">all</option>${STATUSES.map((o) => `<option ${o === status ? "selected" : ""}>${h(o)}</option>`).join("")}</select><button class="btn">Filter</button></form>`;
  const reqRows = requests.map((r) => [
    h(r.siteName || r.siteId || r.tenantId || "—"), h(r.kind), h(r.presetLabel || (r.kind === "clone" ? "copy" : r.presetId || "—")),
    badge(r.gaveUp ? "given up" : r.status), h(r.attempts), h(r.lastError || ""), h(r.updatedAt || r.requestedAt || ""),
    r.siteId && (r.status === "pending" || r.status === "failed") ? `<button class="btn"${onClick("lummetStaffSetupRetry", [r.siteId], { confirm: "Run this site's setup again now?" })}>Retry</button>` : ""
  ]);
  const requestsHtml = table(["Site", "Kind", "Preset", "Status", "Tries", "Last error", "Updated", ""], reqRows, "No setup requests yet.");

  const scopeOptions = []
    .concat((plansList || []).map((p) => `<option value="plan:${h(p.id)}">Plan: ${h(p.name)}${p.product ? ` (${h(p.product)})` : ""}</option>`))
    .concat((productsList || []).map((p) => `<option value="product:${h(p.id)}">Product: ${h(p.name)}</option>`)).join("");
  const presetOptions = siteSetup.SITE_PRESETS.map((p) => `<option value="${h(p.id)}">${h(p.label)}</option>`).join("");
  const defaultRows = (defaults || []).map((d) => [
    h(d.scope_kind), h(d.scope_id), h(siteSetup.presetLabel(d.preset_id) || d.preset_id), h(d.updated_by || ""), h(d.updated_at || ""),
    `<button class="btn"${onClick("lummetClearPresetDefault", [d.scope_kind, d.scope_id], { confirm: "Clear this default? New sites will fall back to the next level (plan, then product, then Full platform)." })}>Clear</button>`
  ]);
  const defaultsHtml = `${table(["Applies to", "Id", "Preset", "Set by", "Updated", ""], defaultRows, "No defaults set. New sites start from the Full platform.")}
    <form${onSubmit("lummetSavePresetDefault", ["$el"], { prevent: true })} style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin-top:12px">
      <label>Applies to <select name="scope">${scopeOptions}</select></label>
      <label>Start new sites from <select name="preset">${presetOptions}</select></label>
      <button class="btn" type="submit">Save default</button>
    </form>
    <p style="color:var(--text-dim)">Order used for a new site: the customer's own choice, then the default of their plan, then of the product, then Full platform. Existing sites are never changed by a default.</p>`;

  const script = `<script nonce="${nonceToken()}">
function lummetSetupCall(url, method, body) {
  return fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(function (r) { return r.json(); });
}
function lummetStaffSetupRetry(siteId) {
  lummetSetupCall('/api/platform/saas/sites/' + encodeURIComponent(siteId) + '/setup', 'POST', { retry: true })
    .then(function (d) { if (d.success) { location.reload(); } else { alert('Not applied: ' + (d.error || 'unknown')); } });
}
function lummetSavePresetDefault(f) {
  var parts = String(f.scope.value).split(':');
  var kind = parts.shift();
  lummetSetupCall('/api/platform/site-presets/defaults', 'PUT', { scopeKind: kind, scopeId: parts.join(':'), presetId: f.preset.value })
    .then(function (d) { if (d.success) { location.reload(); } else { alert('Failed: ' + (d.error || 'unknown')); } });
}
function lummetClearPresetDefault(kind, id) {
  lummetSetupCall('/api/platform/site-presets/defaults', 'PUT', { scopeKind: kind, scopeId: id, presetId: null })
    .then(function (d) { if (d.success) { location.reload(); } else { alert('Failed: ' + (d.error || 'unknown')); } });
}
</script>`;

  return `<p style="color:var(--text-dim)">How new sites get their first configuration (a preset, or a copy of another site). The live checks for this feature have NOT been run: see docs/PHASE_9_LIVE_CHECKS.md.</p>
    <h2>Setup requests</h2>${cards}${filter}${requestsHtml}
    <h2>Default preset per plan or product</h2>${defaultsHtml}${script}`;
}

export async function renderSitePresetsPage(env, admin, { status = "" } = {}) {
  const wanted = STATUSES.includes(status) ? status : "";
  const [overview, requests, defaults, plansList, productsList] = await Promise.all([
    siteSetup.getSetupOverview(env),
    siteSetup.listRecentSetupRequests(env, { status: wanted || null, limit: 100 }),
    siteSetup.listDefaults(env),
    listPlansCatalog(env).catch(() => []),
    plans.listProducts(env).catch(() => [])
  ]);
  return renderShell({ title: "Site presets", activeKey: "saas-site-presets", admin, env, bodyHtml: `<h1>Site presets</h1>${renderSitePresetsBody({ overview, requests, defaults, plansList, productsList, status: wanted })}` });
}

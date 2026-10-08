// =====================================================
// INTEGRATIONS (Postback Configs + Provider Adapters + Import History)
//
// All three are grouped here because they share the same tenant-side
// trait: verified against migrations 0033/0035 directly, NEITHER
// postback_configs NOR provider_adapter_configs has an 'editor'
// permission row anywhere -- the tenant dashboard itself only lets
// its 'admin' role touch these. This page is gated by
// requireSuperAdmin() in index.js, not the ordinary permission
// matrix, specifically to preserve that boundary rather than quietly
// widen it just because the Super API's own trust model (one
// tenant-wide credential) could technically allow it.
//
// Import History has no create form at all -- see
// handlers-affiliate.js's section header: batches are written by the
// import pipeline itself as it runs, never manually.
//
// Neither postback-configs.js nor provider-adapters.js ever accepts
// or returns a plaintext secret -- credential_reference is a pointer
// to a Cloudflare secret binding name, resolved elsewhere. Never
// prompt for or display an actual secret value on this page.
// =====================================================

import { renderShell, escapeHtml } from "../layout.js";
import { getFromTenant, postToTenant, putToTenant, deleteFromTenant } from "../../client.js";
import { getTenant } from "../../registry.js";
import { nonceToken } from "../../csp.js";

const BASE_PATH = "/en/api/super";
const POSTBACK_AUTH_METHODS = ["hmac_sha256", "shared_secret", "api_key", "signed_query"];
const PROVIDER_KEYS = ["generic_rest"]; // registry.js's listProviderKeys() as of this writing

export async function renderIntegrationsPage(env, admin) {
  const activeKey = "content-integrations";
  const title = "Integrations";

  if (!admin.activeTenantId) {
    const body = `<h1>${title}</h1><div class="card"><p style="font-size:14px;">No active tenant is selected. Use the switcher at the top of the page to pick one.</p></div>`;
    return renderShell({ title, activeKey, admin, bodyHtml: body, env });
  }
  const tenant = await getTenant(env, admin.activeTenantId);
  if (!tenant) {
    const body = `<h1>${title}</h1><div class="card"><p>Active tenant no longer exists.</p></div>`;
    return renderShell({ title, activeKey, admin, bodyHtml: body, env });
  }

  const [postbackResult, adapterResult, importResult] = await Promise.all([
    getFromTenant(env, tenant, `${BASE_PATH}/postback-configs`),
    getFromTenant(env, tenant, `${BASE_PATH}/provider-adapters`),
    getFromTenant(env, tenant, `${BASE_PATH}/import-batches?limit=50`)
  ]);

  const errBlock = (r, label) => !r.ok
    ? `<div class="flash flash-error"><strong>${escapeHtml(String(r.status))}</strong> — ${escapeHtml(r.message || `Could not load ${label}. If this tenant hasn't redeployed with the new /en/api/super routes yet, that's why.`)}</div>`
    : null;

  const postbacks = postbackResult.ok ? (postbackResult.data.data || []) : [];
  const adapters = adapterResult.ok ? (adapterResult.data.data || []) : [];
  const batches = importResult.ok ? (importResult.data.data || []) : [];

  const postbackRow = (p) => `
    <tr>
      <td>${escapeHtml(p.label)}</td>
      <td>${escapeHtml(p.account_name || "")}</td>
      <td>${escapeHtml(p.auth_method)}</td>
      <td><code style="font-size:11px;">${escapeHtml((p.endpoint_token || "").slice(0, 10))}…</code></td>
      <td>${escapeHtml(p.status)}</td>
      <td>
        <button type="button" class="btn btn-small" data-edit-postback='${JSON.stringify(p).replace(/'/g, "&#39;")}'>Edit</button>
        <button type="button" class="btn btn-small" data-rotate-postback="${p.id}">Rotate token</button>
        <button type="button" class="btn btn-small btn-danger" data-archive-postback="${p.id}">Archive</button>
      </td>
    </tr>`;

  const adapterRow = (a) => `
    <tr>
      <td>${escapeHtml(a.label)}</td>
      <td>${escapeHtml(a.account_name || "")}</td>
      <td>${escapeHtml(a.provider_key)}</td>
      <td>${escapeHtml(a.sync_frequency_minutes)}m</td>
      <td>${escapeHtml(a.last_sync_status || "never")}</td>
      <td>${escapeHtml(a.status)}</td>
      <td>
        <button type="button" class="btn btn-small" data-edit-adapter='${JSON.stringify(a).replace(/'/g, "&#39;")}'>Edit</button>
        <button type="button" class="btn btn-small btn-danger" data-archive-adapter="${a.id}">Archive</button>
      </td>
    </tr>`;

  const batchRow = (b) => `
    <tr>
      <td>${escapeHtml(b.id)}</td>
      <td>${escapeHtml(b.label || "")}</td>
      <td>${escapeHtml(b.format || "")}</td>
      <td>${escapeHtml(b.imported_count ?? "")}/${escapeHtml(b.total_rows ?? "")}</td>
      <td>${escapeHtml(b.duplicate_count ?? "")}</td>
      <td>${escapeHtml(b.unattributed_count ?? "")}</td>
      <td>${escapeHtml(b.created_at || "")}</td>
    </tr>`;

  const body = `
    <h1>${title}</h1>
    <p class="subtitle">Content · Integrations on <strong>${escapeHtml(tenant.name)}</strong> · super-admin only</p>

    <div class="card">
      <h3 style="margin-top:0;">Postback Configs</h3>
      ${errBlock(postbackResult, "postback configs") || (postbacks.length ? `
      <table class="table">
        <thead><tr><th>Label</th><th>Account</th><th>Auth</th><th>Token</th><th>Status</th><th></th></tr></thead>
        <tbody>${postbacks.map(postbackRow).join("")}</tbody>
      </table>` : `<p class="empty">No postback configs yet.</p>`)}
    </div>

    <div class="card" style="border-style:dashed;">
      <h3 style="margin-top:0;" id="postbackFormTitle">Add / edit a postback config</h3>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <label>Account ID<input type="number" id="pbAccountId" /></label>
        <label>Label<input type="text" id="pbLabel" /></label>
        <label>Auth method
          <select id="pbAuthMethod">${POSTBACK_AUTH_METHODS.map((m) => `<option value="${m}">${m}</option>`).join("")}</select>
        </label>
      </div>
      <label>Credential reference <span style="color:var(--text-dim);font-weight:normal;">(secret binding name, never the secret itself)</span>
        <input type="text" id="pbCredentialRef" />
      </label>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <label>Signature param<input type="text" id="pbSignatureParam" /></label>
        <label>Timestamp param<input type="text" id="pbTimestampParam" /></label>
        <label>Timestamp tolerance (s)<input type="number" id="pbTolerance" value="300" /></label>
      </div>
      <label>Allowed IPs <span style="color:var(--text-dim);font-weight:normal;">(JSON array, optional)</span><input type="text" id="pbAllowedIps" placeholder='["1.2.3.4/32"]' /></label>
      <label>Field mapping JSON <span style="color:var(--text-dim);font-weight:normal;">(optional)</span><textarea id="pbFieldMapping"></textarea></label>
      <input type="hidden" id="pbEditId" />
      <button type="button" class="btn btn-small" id="savePostbackBtn" style="margin-top:8px;">Save</button>
      <button type="button" class="btn btn-small" id="clearPostbackBtn" style="margin-top:8px;">Clear form</button>
    </div>

    <div class="card">
      <h3 style="margin-top:0;">Provider Adapter Configs</h3>
      ${errBlock(adapterResult, "provider adapters") || (adapters.length ? `
      <table class="table">
        <thead><tr><th>Label</th><th>Account</th><th>Provider</th><th>Sync every</th><th>Last sync</th><th>Status</th><th></th></tr></thead>
        <tbody>${adapters.map(adapterRow).join("")}</tbody>
      </table>` : `<p class="empty">No provider adapter configs yet.</p>`)}
    </div>

    <div class="card" style="border-style:dashed;">
      <h3 style="margin-top:0;" id="adapterFormTitle">Add / edit a provider adapter config</h3>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <label>Account ID<input type="number" id="paAccountId" /></label>
        <label>Label<input type="text" id="paLabel" /></label>
        <label>Provider
          <select id="paProviderKey">${PROVIDER_KEYS.map((k) => `<option value="${k}">${k}</option>`).join("")}</select>
        </label>
      </div>
      <label>API base URL<input type="text" id="paApiBaseUrl" /></label>
      <label>Credential reference <span style="color:var(--text-dim);font-weight:normal;">(secret binding name, never the secret itself)</span>
        <input type="text" id="paCredentialRef" />
      </label>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <label>Auth header name<input type="text" id="paAuthHeaderName" /></label>
        <label>Auth scheme<input type="text" id="paAuthScheme" /></label>
        <label>Sync frequency (min)<input type="number" id="paSyncFrequency" value="60" /></label>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <label>Conversions path<input type="text" id="paConversionsPath" /></label>
        <label>Date param (since)<input type="text" id="paDateSince" /></label>
        <label>Date param (until)<input type="text" id="paDateUntil" /></label>
        <label>Response array path<input type="text" id="paResponseArrayPath" /></label>
      </div>
      <label>Field mapping JSON <span style="color:var(--text-dim);font-weight:normal;">(optional)</span><textarea id="paFieldMapping"></textarea></label>
      <input type="hidden" id="paEditId" />
      <button type="button" class="btn btn-small" id="saveAdapterBtn" style="margin-top:8px;">Save</button>
      <button type="button" class="btn btn-small" id="clearAdapterBtn" style="margin-top:8px;">Clear form</button>
    </div>

    <div class="card">
      <h3 style="margin-top:0;">Import History</h3>
      <div style="font-size:13px;color:var(--text-dim);margin-bottom:10px;">
        Read-only — batches are written by the import pipeline itself as it runs, there's no manual create here.
      </div>
      ${errBlock(importResult, "import history") || (batches.length ? `
      <table class="table">
        <thead><tr><th>ID</th><th>Label</th><th>Format</th><th>Imported/Total</th><th>Duplicates</th><th>Unattributed</th><th>When</th></tr></thead>
        <tbody>${batches.map(batchRow).join("")}</tbody>
      </table>` : `<p class="empty">No import batches yet.</p>`)}
    </div>

    <script nonce="${nonceToken()}">
      // Same path the tenant's own admin (postback-config-admin.js)
      // builds the full postback URL from -- worker/postback/handler.js
      // serves it at this path on the tenant's own origin, not
      // lummet.com. Needed so a config created/rotated here is
      // actually usable: unlike every other field, endpoint_token is
      // never shown again after this (see postback-configs.js), so
      // silently reloading the page after create/rotate -- as this
      // page used to -- left no way to retrieve it afterward short of
      // rotating again.
      const POSTBACK_URL_BASE = ${JSON.stringify(tenant.api_base_url || "")} + "/en/api/v1/conversions/postback/";

      async function integrationApi(method, path, body) {
        const opts = { method, headers: { "Content-Type": "application/json" } };
        if (body !== undefined) opts.body = JSON.stringify(body);
        const res = await fetch(path, opts);
        return res.json().catch(() => ({}));
      }

      // ---- Postback configs ----
      function fillPostbackForm(p) {
        document.getElementById("pbEditId").value = p.id || "";
        document.getElementById("pbAccountId").value = p.account_id || "";
        document.getElementById("pbLabel").value = p.label || "";
        document.getElementById("pbAuthMethod").value = p.auth_method || "hmac_sha256";
        document.getElementById("pbCredentialRef").value = p.credential_reference || "";
        document.getElementById("pbSignatureParam").value = p.signature_param || "";
        document.getElementById("pbTimestampParam").value = p.timestamp_param || "";
        document.getElementById("pbTolerance").value = p.timestamp_tolerance_seconds ?? 300;
        document.getElementById("pbAllowedIps").value = p.allowed_ips || "";
        document.getElementById("pbFieldMapping").value = p.field_mapping_json || "";
        document.getElementById("postbackFormTitle").scrollIntoView({ behavior: "smooth" });
      }
      document.getElementById("clearPostbackBtn").addEventListener("click", () => fillPostbackForm({}));
      document.getElementById("savePostbackBtn").addEventListener("click", async () => {
        const id = document.getElementById("pbEditId").value;
        const payload = {
          account_id: Number(document.getElementById("pbAccountId").value) || undefined,
          label: document.getElementById("pbLabel").value.trim(),
          auth_method: document.getElementById("pbAuthMethod").value,
          credential_reference: document.getElementById("pbCredentialRef").value.trim(),
          signature_param: document.getElementById("pbSignatureParam").value.trim() || undefined,
          timestamp_param: document.getElementById("pbTimestampParam").value.trim() || undefined,
          timestamp_tolerance_seconds: Number(document.getElementById("pbTolerance").value) || undefined,
          allowed_ips: document.getElementById("pbAllowedIps").value.trim() || undefined,
          field_mapping_json: document.getElementById("pbFieldMapping").value.trim() || undefined
        };
        const data = id
          ? await integrationApi("PUT", "/api/postback-configs/" + id, payload)
          : await integrationApi("POST", "/api/postback-configs", payload);
        if (!data.success) { alert("Could not save: " + (data.message || data.error || "unknown error")); return; }
        if (!id && data.data && data.data.endpoint_token) {
          alert("Integration created. Postback URL: " + POSTBACK_URL_BASE + data.data.endpoint_token + " — copy this now, it won't be shown in full again.");
        }
        location.reload();
      });

      document.body.addEventListener("click", async (e) => {
        const editPb = e.target.closest("[data-edit-postback]");
        if (editPb) { fillPostbackForm(JSON.parse(editPb.dataset.editPostback)); return; }

        const rotatePb = e.target.closest("[data-rotate-postback]");
        if (rotatePb) {
          if (!confirm("Rotate this postback's endpoint token? The old URL will stop working immediately.")) return;
          const data = await integrationApi("POST", "/api/postback-configs/" + rotatePb.dataset.rotatePostback + "/rotate-token");
          if (!data.success) { alert("Could not rotate: " + (data.message || data.error || "unknown error")); return; }
          alert("New postback URL: " + POSTBACK_URL_BASE + (data.data && data.data.endpoint_token));
          location.reload();
          return;
        }

        const archivePb = e.target.closest("[data-archive-postback]");
        if (archivePb) {
          if (!confirm("Archive this postback config?")) return;
          const data = await integrationApi("DELETE", "/api/postback-configs/" + archivePb.dataset.archivePostback);
          if (!data.success) { alert("Could not archive: " + (data.message || data.error || "unknown error")); return; }
          location.reload();
          return;
        }

        // ---- Provider adapters ----
        const editPa = e.target.closest("[data-edit-adapter]");
        if (editPa) { fillAdapterForm(JSON.parse(editPa.dataset.editAdapter)); return; }

        const archivePa = e.target.closest("[data-archive-adapter]");
        if (archivePa) {
          if (!confirm("Archive this provider adapter config?")) return;
          const data = await integrationApi("DELETE", "/api/provider-adapters/" + archivePa.dataset.archiveAdapter);
          if (!data.success) { alert("Could not archive: " + (data.message || data.error || "unknown error")); return; }
          location.reload();
        }
      });

      function fillAdapterForm(a) {
        document.getElementById("paEditId").value = a.id || "";
        document.getElementById("paAccountId").value = a.account_id || "";
        document.getElementById("paLabel").value = a.label || "";
        document.getElementById("paProviderKey").value = a.provider_key || "generic_rest";
        document.getElementById("paApiBaseUrl").value = a.api_base_url || "";
        document.getElementById("paCredentialRef").value = a.credential_reference || "";
        document.getElementById("paAuthHeaderName").value = a.auth_header_name || "";
        document.getElementById("paAuthScheme").value = a.auth_scheme || "";
        document.getElementById("paSyncFrequency").value = a.sync_frequency_minutes ?? 60;
        document.getElementById("paConversionsPath").value = a.conversions_path || "";
        document.getElementById("paDateSince").value = a.date_param_since || "";
        document.getElementById("paDateUntil").value = a.date_param_until || "";
        document.getElementById("paResponseArrayPath").value = a.response_array_path || "";
        document.getElementById("paFieldMapping").value = a.field_mapping_json || "";
        document.getElementById("adapterFormTitle").scrollIntoView({ behavior: "smooth" });
      }
      document.getElementById("clearAdapterBtn").addEventListener("click", () => fillAdapterForm({}));
      document.getElementById("saveAdapterBtn").addEventListener("click", async () => {
        const id = document.getElementById("paEditId").value;
        const payload = {
          account_id: Number(document.getElementById("paAccountId").value) || undefined,
          label: document.getElementById("paLabel").value.trim(),
          provider_key: document.getElementById("paProviderKey").value,
          api_base_url: document.getElementById("paApiBaseUrl").value.trim(),
          credential_reference: document.getElementById("paCredentialRef").value.trim(),
          auth_header_name: document.getElementById("paAuthHeaderName").value.trim() || undefined,
          auth_scheme: document.getElementById("paAuthScheme").value.trim() || undefined,
          sync_frequency_minutes: Number(document.getElementById("paSyncFrequency").value) || undefined,
          conversions_path: document.getElementById("paConversionsPath").value.trim() || undefined,
          date_param_since: document.getElementById("paDateSince").value.trim() || undefined,
          date_param_until: document.getElementById("paDateUntil").value.trim() || undefined,
          response_array_path: document.getElementById("paResponseArrayPath").value.trim() || undefined,
          field_mapping_json: document.getElementById("paFieldMapping").value.trim() || undefined
        };
        const data = id
          ? await integrationApi("PUT", "/api/provider-adapters/" + id, payload)
          : await integrationApi("POST", "/api/provider-adapters", payload);
        if (!data.success) { alert("Could not save: " + (data.message || data.error || "unknown error")); return; }
        location.reload();
      });
    </script>
  `;

  return renderShell({ title, activeKey, admin, bodyHtml: body, env });
}

async function resolveTenantOrNull(env, admin) {
  if (!admin.activeTenantId) return null;
  return getTenant(env, admin.activeTenantId);
}

export async function submitCreatePostbackConfig(env, admin, payload) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return postToTenant(env, tenant, `${BASE_PATH}/postback-configs`, payload);
}
export async function submitUpdatePostbackConfig(env, admin, id, payload) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return putToTenant(env, tenant, `${BASE_PATH}/postback-configs/${encodeURIComponent(id)}`, payload);
}
export async function submitRotatePostbackToken(env, admin, id) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return postToTenant(env, tenant, `${BASE_PATH}/postback-configs/${encodeURIComponent(id)}/rotate-token`, {});
}
export async function submitArchivePostbackConfig(env, admin, id) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return deleteFromTenant(env, tenant, `${BASE_PATH}/postback-configs/${encodeURIComponent(id)}`);
}

export async function submitCreateProviderAdapter(env, admin, payload) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return postToTenant(env, tenant, `${BASE_PATH}/provider-adapters`, payload);
}
export async function submitUpdateProviderAdapter(env, admin, id, payload) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return putToTenant(env, tenant, `${BASE_PATH}/provider-adapters/${encodeURIComponent(id)}`, payload);
}
export async function submitArchiveProviderAdapter(env, admin, id) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return deleteFromTenant(env, tenant, `${BASE_PATH}/provider-adapters/${encodeURIComponent(id)}`);
}

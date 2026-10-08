import { renderShell, escapeHtml } from "../layout.js";
import { getFromTenant, putToTenant, postToTenant, messageForStatus } from "../../client.js";
import { getTenant } from "../../registry.js";
import { nonceToken } from "../../csp.js";

const BASE_PATH = "/en/api/super/settings";
const AD_RULES_PATH = "/en/api/super/ad-rules";
const COMPONENTS_PATH = "/en/api/super/components";

const AD_PLACEMENTS = [
  "after_paragraph", "before_paragraph", "end_of_article", "before_article",
  "after_heading", "before_heading", "after_first_image", "middle_of_article"
];
const AD_DEVICES = ["all", "desktop", "mobile", "tablet"];
const AD_PAGE_TYPES = ["all", "news", "review", "casino", "category", "page"];

export async function renderSettingsPage(env, admin, flash) {
  if (!admin.activeTenantId) {
    const body = `
      <h1>Settings</h1>
      <p class="subtitle">System · Settings</p>
      <div class="card"><p style="font-size:14px;">No active tenant is selected. Use the switcher at the top of the page to pick one.</p></div>
    `;
    return renderShell({ title: "Settings", activeKey: "system-settings", admin, bodyHtml: body, env });
  }

  const tenant = await getTenant(env, admin.activeTenantId);
  if (!tenant) {
    const body = `<h1>Settings</h1><div class="card"><p>Active tenant no longer exists.</p></div>`;
    return renderShell({ title: "Settings", activeKey: "system-settings", admin, bodyHtml: body, env });
  }

  const result = await getFromTenant(env, tenant, BASE_PATH);

  const flashHtml = flash
    ? `<div class="flash ${flash.type === "error" ? "flash-error" : "flash-success"}">${escapeHtml(flash.message)}</div>`
    : "";

  if (!result.ok) {
    const body = `
      <h1>Settings</h1>
      <p class="subtitle">System · Settings on <strong>${escapeHtml(tenant.name)}</strong></p>
      <div class="flash flash-error"><strong>${escapeHtml(String(result.status))}</strong> — ${escapeHtml(result.message || messageForStatus(result.status))}</div>
    `;
    return renderShell({ title: "Settings", activeKey: "system-settings", admin, bodyHtml: body, env });
  }

  const settings = result.data.data || {};
  const entries = Object.entries(settings);

  const rowsHtml = entries
    .map(
      ([key, value], i) => `
        <div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:10px;">
          <input type="text" name="key_${i}" value="${escapeHtml(key)}" style="max-width:220px;margin:0;" readonly />
          <input type="text" name="value_${i}" value="${escapeHtml(value)}" style="margin:0;" />
        </div>`
    )
    .join("");

  const [adRulesResult, componentsResult] = await Promise.all([
    getFromTenant(env, tenant, AD_RULES_PATH),
    getFromTenant(env, tenant, COMPONENTS_PATH)
  ]);
  const adRules = adRulesResult.ok ? adRulesResult.data.data || [] : [];
  const components = componentsResult.ok ? componentsResult.data.data || [] : [];

  const componentOptionsHtml = (selectedId) =>
    components
      .map((c) => `<option value="${escapeHtml(c.id)}" ${String(c.id) === String(selectedId) ? "selected" : ""}>${escapeHtml(c.name)}</option>`)
      .join("");
  const selectOptionsHtml = (values, selected) =>
    values.map((v) => `<option value="${escapeHtml(v)}" ${v === selected ? "selected" : ""}>${escapeHtml(v)}</option>`).join("");

  const adRuleRowHtml = (rule) => `
    <tr data-ad-rule-row="${rule.id}">
      <td style="padding:6px 8px;"><input type="checkbox" data-ad-field="enabled" ${rule.enabled ? "checked" : ""} style="width:auto;margin:0;" /></td>
      <td style="padding:6px 8px;"><select data-ad-field="component_id" style="width:auto;">${componentOptionsHtml(rule.component_id)}</select></td>
      <td style="padding:6px 8px;"><select data-ad-field="placement" style="width:auto;">${selectOptionsHtml(AD_PLACEMENTS, rule.placement)}</select></td>
      <td style="padding:6px 8px;"><input type="number" data-ad-field="position_value" value="${escapeHtml(rule.position_value ?? 3)}" style="width:60px;margin:0;" /></td>
      <td style="padding:6px 8px;"><select data-ad-field="page_type" style="width:auto;">${selectOptionsHtml(AD_PAGE_TYPES, rule.page_type)}</select></td>
      <td style="padding:6px 8px;"><select data-ad-field="devices" style="width:auto;">${selectOptionsHtml(AD_DEVICES, rule.devices)}</select></td>
      <td style="padding:6px 8px;"><input type="number" data-ad-field="max_appearances" value="${escapeHtml(rule.max_appearances ?? 1)}" style="width:50px;margin:0;" /></td>
      <td style="padding:6px 8px;"><input type="number" data-ad-field="priority" value="${escapeHtml(rule.priority ?? 100)}" style="width:55px;margin:0;" /></td>
      <td style="padding:6px 8px;white-space:nowrap;">
        <button type="button" class="btn btn-secondary btn-small" data-ad-save="${rule.id}">Save</button>
        <button type="button" class="btn btn-secondary btn-small" data-ad-delete="${rule.id}" style="color:var(--danger);">✕</button>
      </td>
    </tr>`;

  const adRulesHtml = `
    <div class="card" style="margin-top:20px;">
      <h3 style="margin-top:0;">Ad automation rules</h3>
      <p style="font-size:13px;color:var(--text-dim);">Crude but functional — same rules engine as the tenant's own admin. Each row auto-targets ad component placements across the site; nothing here saves until you press that row's Save.</p>
      ${
        components.length === 0
          ? `<p style="color:var(--text-dim);font-size:13px;">No components exist on this tenant yet — create one under System → Components first (an ad rule just decides where/when an existing component shows up).</p>`
          : `
      <div style="overflow-x:auto;">
        <table>
          <thead><tr style="font-size:11px;color:var(--text-dim);">
            <th>On</th><th>Component</th><th>Placement</th><th>Pos.</th><th>Page type</th><th>Devices</th><th>Max</th><th>Priority</th><th></th>
          </tr></thead>
          <tbody id="adRulesBody">
            ${adRules.map(adRuleRowHtml).join("") || `<tr><td colspan="9" style="padding:10px 8px;color:var(--text-dim);">No rules yet.</td></tr>`}
          </tbody>
        </table>
      </div>
      <div style="border-top:1px solid var(--panel-border);margin:14px 0;padding-top:12px;">
        <label>Add a rule</label>
        <table><tbody><tr data-ad-rule-row="new">
          <td style="padding:6px 8px;"><input type="checkbox" data-ad-field="enabled" checked style="width:auto;margin:0;" /></td>
          <td style="padding:6px 8px;"><select data-ad-field="component_id" style="width:auto;"><option value="">—</option>${componentOptionsHtml(null)}</select></td>
          <td style="padding:6px 8px;"><select data-ad-field="placement" style="width:auto;">${selectOptionsHtml(AD_PLACEMENTS, "after_paragraph")}</select></td>
          <td style="padding:6px 8px;"><input type="number" data-ad-field="position_value" value="3" style="width:60px;margin:0;" /></td>
          <td style="padding:6px 8px;"><select data-ad-field="page_type" style="width:auto;">${selectOptionsHtml(AD_PAGE_TYPES, "all")}</select></td>
          <td style="padding:6px 8px;"><select data-ad-field="devices" style="width:auto;">${selectOptionsHtml(AD_DEVICES, "all")}</select></td>
          <td style="padding:6px 8px;"><input type="number" data-ad-field="max_appearances" value="1" style="width:50px;margin:0;" /></td>
          <td style="padding:6px 8px;"><input type="number" data-ad-field="priority" value="100" style="width:55px;margin:0;" /></td>
          <td style="padding:6px 8px;"><button type="button" class="btn btn-small" id="adRuleAddBtn">Add</button></td>
        </tr></tbody></table>
      </div>`
      }
    </div>
    <script nonce="${nonceToken()}">
      function adRuleReadRow(tr) {
        const body = {};
        tr.querySelectorAll("[data-ad-field]").forEach((el) => {
          const key = el.dataset.adField;
          body[key] = el.type === "checkbox" ? el.checked : el.value;
        });
        return body;
      }
      async function adRuleApi(path, method, body) {
        const res = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
        const data = await res.json().catch(() => ({}));
        if (!data.success) alert("Could not save: " + (data.message || data.error || "unknown error"));
        return data.success;
      }
      document.body.addEventListener("click", (e) => {
        const saveBtn = e.target.closest("[data-ad-save]");
        if (saveBtn) {
          const tr = saveBtn.closest("tr");
          adRuleApi("/api/ad-rules/" + saveBtn.dataset.adSave, "PUT", adRuleReadRow(tr));
          return;
        }
        const delBtn = e.target.closest("[data-ad-delete]");
        if (delBtn) {
          if (!confirm("Delete this ad rule?")) return;
          adRuleApi("/api/ad-rules/" + delBtn.dataset.adDelete, "DELETE").then((ok) => { if (ok) location.reload(); });
          return;
        }
        const addBtn = e.target.closest("#adRuleAddBtn");
        if (addBtn) {
          const tr = addBtn.closest("tr");
          const body = adRuleReadRow(tr);
          if (!body.component_id) { alert("Pick a component first."); return; }
          adRuleApi("/api/ad-rules", "POST", body).then((ok) => { if (ok) location.reload(); });
        }
      });
    </script>`;

  const body = `
    <h1>Settings</h1>
    <p class="subtitle">System · Settings on <strong>${escapeHtml(tenant.name)}</strong></p>
    ${flashHtml}
    <div class="card" style="max-width:640px;">
      <p style="color:var(--text-dim);font-size:13px;margin-top:0;">
        Only safe configuration keys are exposed here — anything that looks like a secret,
        password, credential, or token is filtered out by the tenant's Super API and never
        readable or writable through this screen.
      </p>
      <form method="POST" action="/system/settings">
        <input type="hidden" name="existing_count" value="${entries.length}" />
        ${rowsHtml || '<p style="color:var(--text-dim);font-size:13px;">No settings found on this tenant yet.</p>'}

        <div style="border-top:1px solid var(--panel-border);margin:18px 0;padding-top:14px;">
          <label>Add a new key</label>
          <div style="display:flex;gap:10px;">
            <input type="text" name="new_key" placeholder="setting_key" style="max-width:220px;" />
            <input type="text" name="new_value" placeholder="value" />
          </div>
        </div>

        <button class="btn" type="submit">Save settings</button>
      </form>
    </div>
    ${adRulesHtml}
  `;

  return renderShell({ title: "Settings", activeKey: "system-settings", admin, bodyHtml: body, env });
}

export async function submitSettings(env, admin, form) {
  if (!admin.activeTenantId) return { ok: false, error: "no_active_tenant" };

  const tenant = await getTenant(env, admin.activeTenantId);
  if (!tenant) return { ok: false, error: "no_active_tenant" };

  const count = Number(form.existing_count || 0);
  const payload = {};

  for (let i = 0; i < count; i++) {
    const key = form[`key_${i}`];
    const value = form[`value_${i}`];
    if (key) payload[key] = value ?? "";
  }

  if (form.new_key) {
    payload[form.new_key] = form.new_value ?? "";
  }

  if (Object.keys(payload).length === 0) {
    return { ok: false, status: 422, message: "Nothing to save." };
  }

  return putToTenant(env, tenant, BASE_PATH, payload);
}

async function resolveTenantOrNull(env, admin) {
  if (!admin.activeTenantId) return null;
  return getTenant(env, admin.activeTenantId);
}

export async function submitCreateAdRule(env, admin, payload) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return postToTenant(env, tenant, AD_RULES_PATH, payload);
}

export async function submitUpdateAdRule(env, admin, id, payload) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return putToTenant(env, tenant, `${AD_RULES_PATH}/${encodeURIComponent(id)}`, payload);
}

export async function submitDeleteAdRule(env, admin, id) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  const { deleteFromTenant } = await import("../../client.js");
  return deleteFromTenant(env, tenant, `${AD_RULES_PATH}/${encodeURIComponent(id)}`);
}

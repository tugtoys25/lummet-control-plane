// =====================================================
// LUMMET CMS ADMIN SCREENS
// Generic list/create/edit screens for lummet.com's own
// content, driven by cms-resources.js and backed directly
// by this control plane's D1 (via cms.js) — no tenant HTTP
// call involved, unlike views/pages/crud.js.
// =====================================================

import { renderShell, escapeHtml } from "../layout.js";
import { renderRichTextField } from "./crud.js";
import {
  listCmsRecords,
  getCmsRecord,
  createCmsRecord,
  updateCmsRecord,
  deleteCmsRecord,
  getSiteSettings,
  setSiteSettings,
  SITE_SETTING_KEYS
} from "../../cms.js";
import { getCmsResourceConfig } from "../../cms-resources.js";
import { nonceToken } from "../../csp.js";

function activeKeyFor(resourceKey) {
  return `cms-${resourceKey}`;
}

function flashHtml(flash) {
  if (!flash) return "";
  return `<div class="flash flash-${flash.type === "error" ? "error" : "success"}">${escapeHtml(flash.message)}</div>`;
}

// -----------------------------------------------------
// LIST
// -----------------------------------------------------

export async function renderCmsList(env, admin, resourceKey, flash) {
  const config = getCmsResourceConfig(resourceKey);
  const activeKey = activeKeyFor(resourceKey);
  if (!config) return renderShell({ title: "Not found", activeKey, admin, bodyHtml: `<h1>Not found</h1>`, env });

  const result = await listCmsRecords(env, resourceKey);
  const rows = result.ok ? result.data : [];

  const headerCells = config.listColumns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
  const bodyRows = rows.length
    ? rows
        .map((row) => {
          const cells = config.listColumns
            .map((c) => `<td>${escapeHtml(String(row[c.key] ?? ""))}</td>`)
            .join("");
          return `<tr>
            ${cells}
            <td style="white-space:nowrap;">
              <a class="btn btn-secondary btn-small" href="/cms/${resourceKey}/${row.id}/edit">Edit</a>
              <button type="button" class="btn btn-secondary btn-small" data-cms-delete="${row.id}">Delete</button>
            </td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="${config.listColumns.length + 1}" class="empty">No ${escapeHtml(config.label.toLowerCase())} yet.</td></tr>`;

  const body = `
    <h1>${escapeHtml(config.label)}</h1>
    <p class="subtitle">Lummet Site · ${escapeHtml(config.label)} — content shown on lummet.com itself.</p>
    ${flashHtml(flash)}
    <div class="card">
      ${config.supportsCreate === false ? "" : `<div style="display:flex;justify-content:flex-end;margin-bottom:12px;">
        <a class="btn btn-primary" href="/cms/${resourceKey}/new">+ New ${escapeHtml(config.label.replace(/s$/, ""))}</a>
      </div>`}
      <table>
        <thead><tr>${headerCells}<th></th></tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
    <script nonce="${nonceToken()}">
      document.body.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-cms-delete]");
        if (!btn) return;
        if (!confirm("Delete this? This cannot be undone.")) return;
        fetch("/cms/${resourceKey}/" + btn.dataset.cmsDelete + "/delete", { method: "POST" })
          .then((r) => r.json())
          .then((data) => {
            if (data.success) location.reload();
            else alert("Could not delete: " + (data.error || "unknown error"));
          });
      });
    </script>`;

  return renderShell({ title: config.label, activeKey, admin, bodyHtml: body, env });
}

// -----------------------------------------------------
// FORM (create/edit)
// -----------------------------------------------------

async function loadOptionsFor(env, field) {
  if (field.type === "resource_select") {
    const result = await listCmsRecords(env, field.optionsResource);
    const idKey = "id";
    const labelKey = field.optionsResource === "authors" ? "name" : "title";
    return (result.ok ? result.data : []).map((r) => ({ value: r[idKey], label: r[labelKey] || `#${r[idKey]}` }));
  }
  if (field.type === "tenant_select") {
    const result = await env.LUMMET_DB.prepare(`SELECT id, name FROM tenants ORDER BY name`).all();
    return (result.results || []).map((t) => ({ value: t.id, label: t.name }));
  }
  return [];
}

function renderField(field, value, options) {
  const val = value === undefined || value === null ? "" : value;

  if (field.readOnly) {
    const rows = field.type === "textarea" ? Math.min(14, Math.max(4, String(val).split("\n").length + 1)) : 1;
    return `<label>${escapeHtml(field.label)}</label>` +
      (field.type === "textarea"
        ? `<textarea rows="${rows}" readonly>${escapeHtml(val)}</textarea>`
        : `<input type="text" value="${escapeHtml(val)}" readonly />`);
  }

  if (field.type === "textarea") {
    return `<label>${escapeHtml(field.label)}${field.hint ? ` <span style="color:var(--text-dim);font-weight:400;">— ${escapeHtml(field.hint)}</span>` : ""}</label>
      <textarea name="${field.name}" rows="4">${escapeHtml(val)}</textarea>`;
  }

  if (field.type === "richtext") {
    return renderRichTextField(field, val || "");
  }

  if (field.type === "select") {
    const opts = (field.options || [])
      .map((o) => `<option value="${escapeHtml(o)}" ${String(val) === o ? "selected" : ""}>${escapeHtml(o)}</option>`)
      .join("");
    return `<label>${escapeHtml(field.label)}</label><select name="${field.name}">${opts}</select>`;
  }

  if (field.type === "number") {
    return `<label>${escapeHtml(field.label)}</label><input type="number" name="${field.name}" value="${escapeHtml(String(val))}" step="1" />`;
  }

  if (field.type === "resource_select" || field.type === "tenant_select") {
    const opts = [`<option value="">— none —</option>`]
      .concat(
        (options || []).map(
          (o) => `<option value="${escapeHtml(String(o.value))}" ${String(val) === String(o.value) ? "selected" : ""}>${escapeHtml(o.label)}</option>`
        )
      )
      .join("");
    return `<label>${escapeHtml(field.label)}</label><select name="${field.name}">${opts}</select>`;
  }

  // text (default)
  return `<label>${escapeHtml(field.label)}${field.hint ? ` <span style="color:var(--text-dim);font-weight:400;">— ${escapeHtml(field.hint)}</span>` : ""}</label>
    <input type="text" name="${field.name}" value="${escapeHtml(val)}" ${field.required ? "required" : ""} />`;
}

export async function renderCmsForm(env, admin, resourceKey, id, formError) {
  const config = getCmsResourceConfig(resourceKey);
  const activeKey = activeKeyFor(resourceKey);
  if (!config) return renderShell({ title: "Not found", activeKey, admin, bodyHtml: `<h1>Not found</h1>`, env });

  let record = {};
  if (id) {
    const result = await getCmsRecord(env, resourceKey, id);
    if (!result.ok) {
      return renderShell({ title: config.label, activeKey, admin, bodyHtml: `<h1>${escapeHtml(config.label)}</h1><div class="flash flash-error">Not found.</div>`, env });
    }
    record = result.data;
  }

  const optionFields = config.fields.filter((f) => f.type === "resource_select" || f.type === "tenant_select");
  const optionsByField = {};
  for (const f of optionFields) optionsByField[f.name] = await loadOptionsFor(env, f);

  const fieldsHtml = config.fields
    .map((f) => `<div class="form-group">${renderField(f, record[f.name], optionsByField[f.name])}</div>`)
    .join("");

  const body = `
    <h1>${id ? "Edit" : "New"} ${escapeHtml(config.label.replace(/s$/, ""))}</h1>
    <p class="subtitle">Lummet Site · ${escapeHtml(config.label)}</p>
    ${formError ? `<div class="flash flash-error">${escapeHtml(formError)}</div>` : ""}
    <form method="POST" action="/cms/${resourceKey}/${id ? id + "/edit" : "new"}" class="card">
      ${fieldsHtml}
      <div style="display:flex;gap:8px;margin-top:16px;">
        <button type="submit" class="btn btn-primary">${id ? "Save changes" : "Create"}</button>
        <a class="btn btn-secondary" href="/cms/${resourceKey}">Cancel</a>
      </div>
    </form>`;

  return renderShell({ title: `${id ? "Edit" : "New"} ${config.label}`, activeKey, admin, bodyHtml: body, env });
}

export async function submitCmsCreate(env, resourceKey, form) {
  return createCmsRecord(env, resourceKey, form);
}

export async function submitCmsUpdate(env, resourceKey, id, form) {
  return updateCmsRecord(env, resourceKey, id, form);
}

export async function submitCmsDelete(env, resourceKey, id) {
  return deleteCmsRecord(env, resourceKey, id);
}

// -----------------------------------------------------
// SITE SETTINGS (homepage editable copy)
// -----------------------------------------------------

const SETTING_LABELS = {
  site_name: "Site name",
  site_title: "Homepage <title>",
  site_description: "Default meta description",
  canonical_url: "Canonical site URL",
  og_image: "Default social share image URL",
  brands_title: "/brands page title",
  brands_intro: "/brands page intro",
  updates_title: "/updates page title",
  updates_intro: "/updates page intro",
  insights_title: "/insights page title",
  insights_intro: "/insights page intro",
  inquiry_rate_limit_per_hour: "Form submissions allowed per visitor per hour",
  partners_title: "/partners page title",
  partners_intro: "/partners page intro",
  logo_url: "Logo image URL",
  accent_color: "Primary accent color",
  accent_color_secondary: "Secondary accent color",
  hero_eyebrow: "Hero eyebrow text",
  hero_title: "Hero title",
  hero_subtitle: "Hero subtitle",
  hero_cta_primary_label: "Primary CTA label",
  hero_cta_primary_href: "Primary CTA link",
  hero_cta_secondary_label: "Secondary CTA label",
  hero_cta_secondary_href: "Secondary CTA link",
  contact_email: "Contact email",
  footer_text: "Footer text"
};

const SETTING_HINTS = {
  site_name: 'Shown next to the logo, e.g. "Lummet". Leave blank to keep "Lummet".',
  canonical_url: "Full origin used for canonical links, Open Graph URLs and the sitemap, e.g. https://lummet.com. Blank uses the address the visitor arrived on.",
  contact_email: "Shown in the footer and the Get in Touch section. If blank, the CONTACT_EMAIL Worker variable is used; if neither is set, contact blocks are hidden.",
  logo_url: "Shown in the header instead of the dot icon. Leave blank to use the default mark.",
  accent_color: "Hex color, e.g. #6d5bf6. Leave blank for the default purple.",
  accent_color_secondary: "Hex color used for gradients alongside the primary accent."
};

export async function renderSiteSettingsPage(env, admin, flash) {
  const activeKey = "cms-site-settings";
  const settings = await getSiteSettings(env);

  const fieldsHtml = SITE_SETTING_KEYS.map((key) => {
    const isLong = ["hero_subtitle", "footer_text", "site_description", "brands_intro", "updates_intro", "insights_intro", "partners_intro"].includes(key);
    const hint = SETTING_HINTS[key];
    return `<div class="form-group">
      <label>${escapeHtml(SETTING_LABELS[key] || key)}${hint ? ` <span style="color:var(--text-dim);font-weight:400;">— ${escapeHtml(hint)}</span>` : ""}</label>
      ${isLong
        ? `<textarea name="${key}" rows="3">${escapeHtml(settings[key] || "")}</textarea>`
        : `<input type="text" name="${key}" value="${escapeHtml(settings[key] || "")}" />`}
    </div>`;
  }).join("");

  const body = `
    <h1>Homepage &amp; site settings</h1>
    <p class="subtitle">Lummet Site · Site settings — edits the branding and copy shown on lummet.com's public site. Leave a field blank to hide that piece of copy. Changes appear within about a minute (edge cache).</p>
    ${flashHtml(flash)}
    <form method="POST" action="/cms/settings" class="card">
      <h3 style="margin-top:0;">Branding</h3>
      ${["site_name", "logo_url", "accent_color", "accent_color_secondary"].map((key) => {
        const hint = SETTING_HINTS[key];
        return `<div class="form-group">
          <label>${escapeHtml(SETTING_LABELS[key] || key)}${hint ? ` <span style="color:var(--text-dim);font-weight:400;">— ${escapeHtml(hint)}</span>` : ""}</label>
          <input type="text" name="${key}" value="${escapeHtml(settings[key] || "")}" />
        </div>`;
      }).join("")}
      <h3>Homepage copy</h3>
      ${SITE_SETTING_KEYS.filter((k) => !["site_name", "logo_url", "accent_color", "accent_color_secondary"].includes(k))
        .map((key) => {
          const isLong = ["hero_subtitle", "footer_text", "site_description", "brands_intro", "updates_intro", "insights_intro", "partners_intro"].includes(key);
          return `<div class="form-group">
            <label>${escapeHtml(SETTING_LABELS[key] || key)}</label>
            ${isLong
              ? `<textarea name="${key}" rows="3">${escapeHtml(settings[key] || "")}</textarea>`
              : `<input type="text" name="${key}" value="${escapeHtml(settings[key] || "")}" />`}
          </div>`;
        }).join("")}
      <div style="display:flex;gap:8px;margin-top:16px;">
        <button type="submit" class="btn btn-primary">Save</button>
        <a class="btn btn-secondary" href="/" target="_blank" rel="noopener">Preview homepage</a>
      </div>
    </form>
    <div class="card">
      <h3 style="margin-top:0;">Want more homepage sections?</h3>
      <p style="font-size:13px;color:var(--text-dim);">Add, reorder, and publish extra homepage blocks (a text block, an image-and-text block, or a card row) from <a href="/cms/homepage_sections">Homepage sections</a> — no code changes needed. Each standalone page's own body content (from <a href="/cms/pages">Pages</a>) already supports full rich text/HTML for however that page needs to be laid out.</p>
    </div>`;

  return renderShell({ title: "Homepage settings", activeKey, admin, bodyHtml: body, env });
}

export async function submitSiteSettings(env, form) {
  return setSiteSettings(env, form);
}

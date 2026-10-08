// =====================================================
// SEO META
// Wraps en/worker/super/handlers.js's SEO META section (new Super API
// routes added alongside this control-plane change -- none existed
// before). Distinct from Country Pages/Category Countries, which are
// "seo_pages" (auto-generated hub landing pages); this is per-entity
// <title>/description/OG/schema overrides for ANY page_type+page_slug
// pair (casino, review, news, page, category, country, ...).
//
// NOT built on the generic crud.js pattern: the record is keyed by a
// COMPOSITE (page_type, page_slug) pair, not a single id/slug --
// crud.js's idField assumes one value. Save is upsert (create and
// edit are the same POST /seo call, per seo_meta.js's
// upsertSeoMeta), so there's one form, not a separate create/edit
// pair.
// =====================================================

import { renderShell, escapeHtml } from "../layout.js";
import { getFromTenant, postToTenant, deleteFromTenant } from "../../client.js";
import { getTenant } from "../../registry.js";
import { nonceToken } from "../../csp.js";

const BASE_PATH = "/en/api/super";

export async function renderSeoMetaPage(env, admin) {
  const activeKey = "content-seo";
  const title = "SEO Meta";

  if (!admin.activeTenantId) {
    const body = `<h1>${title}</h1><div class="card"><p style="font-size:14px;">No active tenant is selected. Use the switcher at the top of the page to pick one.</p></div>`;
    return renderShell({ title, activeKey, admin, bodyHtml: body, env });
  }
  const tenant = await getTenant(env, admin.activeTenantId);
  if (!tenant) {
    const body = `<h1>${title}</h1><div class="card"><p>Active tenant no longer exists.</p></div>`;
    return renderShell({ title, activeKey, admin, bodyHtml: body, env });
  }

  const listResult = await getFromTenant(env, tenant, `${BASE_PATH}/seo`);
  if (!listResult.ok) {
    const body = `<h1>${title}</h1><div class="flash flash-error"><strong>${escapeHtml(String(listResult.status))}</strong> — ${escapeHtml(listResult.message || "Could not load SEO overrides. If this tenant hasn't redeployed with the /en/api/super/seo routes yet, that's why.")}</div>`;
    return renderShell({ title, activeKey, admin, bodyHtml: body, env });
  }
  const rows = listResult.data.data || [];

  const rowHtml = (r) => `
    <tr>
      <td>${escapeHtml(r.page_type)}</td>
      <td>${escapeHtml(r.page_slug)}</td>
      <td>${escapeHtml(r.title || "")}</td>
      <td>${escapeHtml(r.robots || "")}</td>
      <td>
        <button type="button" class="btn btn-small" data-edit-seo='${JSON.stringify(r).replace(/'/g, "&#39;")}'>Edit</button>
        <button type="button" class="btn btn-small btn-danger" data-delete-seo="${escapeHtml(r.page_type)}::${escapeHtml(r.page_slug)}">Delete</button>
      </td>
    </tr>`;

  const body = `
    <h1>${title}</h1>
    <p class="subtitle">Content · SEO Meta on <strong>${escapeHtml(tenant.name)}</strong></p>
    <div class="card" style="font-size:13px;color:var(--text-dim);">
      Per-page overrides for &lt;title&gt;, meta description, canonical, OG image, structured data and robots — for any page_type/page_slug pair (casino, review, news, page, category, country, etc). This is separate from Country Pages/Category Countries.
    </div>

    <div class="card">
      <h3 style="margin-top:0;">Existing overrides</h3>
      ${rows.length ? `
      <table class="table">
        <thead><tr><th>Type</th><th>Slug</th><th>Title</th><th>Robots</th><th></th></tr></thead>
        <tbody>${rows.map(rowHtml).join("")}</tbody>
      </table>` : `<p class="empty">No SEO overrides set yet.</p>`}
    </div>

    <div class="card" style="border-style:dashed;">
      <h3 style="margin-top:0;" id="formTitle">Add / edit an override</h3>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <label>Page type<input type="text" id="seoPageType" placeholder="casino" /></label>
        <label>Page slug<input type="text" id="seoPageSlug" placeholder="e.g. levelbet" /></label>
      </div>
      <label>Title<input type="text" id="seoTitle" /></label>
      <label>Description<textarea id="seoDescription"></textarea></label>
      <label>Keywords<input type="text" id="seoKeywords" /></label>
      <label>Canonical URL<input type="text" id="seoCanonical" /></label>
      <label>OG image URL<input type="text" id="seoOgImage" /></label>
      <label>Robots<input type="text" id="seoRobots" value="index, follow" /></label>
      <label>Schema JSON <span style="color:var(--text-dim);font-weight:normal;">(optional, raw JSON-LD)</span><textarea id="seoSchemaJson"></textarea></label>
      <button type="button" class="btn btn-small" id="saveSeoBtn" style="margin-top:8px;">Save</button>
      <button type="button" class="btn btn-small" id="clearSeoBtn" style="margin-top:8px;">Clear form</button>
    </div>

    <script nonce="${nonceToken()}">
      function fillForm(r) {
        document.getElementById("seoPageType").value = r.page_type || "";
        document.getElementById("seoPageSlug").value = r.page_slug || "";
        document.getElementById("seoTitle").value = r.title || "";
        document.getElementById("seoDescription").value = r.description || "";
        document.getElementById("seoKeywords").value = r.keywords || "";
        document.getElementById("seoCanonical").value = r.canonical || "";
        document.getElementById("seoOgImage").value = r.og_image || "";
        document.getElementById("seoRobots").value = r.robots || "index, follow";
        document.getElementById("seoSchemaJson").value = r.schema_json || "";
        document.getElementById("formTitle").scrollIntoView({ behavior: "smooth" });
      }

      document.getElementById("clearSeoBtn").addEventListener("click", () => fillForm({}));

      document.body.addEventListener("click", (e) => {
        const editBtn = e.target.closest("[data-edit-seo]");
        if (editBtn) { fillForm(JSON.parse(editBtn.dataset.editSeo)); return; }

        const delBtn = e.target.closest("[data-delete-seo]");
        if (delBtn) {
          const [pageType, pageSlug] = delBtn.dataset.deleteSeo.split("::");
          if (!confirm("Delete SEO override for " + pageType + "/" + pageSlug + "?")) return;
          fetch("/api/seo", {
            method: "DELETE", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pageType, pageSlug })
          }).then((r) => r.json()).then((data) => {
            if (!data.success) { alert("Could not delete: " + (data.message || data.error || "unknown error")); return; }
            location.reload();
          });
        }
      });

      document.getElementById("saveSeoBtn").addEventListener("click", async () => {
        const pageType = document.getElementById("seoPageType").value.trim();
        const pageSlug = document.getElementById("seoPageSlug").value.trim();
        if (!pageType || !pageSlug) { alert("Page type and page slug are both required."); return; }
        const payload = {
          pageType, pageSlug,
          title: document.getElementById("seoTitle").value.trim() || undefined,
          description: document.getElementById("seoDescription").value.trim() || undefined,
          keywords: document.getElementById("seoKeywords").value.trim() || undefined,
          canonical: document.getElementById("seoCanonical").value.trim() || undefined,
          ogImage: document.getElementById("seoOgImage").value.trim() || undefined,
          robots: document.getElementById("seoRobots").value.trim() || undefined,
          schemaJson: document.getElementById("seoSchemaJson").value.trim() || undefined
        };
        const res = await fetch("/api/seo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const data = await res.json().catch(() => ({}));
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

// NOTE: en/worker/database/seo_meta.js's upsertSeoMeta destructures
// page_type/page_slug (snake_case, body passed straight through in
// the tenant's own /api/v1/seo/save) -- so despite the payload above
// using camelCase field names client-side for consistency with this
// file's other forms, we translate to snake_case here before sending,
// verified against seo_meta.js directly.
export async function submitSaveSeoMeta(env, admin, payload) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  const body = {
    page_type: payload.pageType,
    page_slug: payload.pageSlug,
    title: payload.title,
    description: payload.description,
    keywords: payload.keywords,
    canonical: payload.canonical,
    og_image: payload.ogImage,
    schema_json: payload.schemaJson,
    robots: payload.robots
  };
  return postToTenant(env, tenant, `${BASE_PATH}/seo`, body);
}

export async function submitDeleteSeoMeta(env, admin, payload) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return deleteFromTenant(env, tenant, `${BASE_PATH}/seo`, { page_type: payload.pageType, page_slug: payload.pageSlug });
}

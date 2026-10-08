// =====================================================
// BASE COUNTRY / CATEGORY HUB PAGES admin
//   Countries   -> /content/countries
//   Categories  -> /content/categories
// Wraps the tenant's countries/categories Super API
// (worker/super/handlers.js). Custom-built like seo-pages.js,
// reusing the exact same content_json section builder (rich_text,
// heading, image, casino_grid, casino_editorial, casino_spotlights,
// faq, cta, internal_links) added in migration
// 0020_country_category_seo_nav.sql, so editing a hub page's
// extra editorial content works identically to editing a Country
// Page / Category Country page. Simpler than those forms: a hub
// page IS an existing country/category row (no country-search,
// no casino_mode/casino_selections — the hub already lists its
// casinos automatically; these sections are additional content).
// =====================================================

import { renderShell, escapeHtml } from "../layout.js";
import { getFromTenant, postToTenant, putToTenant, deleteFromTenant } from "../../client.js";
import { getTenant } from "../../registry.js";
import { nonceToken, onClick } from "../../csp.js";

const BASE_PATH = "/en/api/super";

async function resolveTenantOrNull(env, admin) {
  if (!admin.activeTenantId) return null;
  return getTenant(env, admin.activeTenantId);
}

function noTenantNotice(env, admin, activeKey, title) {
  const body = `<h1>${escapeHtml(title)}</h1><div class="card"><p style="font-size:14px;">No active tenant is selected. Use the switcher at the top of the page to pick one.</p></div>`;
  return renderShell({ title, activeKey, admin, bodyHtml: body, env });
}

function statusBadge(status, published) {
  const color = published ? "var(--success, #16a34a)" : "var(--warning, #d97706)";
  const label = published ? "published" : (status || "draft");
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;border:1px solid ${color};color:${color};">${escapeHtml(label)}</span>`;
}

// -----------------------------------------------------
// COUNTRIES — /content/countries
// -----------------------------------------------------

export async function renderCountriesList(env, admin) {
  const activeKey = "content-countries";
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return noTenantNotice(env, admin, activeKey, "Countries");

  const result = await getFromTenant(env, tenant, `${BASE_PATH}/countries`);
  if (!result.ok) {
    const body = `<h1>Countries</h1><div class="flash flash-error"><strong>${escapeHtml(String(result.status))}</strong> — ${escapeHtml(result.message || "Could not load countries.")}</div>`;
    return renderShell({ title: "Countries", activeKey, admin, bodyHtml: body, env });
  }

  const rows = result.data.data || [];
  const rowsHtml = rows.length
    ? `<table>
        <thead><tr><th>Name</th><th>Code</th><th>Legal status</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${rows.map((r) => `<tr>
            <td>${escapeHtml(r.name)}</td>
            <td><code>${escapeHtml(r.code)}</code></td>
            <td>${escapeHtml(r.legal_status || "—")}</td>
            <td>${statusBadge(r.status, r.published)}</td>
            <td>
              <a href="/content/countries/${escapeHtml(r.code)}/edit">Edit</a>
              &nbsp;·&nbsp;
              <a href="#"${onClick("hubPageDelete", ["country", r.code], {confirm: "Delete this country?", prevent: true})} style="color:var(--danger);">Delete</a>
            </td>
          </tr>`).join("")}
        </tbody>
      </table>`
    : `<div class="empty">No countries yet.</div>`;

  const body = `
    <h1>Countries</h1>
    <p class="subtitle">Content · Countries on <strong>${escapeHtml(tenant.name)}</strong></p>
    <div class="card">
      <div style="display:flex;justify-content:flex-end;margin-bottom:14px;"><a class="btn" href="/content/countries/new">New</a></div>
      ${rowsHtml}
    </div>
    <script nonce="${nonceToken()}">
      function hubPageDelete(kind, id) {
        fetch("/api/hub-pages/" + kind + "/" + encodeURIComponent(id), { method: "DELETE" })
          .then((r) => r.json())
          .then((data) => {
            if (data.success) location.reload();
            else alert("Delete failed: " + (data.error || data.message || "unknown error"));
          })
          .catch(() => alert("Delete failed."));
      }
    </script>
  `;
  return renderShell({ title: "Countries", activeKey, admin, bodyHtml: body, env });
}

export async function renderCountryForm(env, admin, code) {
  const activeKey = "content-countries";
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return noTenantNotice(env, admin, activeKey, "Countries");

  let record = null;
  if (code) {
    const result = await getFromTenant(env, tenant, `${BASE_PATH}/countries/${encodeURIComponent(code)}`);
    if (!result.ok) {
      const body = `<h1>Countries</h1><div class="flash flash-error">Could not load that country.</div>`;
      return renderShell({ title: "Countries", activeKey, admin, bodyHtml: body, env });
    }
    record = result.data.data;
  }

  const body = renderHubPageFormShell({
    kind: "country",
    listUrl: "/content/countries",
    actionUrl: code ? `/api/hub-pages/country/${encodeURIComponent(code)}` : `/api/hub-pages/country`,
    tenantName: tenant.name,
    record,
    isEdit: !!code
  });

  return renderShell({ title: code ? "Edit Country" : "New Country", activeKey, admin, bodyHtml: body, env });
}

// -----------------------------------------------------
// CATEGORIES — /content/categories
// -----------------------------------------------------

export async function renderCategoriesList(env, admin) {
  const activeKey = "content-categories";
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return noTenantNotice(env, admin, activeKey, "Categories");

  const result = await getFromTenant(env, tenant, `${BASE_PATH}/categories`);
  if (!result.ok) {
    const body = `<h1>Categories</h1><div class="flash flash-error"><strong>${escapeHtml(String(result.status))}</strong> — ${escapeHtml(result.message || "Could not load categories.")}</div>`;
    return renderShell({ title: "Categories", activeKey, admin, bodyHtml: body, env });
  }

  const rows = result.data.data || [];
  const rowsHtml = rows.length
    ? `<table>
        <thead><tr><th>Name</th><th>Slug</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${rows.map((r) => `<tr>
            <td>${escapeHtml(r.name)}</td>
            <td><code>${escapeHtml(r.slug)}</code></td>
            <td>${statusBadge(r.status, r.published)}</td>
            <td>
              <a href="/content/categories/${escapeHtml(r.slug)}/edit">Edit</a>
              &nbsp;·&nbsp;
              <a href="#"${onClick("hubPageDelete", ["category", r.slug], {confirm: "Delete this category?", prevent: true})} style="color:var(--danger);">Delete</a>
            </td>
          </tr>`).join("")}
        </tbody>
      </table>`
    : `<div class="empty">No categories yet.</div>`;

  const body = `
    <h1>Categories</h1>
    <p class="subtitle">Content · Categories on <strong>${escapeHtml(tenant.name)}</strong></p>
    <div class="card">
      <div style="display:flex;justify-content:flex-end;margin-bottom:14px;"><a class="btn" href="/content/categories/new">New</a></div>
      ${rowsHtml}
    </div>
    <script nonce="${nonceToken()}">
      function hubPageDelete(kind, id) {
        fetch("/api/hub-pages/" + kind + "/" + encodeURIComponent(id), { method: "DELETE" })
          .then((r) => r.json())
          .then((data) => {
            if (data.success) location.reload();
            else alert("Delete failed: " + (data.error || data.message || "unknown error"));
          })
          .catch(() => alert("Delete failed."));
      }
    </script>
  `;
  return renderShell({ title: "Categories", activeKey, admin, bodyHtml: body, env });
}

export async function renderCategoryForm(env, admin, slug) {
  const activeKey = "content-categories";
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return noTenantNotice(env, admin, activeKey, "Categories");

  let record = null;
  if (slug) {
    const result = await getFromTenant(env, tenant, `${BASE_PATH}/categories/${encodeURIComponent(slug)}`);
    if (!result.ok) {
      const body = `<h1>Categories</h1><div class="flash flash-error">Could not load that category.</div>`;
      return renderShell({ title: "Categories", activeKey, admin, bodyHtml: body, env });
    }
    record = result.data.data;
  }

  const body = renderHubPageFormShell({
    kind: "category",
    listUrl: "/content/categories",
    actionUrl: slug ? `/api/hub-pages/category/${encodeURIComponent(slug)}` : `/api/hub-pages/category`,
    tenantName: tenant.name,
    record,
    isEdit: !!slug
  });

  return renderShell({ title: slug ? "Edit Category" : "New Category", activeKey, admin, bodyHtml: body, env });
}

// -----------------------------------------------------
// Shared form shell — country and category hub pages differ
// only in their identity fields (code+currency+language+
// legal_status vs slug+description); everything from SEO
// metadata down (sections, publishing) is identical.
// -----------------------------------------------------

function renderHubPageFormShell({ kind, listUrl, actionUrl, tenantName, record, isEdit }) {
  const r = record || {};
  let content = {};
  try {
    content = typeof r.content_json === "string" ? JSON.parse(r.content_json) : r.content_json || {};
  } catch {
    content = {};
  }
  const sections = Array.isArray(content.sections) ? content.sections : [];
  const idValue = kind === "country" ? (r.code || "") : (r.slug || "");

  return `
    <h1>${isEdit ? "Edit" : "New"} ${kind === "country" ? "Country" : "Category"}</h1>
    <p class="subtitle">on <strong>${escapeHtml(tenantName)}</strong></p>
    <div id="formFlash"></div>

    <div class="card" style="max-width:760px;">
      <h3 style="margin-top:0;">1. Identity</h3>
      ${kind === "country" ? `
        <label for="idInput">Code *</label>
        <input type="text" id="idInput" maxlength="2" value="${escapeHtml(idValue)}" placeholder="CA" ${isEdit ? "readonly" : ""} />
        <label for="nameInput">Name *</label>
        <input type="text" id="nameInput" value="${escapeHtml(r.name || "")}" required />
        <label for="currencyInput">Currency</label>
        <input type="text" id="currencyInput" value="${escapeHtml(r.currency || "")}" placeholder="USD" />
        <label for="languageInput">Language</label>
        <input type="text" id="languageInput" value="${escapeHtml(r.language || "")}" placeholder="English" />
        <label for="legalStatusInput">Legal status</label>
        <input type="text" id="legalStatusInput" value="${escapeHtml(r.legal_status || "")}" placeholder="legal / restricted / banned" />
      ` : `
        <label for="idInput">Slug *</label>
        <input type="text" id="idInput" value="${escapeHtml(idValue)}" placeholder="crypto" ${isEdit ? "readonly" : ""} />
        <label for="nameInput">Name *</label>
        <input type="text" id="nameInput" value="${escapeHtml(r.name || "")}" required />
        <label for="descriptionInput">Description</label>
        <textarea id="descriptionInput" rows="3">${escapeHtml(r.description || "")}</textarea>
      `}
    </div>

    <div class="card" style="max-width:760px;">
      <h3 style="margin-top:0;">2. SEO &amp; metadata</h3>
      <label for="seoTitleInput">SEO title</label>
      <input type="text" id="seoTitleInput" value="${escapeHtml(r.seo_title || "")}" />
      <label for="seoDescInput">SEO description</label>
      <textarea id="seoDescInput" rows="2">${escapeHtml(r.seo_description || "")}</textarea>
      <label for="robotsSelect">Robots</label>
      <select id="robotsSelect">
        ${["index,follow", "noindex,follow", "index,nofollow", "noindex,nofollow"]
          .map((opt) => `<option value="${opt}" ${(r.robots || "index,follow") === opt ? "selected" : ""}>${opt}</option>`)
          .join("")}
      </select>
      <p style="font-size:12px;color:var(--text-dim);">${kind === "country" ? "SEO description" : "Description"} doubles as the intro line shown under the page heading — there's no separate intro field, to avoid duplicating it.</p>
    </div>

    <div class="card" style="max-width:760px;">
      <h3 style="margin-top:0;">3. Content sections</h3>
      <p style="font-size:13px;color:var(--text-dim);margin-top:0;">
        Same section types as Country Pages / Category Countries: rich_text, heading, image, casino_grid,
        casino_editorial, casino_spotlights, faq, cta, internal_links. Reorderable via position. Casino pickers
        here are limited to casinos already ${kind === "country" ? "allowed in this country" : "in this category"} —
        the hub page's own main casino grid stays fully automatic; these sections are extra editorial content.
      </p>
      <div id="sectionsRoot"></div>
      <button type="button" class="btn btn-secondary btn-small" id="addSectionBtn">+ Add section</button>
      <input type="hidden" id="sectionsHidden" />
    </div>

    <div class="card" style="max-width:760px;">
      <h3 style="margin-top:0;">4. Publishing</h3>
      <label for="statusSelect">Status</label>
      <select id="statusSelect">
        ${["published", "draft"].map((s) => `<option value="${s}" ${(r.status || "published") === s ? "selected" : ""}>${s}</option>`).join("")}
      </select>
      <label style="display:flex;align-items:center;gap:8px;font-weight:400;"><input type="checkbox" id="publishedCheck" style="width:auto;" ${r.published === 0 ? "" : "checked"} /> Published (live on the site)</label>
      <p style="font-size:12px;color:var(--text-dim);">A published ${kind} automatically gets a Page Navigation link — manage/rename/hide it any time from Navigation.</p>
    </div>

    <button class="btn" type="button" id="saveBtn">${isEdit ? "Save changes" : "Create"}</button>
    <a class="btn btn-secondary" href="${listUrl}">Cancel</a>
    ${isEdit ? `<a href="#"${onClick("hubPageDeleteAndRedirect", [kind, JSON.stringify(idValue), listUrl], {confirm: `Delete this ${kind}?`, prevent: true})} style="color:var(--danger);margin-left:14px;">Delete</a>` : ""}
    <script nonce="${nonceToken()}">
      function hubPageDeleteAndRedirect(kind, id, redirectTo) {
        fetch("/api/hub-pages/" + kind + "/" + encodeURIComponent(id), { method: "DELETE" })
          .then((r) => r.json())
          .then((data) => {
            if (data.success) location.href = redirectTo;
            else alert("Delete failed: " + (data.error || data.message || "unknown error"));
          })
          .catch(() => alert("Delete failed."));
      }
    </script>
    ${renderHubPageFormScript({ kind, actionUrl, isEdit, sections, idValue })}
  `;
}

// Section-builder script — deliberately the same SECTION_TYPES /
// FIELDS_BY_TYPE / sectionRowHtml / syncSectionsFromDom logic as
// seo-pages.js's renderSeoPageFormScript, minus everything that
// only makes sense for a seo_pages sub-page (country-search,
// casino_mode/casino_selections, slug editing, min_casino_count).
function renderHubPageFormScript({ kind, actionUrl, isEdit, sections, idValue }) {
  return `
    <script nonce="${nonceToken()}">
      const HUB_KIND = ${JSON.stringify(kind)};
      const IS_EDIT = ${JSON.stringify(isEdit)};
      const HUB_ID = ${JSON.stringify(idValue)};
      let pageSections = ${JSON.stringify(sections)};
      let eligibleCasinos = [];

      async function loadEligibleCasinos() {
        if (!HUB_ID) return;
        const url = HUB_KIND === "country"
          ? "/api/hub-pages/eligible-casinos?country_code=" + encodeURIComponent(HUB_ID)
          : "/api/hub-pages/eligible-casinos?category_slug=" + encodeURIComponent(HUB_ID);
        const res = await fetch(url);
        const data = await res.json().catch(() => ({}));
        eligibleCasinos = data.data || [];
        syncSectionsFromDom();
        renderSections();
      }
      if (IS_EDIT) loadEligibleCasinos();

      const sectionsRoot = document.getElementById("sectionsRoot");
      const SECTION_TYPES = ["rich_text", "heading", "image", "casino_grid", "casino_editorial", "casino_spotlights", "faq", "cta", "internal_links"];
      const FIELDS_BY_TYPE = {
        rich_text: ["title", "subtitle", "body"],
        heading: ["title"],
        image: ["title", "image_url"],
        casino_grid: ["title", "subtitle", "casino_ids"],
        casino_editorial: ["title", "casino_id", "body"],
        casino_spotlights: ["title", "subtitle", "spotlights"],
        faq: ["title", "faq_json"],
        cta: ["title", "body", "cta_url", "cta_label", "background"],
        internal_links: ["title", "links_json"]
      };
      const FIELD_LABELS = {
        title: "Title", subtitle: "Subtitle", body: "Body (HTML allowed)",
        image_url: "Image URL", casino_ids: "Casinos (select one or more — type to search)",
        casino_id: "Casino (type to search)", faq_json: "FAQ items (pre-filled with common questions — edit freely, or edit as JSON)",
        cta_url: "Button URL", cta_label: "Button label", background: "Background (CSS color, optional)",
        links_json: 'Links JSON — e.g. [{"label":"...","url":"..."}]',
        spotlights: "Casino spotlights — add one or more casinos, each with its own write-up"
      };
      const SECTION_FIELD_TO_DATA_KEY = { faq_json: "items", links_json: "links", cta_url: "url", cta_label: "label" };
      const DEFAULT_FAQ_ITEMS = [
        { q: "Is this casino safe and legal to play at?", a: "" },
        { q: "What payment methods are accepted?", a: "" },
        { q: "Is there a welcome bonus for new players?", a: "" },
        { q: "Can I play on mobile?", a: "" }
      ];

      function escapeForHtml(s) {
        return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      }

      function casinoPickerOptionsHtml(selectedIds) {
        return eligibleCasinos.map((c) =>
          '<option value="' + c.id + '"' + (selectedIds.has(c.id) ? " selected" : "") + '>' + escapeForHtml(c.name) + " (#" + c.id + ")" + '</option>'
        ).join("");
      }

      function sectionRowHtml(section, index) {
        const type = section.type || "rich_text";
        const fields = FIELDS_BY_TYPE[type] || [];
        return '<div class="card" data-section-row="' + index + '" style="margin-bottom:10px;">' +
          '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">' +
            '<select data-section-type style="width:auto;">' + SECTION_TYPES.map((t) => '<option value="' + t + '" ' + (t === type ? "selected" : "") + '>' + t + '</option>').join("") + '</select>' +
            '<label style="font-size:12px;color:var(--text-dim);white-space:nowrap;">Position <input type="number" data-section-position value="' + (section.position ?? index) + '" style="width:55px;margin:0;" /></label>' +
            '<button type="button" class="btn btn-secondary btn-small" data-remove-section style="margin-left:auto;">Remove</button>' +
          '</div>' +
          fields.map((f) => {
            if (f === "casino_id") {
              const selId = section.casino_id ? Number(section.casino_id) : null;
              return '<label>' + FIELD_LABELS[f] + '</label>' +
                '<select data-section-field="casino_id"><option value="">— Select a casino —</option>' +
                casinoPickerOptionsHtml(new Set(selId ? [selId] : [])) + '</select>';
            }
            if (f === "casino_ids") {
              const selIds = new Set((Array.isArray(section.casino_ids) ? section.casino_ids : []).map(Number));
              return '<label>' + FIELD_LABELS[f] + '</label>' +
                '<select data-section-field="casino_ids" multiple size="6" style="min-height:120px;">' +
                casinoPickerOptionsHtml(selIds) + '</select>' +
                '<p style="color:var(--text-dim);font-size:12px;margin:4px 0 10px;">Ctrl/Cmd-click (or long-press on mobile) to select multiple.</p>';
            }
            if (f === "spotlights") {
              const spotlights = Array.isArray(section.spotlights) ? section.spotlights : [];
              const rows = spotlights.map((sp, j) => {
                const selId = sp.casino_id ? Number(sp.casino_id) : null;
                return '<div class="card" data-spotlight-row="' + j + '" style="border:1px dashed var(--border-color,#333);margin-bottom:8px;">' +
                  '<div style="display:flex;gap:8px;align-items:center;">' +
                    '<select data-spotlight-field="casino_id" style="flex:1;"><option value="">— Select a casino —</option>' +
                      casinoPickerOptionsHtml(new Set(selId ? [selId] : [])) +
                    '</select>' +
                    '<button type="button" class="btn btn-secondary btn-small" data-remove-spotlight>Remove</button>' +
                  '</div>' +
                  '<label style="margin-top:6px;">Write-up for this casino</label>' +
                  '<textarea data-spotlight-field="body" rows="4">' + escapeForHtml(sp.body || "") + '</textarea>' +
                '</div>';
              }).join("");
              return '<label>' + FIELD_LABELS[f] + '</label>' +
                '<div data-spotlights-container>' + rows + '</div>' +
                '<button type="button" class="btn btn-secondary btn-small" data-add-spotlight>+ Add casino spotlight</button>';
            }
            const dataKey = SECTION_FIELD_TO_DATA_KEY[f] || f;
            let raw = section[dataKey];
            if (f === "faq_json" && (!Array.isArray(raw) || raw.length === 0)) raw = DEFAULT_FAQ_ITEMS;
            const val = (raw !== undefined && raw !== null) ? (typeof raw === "object" ? JSON.stringify(raw, null, 2) : raw) : "";
            if (f === "body" || f === "faq_json" || f === "links_json") {
              return '<label>' + FIELD_LABELS[f] + '</label><textarea data-section-field="' + f + '" rows="' + (f === "body" ? 3 : 6) + '">' + escapeForHtml(val) + '</textarea>';
            }
            return '<label>' + FIELD_LABELS[f] + '</label><input type="text" data-section-field="' + f + '" value="' + escapeForHtml(val) + '" />';
          }).join("") +
          '</div>';
      }

      function renderSections() {
        sectionsRoot.innerHTML = pageSections.map((s, i) => sectionRowHtml(s, i)).join("");
      }
      renderSections();

      document.getElementById("addSectionBtn").addEventListener("click", () => {
        pageSections.push({ id: "s" + Date.now(), type: "rich_text", position: pageSections.length, title: "", body: "" });
        renderSections();
      });

      sectionsRoot.addEventListener("click", (e) => {
        const addSpotlightBtn = e.target.closest("[data-add-spotlight]");
        if (addSpotlightBtn) {
          syncSectionsFromDom();
          const sectionRow = addSpotlightBtn.closest("[data-section-row]");
          const section = pageSections[Number(sectionRow.dataset.sectionRow)];
          if (!Array.isArray(section.spotlights)) section.spotlights = [];
          section.spotlights.push({ casino_id: null, body: "" });
          renderSections();
          return;
        }
        const removeSpotlightBtn = e.target.closest("[data-remove-spotlight]");
        if (removeSpotlightBtn) {
          syncSectionsFromDom();
          const sectionRow = removeSpotlightBtn.closest("[data-section-row]");
          const spotlightRow = removeSpotlightBtn.closest("[data-spotlight-row]");
          const section = pageSections[Number(sectionRow.dataset.sectionRow)];
          section.spotlights.splice(Number(spotlightRow.dataset.spotlightRow), 1);
          renderSections();
          return;
        }
        const removeBtn = e.target.closest("[data-remove-section]");
        if (!removeBtn) return;
        const row = removeBtn.closest("[data-section-row]");
        pageSections.splice(Number(row.dataset.sectionRow), 1);
        renderSections();
      });
      sectionsRoot.addEventListener("change", (e) => {
        const row = e.target.closest("[data-section-row]");
        if (!row) return;
        const i = Number(row.dataset.sectionRow);
        if (e.target.matches("[data-section-type]")) {
          pageSections[i].type = e.target.value;
          renderSections();
        }
      });

      function syncSectionsFromDom() {
        const rows = Array.from(sectionsRoot.querySelectorAll("[data-section-row]"));
        pageSections = rows.map((row) => {
          const i = Number(row.dataset.sectionRow);
          const existing = pageSections[i] || {};
          const type = row.querySelector("[data-section-type]").value;
          const position = Number(row.querySelector("[data-section-position]").value) || 0;
          const section = { id: existing.id || ("s" + Date.now() + i), type, position };
          row.querySelectorAll("[data-section-field]").forEach((el) => {
            const key = el.dataset.sectionField;
            if (key === "casino_ids") {
              section.casino_ids = el.multiple ? Array.from(el.selectedOptions).map((o) => Number(o.value)).filter(Boolean) : [];
              return;
            }
            let val = el.value;
            if (key === "casino_id") {
              section.casino_id = val ? Number(val) : null;
            } else if (key === "faq_json" || key === "links_json") {
              try { section[key === "faq_json" ? "items" : "links"] = val.trim() ? JSON.parse(val) : []; }
              catch { section[key === "faq_json" ? "items" : "links"] = []; }
            } else if (key === "cta_url") {
              section.url = val;
            } else if (key === "cta_label") {
              section.label = val;
            } else {
              section[key] = val;
            }
          });
          const spotlightsContainer = row.querySelector("[data-spotlights-container]");
          if (spotlightsContainer) {
            section.spotlights = Array.from(spotlightsContainer.querySelectorAll("[data-spotlight-row]")).map((sRow) => {
              const casinoSel = sRow.querySelector("[data-spotlight-field='casino_id']");
              const bodyEl = sRow.querySelector("[data-spotlight-field='body']");
              return {
                casino_id: casinoSel && casinoSel.value ? Number(casinoSel.value) : null,
                body: bodyEl ? bodyEl.value : ""
              };
            });
          }
          return section;
        }).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      }

      document.getElementById("saveBtn").addEventListener("click", async () => {
        syncSectionsFromDom();
        const payload = {
          name: document.getElementById("nameInput").value,
          seo_title: document.getElementById("seoTitleInput").value,
          seo_description: document.getElementById("seoDescInput").value,
          robots: document.getElementById("robotsSelect").value,
          status: document.getElementById("statusSelect").value,
          published: document.getElementById("publishedCheck").checked,
          content_json: { sections: pageSections }
        };
        if (HUB_KIND === "country") {
          payload.code = document.getElementById("idInput").value;
          payload.currency = document.getElementById("currencyInput").value;
          payload.language = document.getElementById("languageInput").value;
          payload.legal_status = document.getElementById("legalStatusInput").value;
        } else {
          payload.slug = document.getElementById("idInput").value;
          payload.description = document.getElementById("descriptionInput").value;
        }

        const flash = document.getElementById("formFlash");
        const res = await fetch(${JSON.stringify(actionUrl)}, {
          method: IS_EDIT ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (data.success) {
          location.href = HUB_KIND === "country" ? "/content/countries" : "/content/categories";
        } else {
          flash.innerHTML = '<div class="flash flash-error">' + (data.message || data.error || "Could not save.") + '</div>';
        }
      });
    </script>`;
}

// -----------------------------------------------------
// Proxies to the tenant's Super API
// -----------------------------------------------------

export async function submitCreateHubPage(env, admin, kind, payload) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return postToTenant(env, tenant, `${BASE_PATH}/${kind === "country" ? "countries" : "categories"}`, payload);
}

export async function submitUpdateHubPage(env, admin, kind, id, payload) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return putToTenant(env, tenant, `${BASE_PATH}/${kind === "country" ? "countries" : "categories"}/${encodeURIComponent(id)}`, payload);
}

export async function submitDeleteHubPage(env, admin, kind, id) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return deleteFromTenant(env, tenant, `${BASE_PATH}/${kind === "country" ? "countries" : "categories"}/${encodeURIComponent(id)}`);
}

// Country hub pages reuse the existing seo-pages eligible-casinos
// route with no category_slug (falls back to the plain country
// allowlist server-side — see handleGetEligibleCasinosForSeoPage).
// Category hub pages have no country context at all, so they use
// the dedicated category-eligible-casinos route instead.
export async function proxyHubEligibleCasinos(env, admin, countryCode, categorySlug) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  const path = countryCode
    ? `${BASE_PATH}/seo-pages-eligible-casinos?country_code=${encodeURIComponent(countryCode)}`
    : `${BASE_PATH}/category-eligible-casinos?slug=${encodeURIComponent(categorySlug)}`;
  return getFromTenant(env, tenant, path);
}

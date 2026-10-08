// =====================================================
// SEO LANDING PAGES admin
//   Country Pages       -> /content/country-pages
//   Category Countries  -> /content/category-countries
// Wraps the tenant's seo-pages Super API (worker/super/handlers.js
// SEO LANDING PAGES section). Custom-built rather than the generic
// resources.js/crud.js engine because these pages need a country
// search-picker, a casino picker scoped to eligibility, and a
// section builder — none of which the generic field types cover.
// =====================================================

import { renderShell, escapeHtml } from "../layout.js";
import { getFromTenant, postToTenant, putToTenant, deleteFromTenant } from "../../client.js";
import { getTenant } from "../../registry.js";
import { renderRichTextField } from "./crud.js";
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
  const color = published ? "var(--success, #16a34a)" : status === "eligible" ? "var(--text-dim)" : "var(--warning, #d97706)";
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;border:1px solid ${color};color:${color};">${escapeHtml(status)}</span>`;
}

// -----------------------------------------------------
// COUNTRY PAGES — /content/country-pages
// -----------------------------------------------------

export async function renderCountryPagesList(env, admin) {
  const activeKey = "content-country-pages";
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return noTenantNotice(env, admin, activeKey, "Country Pages");

  const result = await getFromTenant(env, tenant, `${BASE_PATH}/seo-pages?page_type=country_custom`);
  if (!result.ok) {
    const body = `<h1>Country Pages</h1><div class="flash flash-error"><strong>${escapeHtml(String(result.status))}</strong> — ${escapeHtml(result.message || "Could not load country pages. If this tenant hasn't redeployed with the new /en/api/super/seo-pages routes yet, that's why.")}</div>`;
    return renderShell({ title: "Country Pages", activeKey, admin, bodyHtml: body, env });
  }

  const rows = result.data.data || [];

  const rowsHtml = rows.length
    ? `<table>
        <thead><tr><th>Title</th><th>Country</th><th>URL</th><th>Status</th><th>Index</th><th>Author</th><th>Updated</th><th></th></tr></thead>
        <tbody>
          ${rows
            .map(
              (r) => `<tr>
                <td>${escapeHtml(r.title)}</td>
                <td>${escapeHtml(r.country_code)}</td>
                <td><code>/en/country/${escapeHtml(r.country_code)}/${escapeHtml(r.slug)}</code></td>
                <td>${statusBadge(r.status, r.published)}</td>
                <td>${escapeHtml((r.robots || "").includes("noindex") ? "noindex" : "index")}</td>
                <td>${escapeHtml(r.author_id || "—")}</td>
                <td>${escapeHtml((r.updated_at || "").split(" ")[0] || "")}</td>
                <td>
                  <a href="/content/country-pages/${r.id}/edit">Edit</a>
                  &nbsp;·&nbsp;
                  <a href="#"${onClick("seoPageDelete", [r.id], {confirm: "Delete this page?", prevent: true})} style="color:var(--danger);">Delete</a>
                </td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table>`
    : `<div class="empty">No custom country pages yet.</div>`;

  const body = `
    <h1>Country Pages</h1>
    <p class="subtitle">Content · Country Pages on <strong>${escapeHtml(tenant.name)}</strong></p>
    <div class="card">
      <div style="display:flex;justify-content:flex-end;margin-bottom:14px;"><a class="btn" href="/content/country-pages/new">New</a></div>
      ${rowsHtml}
    </div>
    <script nonce="${nonceToken()}">
      function seoPageDelete(id) {
        fetch("/api/seo-pages/" + id, { method: "DELETE" })
          .then((r) => r.json())
          .then((data) => {
            if (data.success) location.reload();
            else alert("Delete failed: " + (data.error || data.message || "unknown error"));
          })
          .catch(() => alert("Delete failed."));
      }
    </script>
  `;
  return renderShell({ title: "Country Pages", activeKey, admin, bodyHtml: body, env });
}

export async function renderCountryPageForm(env, admin, id) {
  const activeKey = "content-country-pages";
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return noTenantNotice(env, admin, activeKey, "Country Pages");

  let record = null;
  if (id) {
    const result = await getFromTenant(env, tenant, `${BASE_PATH}/seo-pages/${encodeURIComponent(id)}`);
    if (!result.ok) {
      const body = `<h1>Country Pages</h1><div class="flash flash-error">Could not load that page.</div>`;
      return renderShell({ title: "Country Pages", activeKey, admin, bodyHtml: body, env });
    }
    record = result.data.data;
  }

  const authorsResult = await getFromTenant(env, tenant, `${BASE_PATH}/authors`);
  const authors = authorsResult.ok ? authorsResult.data.data || [] : [];

  const body = renderSeoPageFormShell({
    pageType: "country_custom",
    listUrl: "/content/country-pages",
    actionUrl: id ? `/api/seo-pages/${id}` : `/api/seo-pages`,
    tenantName: tenant.name,
    record,
    authors,
    isEdit: !!id
  });

  return renderShell({ title: id ? "Edit Country Page" : "New Country Page", activeKey, admin, bodyHtml: body, env });
}

// -----------------------------------------------------
// CATEGORY COUNTRIES — /content/category-countries
// -----------------------------------------------------

export async function renderCategoryCountriesList(env, admin) {
  const activeKey = "content-category-countries";
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return noTenantNotice(env, admin, activeKey, "Category Countries");

  const discoverResult = await getFromTenant(env, tenant, `${BASE_PATH}/seo-pages-discover?min=1`);
  if (!discoverResult.ok) {
    const body = `<h1>Category Countries</h1><div class="flash flash-error"><strong>${escapeHtml(String(discoverResult.status))}</strong> — ${escapeHtml(discoverResult.message || "Could not load eligibility data. If this tenant hasn't redeployed with the new /en/api/super/seo-pages routes yet, that's why.")}</div>`;
    return renderShell({ title: "Category Countries", activeKey, admin, bodyHtml: body, env });
  }

  const combos = discoverResult.data.data || [];

  // Group by category for the tree-style display the spec asked for.
  const byCategory = {};
  for (const c of combos) {
    if (!byCategory[c.category_slug]) byCategory[c.category_slug] = { name: c.category_name, rows: [] };
    byCategory[c.category_slug].rows.push(c);
  }

  const groupsHtml = Object.entries(byCategory)
    .map(([slug, group]) => `
      <div class="card" style="margin-bottom:14px;">
        <h3 style="margin-top:0;">${escapeHtml(group.name)}</h3>
        <table>
          <thead><tr><th>Country</th><th>Casinos</th><th>Status</th><th>URL</th><th></th></tr></thead>
          <tbody>
            ${group.rows
              .map(
                (r) => `<tr>
                  <td>${escapeHtml(r.country_name)} (${escapeHtml(r.country_code)})</td>
                  <td>${r.casino_count}</td>
                  <td>${statusBadge(r.status, r.published)}</td>
                  <td><code>/en/category/${escapeHtml(slug)}/${escapeHtml(r.country_code)}</code></td>
                  <td>
                    ${
                      r.seo_page_id
                        ? `<a href="/content/category-countries/${r.seo_page_id}/edit">Edit</a>`
                        : `<a href="#" data-generate-draft data-category-id="${r.category_id}" data-category-slug="${escapeHtml(slug)}" data-category-name="${escapeHtml(r.category_name)}" data-country-code="${escapeHtml(r.country_code)}" data-country-name="${escapeHtml(r.country_name)}">Generate draft</a>`
                    }
                  </td>
                </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>`)
    .join("");

  const body = `
    <h1>Category Countries</h1>
    <p class="subtitle">Content · Category Countries on <strong>${escapeHtml(tenant.name)}</strong> — eligible category &times; country combinations, auto-discovered from real casino data</p>
    <div class="card">
      <p style="font-size:13px;color:var(--text-dim);margin-top:0;">"Eligible" means at least one published casino satisfies both the category and the country's geo rules, but no page has been generated yet. Click "Generate draft" to create one, or <a href="/content/category-countries/new">create a page manually</a> for a combination not listed here.</p>
    </div>
    ${groupsHtml || `<div class="card"><div class="empty">No eligible category/country combinations found yet.</div></div>`}
    <script nonce="${nonceToken()}">
      document.body.addEventListener("click", async (e) => {
        const btn = e.target.closest("[data-generate-draft]");
        if (!btn) return;
        e.preventDefault();
        btn.textContent = "Generating…";
        const res = await fetch("/api/seo-pages/generate-draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            category_id: btn.dataset.categoryId,
            category_slug: btn.dataset.categorySlug,
            category_name: btn.dataset.categoryName,
            country_code: btn.dataset.countryCode,
            country_name: btn.dataset.countryName
          })
        });
        const data = await res.json().catch(() => ({}));
        if (data.success && data.data?.id) {
          location.href = "/content/category-countries/" + data.data.id + "/edit";
        } else {
          alert("Could not generate: " + (data.message || data.error || "unknown error"));
          btn.textContent = "Generate draft";
        }
      });
    </script>
  `;
  return renderShell({ title: "Category Countries", activeKey, admin, bodyHtml: body, env });
}

// -----------------------------------------------------
// Shared form shell for both page types
// -----------------------------------------------------

function renderSeoPageFormShell({ pageType, listUrl, actionUrl, tenantName, record, authors, categories, isEdit }) {
  const r = record || {};
  let content = {};
  try {
    content = typeof r.content_json === "string" ? JSON.parse(r.content_json) : r.content_json || {};
  } catch {
    content = {};
  }
  const sections = Array.isArray(content.sections) ? content.sections : [];
  const casinoSelections = Array.isArray(r.casino_selections) ? r.casino_selections : [];

  const authorOptionsHtml = authors
    .map((a) => `<option value="${a.id}" ${String(r.author_id) === String(a.id) ? "selected" : ""}>${escapeHtml(a.name)}</option>`)
    .join("");

  const categoryOptionsHtml = pageType === "category_country"
    ? (categories || [])
        .map((c) => `<option value="${c.id}" data-slug="${escapeHtml(c.slug)}" data-name="${escapeHtml(c.name)}" ${String(r.category_id) === String(c.id) ? "selected" : ""}>${escapeHtml(c.name)}</option>`)
        .join("")
    : "";

  return `
    <h1>${isEdit ? "Edit" : "New"} ${pageType === "country_custom" ? "Country Page" : "Category Country Page"}</h1>
    <p class="subtitle">on <strong>${escapeHtml(tenantName)}</strong></p>
    <div id="formFlash"></div>

    <div class="card" style="max-width:760px;">
      <h3 style="margin-top:0;">1. Target</h3>
      ${
        pageType === "category_country"
          ? `<label for="categorySelect">Category</label>
             <select id="categorySelect" ${isEdit ? "disabled" : ""}>
               <option value="">Select a category…</option>
               ${categoryOptionsHtml}
             </select>
             ${isEdit ? `<input type="hidden" id="categoryIdHidden" value="${escapeHtml(r.category_id || "")}" />` : ""}`
          : ""
      }

      <label for="countrySearch">Country ${pageType === "country_custom" ? "" : ""}</label>
      <input type="text" id="countrySearch" placeholder="Type a country code or name — e.g. CA or Canada" value="${escapeHtml(r.country_code || "")}" ${isEdit ? "readonly" : ""} autocomplete="off" />
      <div id="countryResults" style="border:1px solid var(--panel-border);border-radius:8px;margin-top:-8px;margin-bottom:14px;max-height:180px;overflow-y:auto;display:none;"></div>
      <input type="hidden" id="countryCodeHidden" value="${escapeHtml(r.country_code || "")}" />
      <input type="hidden" id="countryNameHidden" value="" />

      ${
        pageType === "country_custom"
          ? `<label for="slugInput">Custom slug</label>
             <input type="text" id="slugInput" value="${escapeHtml(r.slug || "")}" placeholder="best-easy-to-use-casinos" ${isEdit ? "readonly" : ""} />
             <p id="urlPreview" style="font-size:13px;color:var(--text-dim);margin-top:-10px;">URL: <code>/en/country/${escapeHtml(r.country_code || "{code}")}/${escapeHtml(r.slug || "{slug}")}</code></p>`
          : `<p style="font-size:13px;color:var(--text-dim);">URL: <code id="urlPreview">/en/category/{category}/{code}</code></p>`
      }
    </div>

    <div class="card" style="max-width:760px;">
      <h3 style="margin-top:0;">2. SEO &amp; metadata</h3>
      <label for="titleInput">Page title</label>
      <input type="text" id="titleInput" value="${escapeHtml(r.title || "")}" required />

      <label for="navLabelInput">Navigation label</label>
      <input type="text" id="navLabelInput" value="${escapeHtml(r.nav_label || "")}" placeholder="Crypto Casinos" maxlength="40" />
      <p style="font-size:12px;color:var(--text-dim);margin-top:-8px;">Shown in the hub page's sub-navigation tabs — keep it short (2-4 words). Leave blank to use the page title above.</p>

      <label for="seoTitleInput">SEO title</label>
      <input type="text" id="seoTitleInput" value="${escapeHtml(r.seo_title || "")}" />

      <label for="seoDescInput">SEO description</label>
      <textarea id="seoDescInput" rows="2">${escapeHtml(r.seo_description || "")}</textarea>

      <label for="ogImageInput">OG image URL</label>
      <input type="url" id="ogImageInput" value="${escapeHtml(r.og_image || "")}" />

      <label for="featuredImageInput">Featured image URL</label>
      <input type="url" id="featuredImageInput" value="${escapeHtml(r.featured_image || "")}" />

      <label for="canonicalInput">Canonical URL <span style="color:var(--text-dim);font-weight:400;">— leave blank to use the default</span></label>
      <input type="url" id="canonicalInput" value="${escapeHtml(r.canonical_url || "")}" />

      <label for="robotsSelect">Robots</label>
      <select id="robotsSelect">
        ${["index,follow", "noindex,follow", "index,nofollow", "noindex,nofollow"]
          .map((opt) => `<option value="${opt}" ${(r.robots || "index,follow") === opt ? "selected" : ""}>${opt}</option>`)
          .join("")}
      </select>

      <label for="authorSelect">Author</label>
      <select id="authorSelect">
        <option value="">— none —</option>
        ${authorOptionsHtml}
      </select>
    </div>

    <div class="card" style="max-width:760px;">
      <h3 style="margin-top:0;">3. Casino selection</h3>
      <label for="casinoModeSelect">Mode</label>
      <select id="casinoModeSelect">
        <option value="manual" ${r.casino_mode === "manual" ? "selected" : ""}>Manual — only what I select below</option>
        <option value="auto" ${r.casino_mode === "auto" ? "selected" : ""}>Automatic — fully database-driven</option>
        <option value="auto_priority" ${(r.casino_mode || "auto_priority") === "auto_priority" ? "selected" : ""}>Automatic + editorial priority (recommended)</option>
      </select>
      <p style="font-size:13px;color:var(--text-dim);margin-top:-6px;">Pick the country ${pageType === "category_country" ? "(and this page already has its category)" : ""} above first — eligible casinos load automatically below.</p>

      <div id="casinoPickerRoot">
        <div id="casinoSelectedList" style="margin-bottom:10px;"></div>
        <div style="display:flex;gap:8px;">
          <select id="casinoAddSelect" style="flex:1;"><option value="">Load a country first…</option></select>
          <button type="button" class="btn btn-secondary btn-small" id="casinoAddBtn">Add</button>
        </div>
      </div>
      <input type="hidden" id="casinoSelectionsHidden" value='${escapeHtml(JSON.stringify(casinoSelections.map((c, i) => ({ casino_id: c.id, position: i, display_mode: c.display_mode || "card", custom_label: c.custom_label || null, is_featured: !!c.is_featured }))))}' />
    </div>

    <div class="card" style="max-width:760px;">
      <h3 style="margin-top:0;">4. Intro</h3>
      ${renderRichTextField({ name: "introField", label: "Intro / hero content" }, content.intro || "")}
    </div>

    <div class="card" style="max-width:760px;">
      <h3 style="margin-top:0;">5. Content sections</h3>
      <p style="font-size:13px;color:var(--text-dim);margin-top:0;">Reorderable via position. Only the fields relevant to the chosen type are used when the page renders.</p>
      <div id="sectionsRoot"></div>
      <button type="button" class="btn btn-secondary btn-small" id="addSectionBtn">+ Add section</button>
      <input type="hidden" id="sectionsHidden" />
    </div>

    <div class="card" style="max-width:760px;">
      <h3 style="margin-top:0;">6. Publishing</h3>
      <label for="statusSelect">Status</label>
      <select id="statusSelect">
        ${["draft", "reviewed", "published"].map((s) => `<option value="${s}" ${(r.status || "draft") === s ? "selected" : ""}>${s}</option>`).join("")}
      </select>
      <label style="display:flex;align-items:center;gap:8px;font-weight:400;"><input type="checkbox" id="publishedCheck" style="width:auto;" ${r.published ? "checked" : ""} /> Published (live on the site)</label>
      <label style="display:flex;align-items:center;gap:8px;font-weight:400;"><input type="checkbox" id="sitemapCheck" style="width:auto;" ${r.sitemap_enabled !== false ? "checked" : ""} /> Include in sitemap</label>
      ${pageType === "category_country" ? `<label for="minCasinoInput">Minimum casino count</label><input type="number" id="minCasinoInput" value="${r.min_casino_count ?? 1}" style="max-width:100px;" />` : ""}
    </div>

    <button class="btn" type="button" id="saveBtn">${isEdit ? "Save changes" : "Create"}</button>
    <a class="btn btn-secondary" href="${listUrl}">Cancel</a>
    ${isEdit ? `<a href="#"${onClick("seoPageDeleteAndRedirect", [r.id, listUrl], {confirm: "Delete this page?", prevent: true})} style="color:var(--danger);margin-left:14px;">Delete</a>` : ""}
    <script nonce="${nonceToken()}">
      function seoPageDeleteAndRedirect(id, redirectTo) {
        fetch("/api/seo-pages/" + id, { method: "DELETE" })
          .then((r) => r.json())
          .then((data) => {
            if (data.success) location.href = redirectTo;
            else alert("Delete failed: " + (data.error || data.message || "unknown error"));
          })
          .catch(() => alert("Delete failed."));
      }
    </script>

    ${renderSeoPageFormScript({ pageType, actionUrl, isEdit, sections, casinoSelections, record: r })}
  `;
}

function renderSeoPageFormScript({ pageType, actionUrl, isEdit, sections, casinoSelections, record }) {
  return `
    <script nonce="${nonceToken()}">
      const PAGE_TYPE = ${JSON.stringify(pageType)};
      const IS_EDIT = ${JSON.stringify(isEdit)};
      const RECORD_ID = ${JSON.stringify(record.id || null)};
      let selectedCasinos = ${JSON.stringify(casinoSelections.map((c) => ({ casino_id: c.id, name: c.name, position: 0, display_mode: c.display_mode || "card", custom_label: c.custom_label || null, is_featured: !!c.is_featured })))};
      let pageSections = ${JSON.stringify(sections)};
      let eligibleCasinos = [];
      let currentCountryCode = ${JSON.stringify(record.country_code || "")};
      let currentCountryName = "";
      let currentCategorySlug = ${JSON.stringify(pageType === "category_country" ? "" : null)};

      // ---------- Country search ----------
      const countrySearch = document.getElementById("countrySearch");
      const countryResults = document.getElementById("countryResults");
      let countrySearchTimer;
      if (countrySearch && !IS_EDIT) {
        countrySearch.addEventListener("input", () => {
          clearTimeout(countrySearchTimer);
          const q = countrySearch.value.trim();
          if (q.length < 1) { countryResults.style.display = "none"; return; }
          countrySearchTimer = setTimeout(async () => {
            const res = await fetch("/api/seo-pages/countries-search?q=" + encodeURIComponent(q));
            const data = await res.json().catch(() => ({}));
            const items = (data.data || []);
            if (items.length === 0) { countryResults.style.display = "none"; return; }
            countryResults.innerHTML = items.map((c) =>
              '<div data-country-code="' + c.code + '" data-country-name="' + c.name.replace(/"/g,"&quot;") + '" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--panel-border);">' + c.name + ' (' + c.code + ')</div>'
            ).join("");
            countryResults.style.display = "block";
          }, 250);
        });
        countryResults.addEventListener("click", (e) => {
          const item = e.target.closest("[data-country-code]");
          if (!item) return;
          currentCountryCode = item.dataset.countryCode;
          currentCountryName = item.dataset.countryName;
          countrySearch.value = currentCountryName + " (" + currentCountryCode + ")";
          document.getElementById("countryCodeHidden").value = currentCountryCode;
          document.getElementById("countryNameHidden").value = currentCountryName;
          countryResults.style.display = "none";
          updateUrlPreview();
          loadEligibleCasinos();
        });
      } else if (IS_EDIT) {
        loadEligibleCasinos();
      }

      function updateUrlPreview() {
        const preview = document.getElementById("urlPreview");
        if (!preview) return;
        if (PAGE_TYPE === "country_custom") {
          const slug = document.getElementById("slugInput").value || "{slug}";
          preview.innerHTML = "URL: <code>/en/country/" + (currentCountryCode || "{code}") + "/" + slug + "</code>";
        } else {
          preview.textContent = "/en/category/" + (currentCategorySlug || "{category}") + "/" + (currentCountryCode || "{code}");
        }
      }

      const slugInput = document.getElementById("slugInput");
      if (slugInput) slugInput.addEventListener("input", updateUrlPreview);

      // ---------- Category select (category_country only) ----------
      const categorySelect = document.getElementById("categorySelect");
      if (categorySelect) {
        if (IS_EDIT) {
          currentCategorySlug = null; // locked; URL preview not critical on edit
        } else {
          categorySelect.addEventListener("change", () => {
            const opt = categorySelect.options[categorySelect.selectedIndex];
            currentCategorySlug = opt.dataset.slug || "";
            updateUrlPreview();
            loadEligibleCasinos();
          });
        }
      }

      // ---------- Casino picker ----------
      const casinoAddSelect = document.getElementById("casinoAddSelect");
      const casinoAddBtn = document.getElementById("casinoAddBtn");
      const casinoSelectedList = document.getElementById("casinoSelectedList");

      async function loadEligibleCasinos() {
        if (!currentCountryCode) return;
        let url = "/api/seo-pages/eligible-casinos?country_code=" + encodeURIComponent(currentCountryCode);
        if (PAGE_TYPE === "category_country" && currentCategorySlug) {
          url += "&category_slug=" + encodeURIComponent(currentCategorySlug);
        }
        const res = await fetch(url);
        const data = await res.json().catch(() => ({}));
        eligibleCasinos = data.data || [];
        renderCasinoAddOptions();
        renderSelectedCasinos();
        // Section-level casino pickers (casino_grid / casino_editorial) are
        // rendered before this fetch resolves when opening an existing page
        // for edit — capture whatever's already been typed, then re-render
        // the section rows now that real casino names/IDs are available.
        syncSectionsFromDom();
        renderSections();
      }

      function renderCasinoAddOptions() {
        if (!casinoAddSelect) return;
        const selectedIds = new Set(selectedCasinos.map((c) => c.casino_id));
        casinoAddSelect.innerHTML = '<option value="">Add a casino…</option>' +
          eligibleCasinos.filter((c) => !selectedIds.has(c.id)).map((c) =>
            '<option value="' + c.id + '" data-name="' + (c.name || "").replace(/"/g,"&quot;") + '">' + c.name + '</option>'
          ).join("");
      }

      function renderSelectedCasinos() {
        if (!casinoSelectedList) return;
        if (selectedCasinos.length === 0) {
          casinoSelectedList.innerHTML = '<p style="color:var(--text-dim);font-size:13px;">No casinos selected yet.</p>';
          return;
        }
        casinoSelectedList.innerHTML = selectedCasinos.map((c, i) => {
          const known = eligibleCasinos.find((e) => e.id === c.casino_id);
          const name = known ? known.name : (c.name || ("#" + c.casino_id));
          return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--panel-border);" data-casino-row="' + i + '">' +
            '<span style="flex:1;">' + name + '</span>' +
            '<label style="font-weight:400;font-size:12px;display:flex;align-items:center;gap:4px;"><input type="checkbox" data-featured style="width:auto;" ' + (c.is_featured ? "checked" : "") + ' /> Featured</label>' +
            '<input type="text" data-custom-label placeholder="Custom label" value="' + (c.custom_label || "") + '" style="width:140px;margin:0;" />' +
            '<button type="button" class="btn btn-secondary btn-small" data-remove-casino>✕</button>' +
            '</div>';
        }).join("");
      }

      if (casinoAddBtn) {
        casinoAddBtn.addEventListener("click", () => {
          const id = Number(casinoAddSelect.value);
          if (!id) return;
          const opt = casinoAddSelect.options[casinoAddSelect.selectedIndex];
          selectedCasinos.push({ casino_id: id, name: opt.dataset.name, is_featured: false, custom_label: null });
          renderCasinoAddOptions();
          renderSelectedCasinos();
        });
      }
      if (casinoSelectedList) {
        casinoSelectedList.addEventListener("click", (e) => {
          const removeBtn = e.target.closest("[data-remove-casino]");
          if (!removeBtn) return;
          const row = removeBtn.closest("[data-casino-row]");
          selectedCasinos.splice(Number(row.dataset.casinoRow), 1);
          renderCasinoAddOptions();
          renderSelectedCasinos();
        });
        casinoSelectedList.addEventListener("change", (e) => {
          const row = e.target.closest("[data-casino-row]");
          if (!row) return;
          const i = Number(row.dataset.casinoRow);
          if (e.target.matches("[data-featured]")) selectedCasinos[i].is_featured = e.target.checked;
        });
        casinoSelectedList.addEventListener("input", (e) => {
          const row = e.target.closest("[data-casino-row]");
          if (!row) return;
          const i = Number(row.dataset.casinoRow);
          if (e.target.matches("[data-custom-label]")) selectedCasinos[i].custom_label = e.target.value;
        });
      }
      renderSelectedCasinos();

      // ---------- Section builder ----------
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

      // Section data is stored under different keys than the form fields that
      // edit it (e.g. the faq_json textarea edits section.items, not
      // section.faq_json). Used both to read the current value into the
      // field and, for FAQ, to decide when to show the default starter
      // template instead of a blank textarea.
      const SECTION_FIELD_TO_DATA_KEY = {
        faq_json: "items",
        links_json: "links",
        cta_url: "url",
        cta_label: "label"
      };

      const DEFAULT_FAQ_ITEMS = [
        { q: "Is this casino safe and legal to play at?", a: "" },
        { q: "What payment methods are accepted?", a: "" },
        { q: "Is there a welcome bonus for new players?", a: "" },
        { q: "Can I play on mobile?", a: "" }
      ];

      function casinoPickerOptionsHtml(selectedIds) {
        const pool = (eligibleCasinos && eligibleCasinos.length) ? eligibleCasinos :
          selectedCasinos.map((c) => ({ id: c.casino_id, name: c.name || ("#" + c.casino_id) }));
        return pool.map((c) =>
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
            // Casino fields: a real picker sourced from this page's
            // eligible/selected casinos, instead of a text box where the
            // editor has to already know (or guess) the numeric casino ID.
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
                '<p style="color:var(--text-dim);font-size:12px;margin:4px 0 10px;">Ctrl/Cmd-click (or long-press on mobile) to select multiple. Type a letter to jump to a casino by name.</p>';
            }
            // casino_spotlights: several independent {casino_id, body}
            // pairs inside one section — unlike casino_editorial (always
            // exactly one casino) this is a repeatable list the editor
            // builds up with its own add/remove controls, wired below.
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
            // FAQ sections start pre-filled with common starter questions
            // instead of a blank textarea — the editor edits/replaces them
            // rather than writing JSON from scratch. Only applies while the
            // section has no items yet.
            if (f === "faq_json" && (!Array.isArray(raw) || raw.length === 0)) raw = DEFAULT_FAQ_ITEMS;
            const val = (raw !== undefined && raw !== null) ? (typeof raw === "object" ? JSON.stringify(raw, null, 2) : raw) : "";
            if (f === "body" || f === "faq_json" || f === "links_json") {
              return '<label>' + FIELD_LABELS[f] + '</label><textarea data-section-field="' + f + '" rows="' + (f === "body" ? 3 : 6) + '">' + escapeForHtml(val) + '</textarea>';
            }
            return '<label>' + FIELD_LABELS[f] + '</label><input type="text" data-section-field="' + f + '" value="' + escapeForHtml(val) + '" />';
          }).join("") +
          '</div>';
      }

      function escapeForHtml(s) {
        return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
        // casino_spotlights add/remove — checked before data-remove-section
        // since a spotlight row also sits inside a [data-section-row], and
        // its own remove button must not be mistaken for removing the
        // whole section.
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
          // casino_spotlights: repeatable {casino_id, body} rows live in
          // their own container (data-spotlights-container /
          // data-spotlight-row), outside the generic data-section-field
          // loop above, since each row needs two paired values rather
          // than one field = one value.
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

      // ---------- Save ----------
      document.getElementById("saveBtn").addEventListener("click", async () => {
        syncSectionsFromDom();
        const introHidden = document.querySelector('[name="introField"]');

        const payload = {
          title: document.getElementById("titleInput").value,
          nav_label: document.getElementById("navLabelInput").value || null,
          seo_title: document.getElementById("seoTitleInput").value,
          seo_description: document.getElementById("seoDescInput").value,
          og_image: document.getElementById("ogImageInput").value,
          featured_image: document.getElementById("featuredImageInput").value,
          canonical_url: document.getElementById("canonicalInput").value,
          robots: document.getElementById("robotsSelect").value,
          author_id: document.getElementById("authorSelect").value || null,
          casino_mode: document.getElementById("casinoModeSelect").value,
          status: document.getElementById("statusSelect").value,
          published: document.getElementById("publishedCheck").checked,
          sitemap_enabled: document.getElementById("sitemapCheck").checked,
          content_json: { intro: introHidden ? introHidden.value : "", sections: pageSections },
          casino_selections: selectedCasinos.map((c, i) => ({
            casino_id: c.casino_id, position: i, display_mode: "card",
            custom_label: c.custom_label || null, is_featured: !!c.is_featured
          }))
        };

        if (PAGE_TYPE === "country_custom") {
          payload.page_type = "country_custom";
          payload.slug = document.getElementById("slugInput").value;
          payload.country_code = currentCountryCode || document.getElementById("countryCodeHidden").value;
        } else {
          payload.page_type = "category_country";
          const catIdField = document.getElementById("categoryIdHidden");
          payload.category_id = catIdField ? Number(catIdField.value) : Number(document.getElementById("categorySelect").value);
          payload.slug = document.getElementById("categorySelect") ? (document.getElementById("categorySelect").options[document.getElementById("categorySelect").selectedIndex]?.dataset.slug) : undefined;
          payload.country_code = currentCountryCode || document.getElementById("countryCodeHidden").value;
          payload.min_casino_count = Number(document.getElementById("minCasinoInput").value) || 1;
        }

        const flash = document.getElementById("formFlash");
        const res = await fetch(${JSON.stringify(actionUrl)}, {
          method: IS_EDIT ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (data.success) {
          location.href = PAGE_TYPE === "country_custom" ? "/content/country-pages" : "/content/category-countries";
        } else {
          flash.innerHTML = '<div class="flash flash-error">' + (data.message || data.error || "Could not save.") + '</div>';
        }
      });
    </script>`;
}

export async function renderCategoryCountryForm(env, admin, id) {
  const activeKey = "content-category-countries";
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return noTenantNotice(env, admin, activeKey, "Category Countries");

  let record = null;
  if (id) {
    const result = await getFromTenant(env, tenant, `${BASE_PATH}/seo-pages/${encodeURIComponent(id)}`);
    if (!result.ok) {
      const body = `<h1>Category Countries</h1><div class="flash flash-error">Could not load that page.</div>`;
      return renderShell({ title: "Category Countries", activeKey, admin, bodyHtml: body, env });
    }
    record = result.data.data;
  }

  const [authorsResult, categoriesResult] = await Promise.all([
    getFromTenant(env, tenant, `${BASE_PATH}/authors`),
    getFromTenant(env, tenant, `${BASE_PATH}/categories`)
  ]);
  const authors = authorsResult.ok ? authorsResult.data.data || [] : [];
  const categories = categoriesResult.ok ? categoriesResult.data.data || [] : [];

  const body = renderSeoPageFormShell({
    pageType: "category_country",
    listUrl: "/content/category-countries",
    actionUrl: id ? `/api/seo-pages/${id}` : `/api/seo-pages`,
    tenantName: tenant.name,
    record,
    authors,
    categories,
    isEdit: !!id
  });

  return renderShell({ title: id ? "Edit Category Country Page" : "New Category Country Page", activeKey, admin, bodyHtml: body, env });
}

// -----------------------------------------------------
// Submit / proxy functions — called from index.js's /api/* block.
// -----------------------------------------------------

export async function submitCreateSeoPage(env, admin, payload) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return postToTenant(env, tenant, `${BASE_PATH}/seo-pages`, { ...payload, created_by: admin.id, updated_by: admin.id });
}

export async function submitUpdateSeoPage(env, admin, id, payload) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return putToTenant(env, tenant, `${BASE_PATH}/seo-pages/${encodeURIComponent(id)}`, { ...payload, updated_by: admin.id });
}

export async function submitDeleteSeoPage(env, admin, id) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return deleteFromTenant(env, tenant, `${BASE_PATH}/seo-pages/${encodeURIComponent(id)}`);
}

export async function proxySearchCountries(env, admin, query) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return getFromTenant(env, tenant, `${BASE_PATH}/seo-pages-countries-search?q=${encodeURIComponent(query)}`);
}

export async function proxyEligibleCasinos(env, admin, countryCode, categorySlug) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  let path = `${BASE_PATH}/seo-pages-eligible-casinos?country_code=${encodeURIComponent(countryCode)}`;
  if (categorySlug) path += `&category_slug=${encodeURIComponent(categorySlug)}`;
  return getFromTenant(env, tenant, path);
}

// "Generate draft" from the Category Countries eligibility screen —
// creates a real seo_pages row (auto_generated = true, status =
// draft, published = false) for a combination the discovery engine
// found eligible, then the admin is redirected to edit it.
export async function submitGenerateCategoryCountryDraft(env, admin, payload) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };

  return postToTenant(env, tenant, `${BASE_PATH}/seo-pages`, {
    page_type: "category_country",
    slug: payload.category_slug,
    country_code: payload.country_code,
    category_id: Number(payload.category_id),
    title: `${payload.category_name} Casinos in ${payload.country_name}`,
    casino_mode: "auto_priority",
    status: "draft",
    published: false,
    sitemap_enabled: true,
    auto_generated: true,
    content_json: {},
    created_by: admin.id,
    updated_by: admin.id
  });
}

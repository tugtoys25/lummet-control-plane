import { renderShell, escapeHtml } from "../layout.js";
import { getFromTenant, postToTenant, putToTenant, deleteFromTenant, messageForStatus } from "../../client.js";
import { getTenant, getTenantCapabilities } from "../../registry.js";
import { onClick, onChange, nonceToken, BROWSER_HELPER } from "../../csp.js";

const BASE_PATH = "/en/api/super";

function nav(resourceKey, config) {
  return config.section === "System" ? `system-${resourceKey}` : `content-${resourceKey}`;
}

function basePagePath(resourceKey, config) {
  return config.section === "System" ? `/system/${resourceKey}` : `/content/${resourceKey}`;
}

function formatCell(value, columnType) {
  if (columnType === "bool") {
    return value ? '<span class="badge badge-ok">Yes</span>' : '<span class="badge badge-dim">No</span>';
  }
  if (value == null || value === "") return '<span style="color:var(--text-dim);">—</span>';
  return escapeHtml(String(value));
}

async function resolveActiveTenant(env, admin) {
  if (!admin.activeTenantId) return { tenant: null, capabilityDisabled: false };
  const tenant = await getTenant(env, admin.activeTenantId);
  if (!tenant) return { tenant: null, capabilityDisabled: false };
  return { tenant, capabilityDisabled: false };
}

async function isCapabilityDisabled(env, tenantId, resourceKey) {
  const capabilities = await getTenantCapabilities(env, tenantId);
  if (capabilities.length === 0) return false; // not tested yet — don't block optimistically
  const row = capabilities.find((c) => c.capability === resourceKey);
  return row ? row.enabled === 0 : false;
}

function noActiveTenantNotice(env, admin, config, activeKey) {
  const body = `
    <h1>${escapeHtml(config.label)}</h1>
    <p class="subtitle">${escapeHtml(config.section)} · ${escapeHtml(config.label)}</p>
    <div class="card">
      <p style="font-size:14px;">No active tenant is selected. Use the switcher at the top of the page to pick one.</p>
      <a class="btn" href="/tenants">View tenants</a>
    </div>
  `;
  return renderShell({ title: config.label, activeKey, admin, bodyHtml: body, env });
}

function capabilityDisabledNotice(env, admin, config, tenant, activeKey) {
  const body = `
    <h1>${escapeHtml(config.label)}</h1>
    <p class="subtitle">${escapeHtml(config.section)} · ${escapeHtml(config.label)}</p>
    <div class="card">
      <p style="font-size:14px;"><strong>${escapeHtml(tenant.name)}</strong> reports that it does not support this resource (its Super API capability manifest marks <span class="mono">${escapeHtml(config.label.toLowerCase())}</span> as disabled).</p>
    </div>
  `;
  return renderShell({ title: config.label, activeKey, admin, bodyHtml: body, env });
}

function errorNotice(env, admin, config, tenant, activeKey, result) {
  const body = `
    <h1>${escapeHtml(config.label)}</h1>
    <p class="subtitle">${escapeHtml(config.section)} · ${escapeHtml(config.label)} on ${escapeHtml(tenant.name)}</p>
    <div class="flash flash-error">
      <strong>${escapeHtml(String(result.status))}</strong> — ${escapeHtml(result.message || messageForStatus(result.status))}
    </div>
    <div class="card"><a class="btn btn-secondary" href="/tenants/${encodeURIComponent(tenant.id)}">View tenant</a></div>
  `;
  return renderShell({ title: config.label, activeKey, admin, bodyHtml: body, env });
}

// -----------------------------------------------------
// LIST
// -----------------------------------------------------

// -----------------------------------------------------
// Media grid — a visual thumbnail grid for the media library list,
// instead of the generic filename/URL text table every other
// resource gets. Each card shows the actual image, its dimensions,
// and folder, with edit/delete actions.
// -----------------------------------------------------

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderMediaGrid(rows, base, config) {
  const PAGE_SIZE = 24;
  const cards = rows
    .map((row, i) => {
      const id = row.id;
      const dims = row.width && row.height ? `${row.width}×${row.height}` : "";
      const meta = [dims, formatBytes(row.size)].filter(Boolean).join(" · ");
      const page = Math.floor(i / PAGE_SIZE) + 1;
      return `
        <div class="media-card" data-media-page="${page}" style="border:1px solid var(--panel-border);border-radius:10px;overflow:hidden;background:var(--panel-bg,transparent);">
          <a href="#" data-media-preview="${escapeHtml(row.url || "")}" data-media-label="${escapeHtml(row.filename || "")}" style="display:block;aspect-ratio:1/1;background:repeating-conic-gradient(#00000010 0% 25%, transparent 0% 50%) 50% / 16px 16px;">
            ${
              row.url
                ? `<img src="${escapeHtml(row.url)}" alt="${escapeHtml(row.alt_text || row.filename || "")}" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;" />`
                : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:12px;">No preview</div>`
            }
          </a>
          <div style="padding:8px 10px;">
            <div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(row.filename || "")}">${escapeHtml(row.filename || "—")}</div>
            <div style="font-size:11px;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(row.folder || "")}${row.folder && meta ? " · " : ""}${escapeHtml(meta)}</div>
            <div style="margin-top:6px;font-size:12px;display:flex;justify-content:space-between;">
              <a href="${base}/${encodeURIComponent(id)}/edit">Edit</a>
              ${
                config.supportsDelete
                  ? `<a href="#"${onClick("lummetDelete", [`${base}/${encodeURIComponent(id)}/delete`], {confirm: "Delete this media item?", prevent: true})} style="color:var(--danger);">Delete</a>`
                  : ""
              }
            </div>
          </div>
        </div>`;
    })
    .join("");

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));

  return `
    <div id="mediaGrid" style="display:grid;grid-template-columns:repeat(auto-fill, minmax(160px, 1fr));gap:14px;">${cards}</div>
    ${
      totalPages > 1
        ? `<div style="display:flex;justify-content:center;align-items:center;gap:14px;margin-top:18px;">
            <button type="button" class="btn btn-secondary btn-small" id="mediaPrevBtn">&larr; Prev</button>
            <span id="mediaPageLabel" style="font-size:13px;color:var(--text-dim);"></span>
            <button type="button" class="btn btn-secondary btn-small" id="mediaNextBtn">Next &rarr;</button>
          </div>`
        : ""
    }

    <!-- Click-to-preview lightbox: a real full-size look at the
         image, since the grid above is necessarily cropped thumbnails. -->
    <div id="mediaLightbox" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:1000;align-items:center;justify-content:center;cursor:zoom-out;">
      <img id="mediaLightboxImg" src="" alt="" style="max-width:92vw;max-height:88vh;object-fit:contain;box-shadow:0 10px 40px rgba(0,0,0,0.5);" />
      <div id="mediaLightboxLabel" style="position:absolute;bottom:20px;left:0;right:0;text-align:center;color:#fff;font-size:13px;"></div>
    </div>
    <script nonce="${nonceToken()}">
      (function() {
        const PAGE_SIZE = ${PAGE_SIZE};
        const cards = Array.from(document.querySelectorAll("[data-media-page]"));
        const totalPages = ${totalPages};
        let currentPage = 1;

        function showPage(p) {
          currentPage = Math.min(Math.max(1, p), totalPages);
          cards.forEach((c) => {
            c.style.display = Number(c.dataset.mediaPage) === currentPage ? "" : "none";
          });
          const label = document.getElementById("mediaPageLabel");
          if (label) label.textContent = "Page " + currentPage + " of " + totalPages;
          const prevBtn = document.getElementById("mediaPrevBtn");
          const nextBtn = document.getElementById("mediaNextBtn");
          if (prevBtn) prevBtn.disabled = currentPage <= 1;
          if (nextBtn) nextBtn.disabled = currentPage >= totalPages;
        }

        document.getElementById("mediaPrevBtn")?.addEventListener("click", () => showPage(currentPage - 1));
        document.getElementById("mediaNextBtn")?.addEventListener("click", () => showPage(currentPage + 1));
        showPage(1);

        const lightbox = document.getElementById("mediaLightbox");
        const lightboxImg = document.getElementById("mediaLightboxImg");
        const lightboxLabel = document.getElementById("mediaLightboxLabel");
        document.getElementById("mediaGrid")?.addEventListener("click", (e) => {
          const trigger = e.target.closest("[data-media-preview]");
          if (!trigger) return;
          e.preventDefault();
          const url = trigger.dataset.mediaPreview;
          if (!url) return;
          lightboxImg.src = url;
          lightboxLabel.textContent = trigger.dataset.mediaLabel || "";
          lightbox.style.display = "flex";
        });
        lightbox?.addEventListener("click", () => { lightbox.style.display = "none"; lightboxImg.src = ""; });
      })();
    </script>`;
}

export async function renderResourceList(env, admin, resourceKey, config, flash, searchParams) {
  const activeKey = nav(resourceKey, config);
  const { tenant } = await resolveActiveTenant(env, admin);

  if (!tenant) return noActiveTenantNotice(env, admin, config, activeKey);

  if (await isCapabilityDisabled(env, tenant.id, resourceKey)) {
    return capabilityDisabledNotice(env, admin, config, tenant, activeKey);
  }

  const selectedFolder = resourceKey === "media" ? (searchParams?.get("folder") || "") : "";
  const listPath = selectedFolder
    ? `${BASE_PATH}/${resourceKey}?folder=${encodeURIComponent(selectedFolder)}`
    : `${BASE_PATH}/${resourceKey}`;

  const result = await getFromTenant(env, tenant, listPath);
  if (!result.ok) return errorNotice(env, admin, config, tenant, activeKey, result);

  const rows = result.data.data || [];
  const base = basePagePath(resourceKey, config);

  let folderPickerHtml = "";
  if (resourceKey === "media") {
    const foldersResult = await getFromTenant(env, tenant, `${BASE_PATH}/media/folders`);
    const folders = foldersResult.ok ? foldersResult.data.data || [] : [];
    folderPickerHtml = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;">
        <label for="folderFilter" style="margin:0;font-size:13px;color:var(--text-dim);">Folder</label>
        <select id="folderFilter" style="width:auto;margin:0;" ${onChange("lummetFilterFolder", ["$value", base])}>
          <option value="">All folders</option>
          ${folders.map((f) => `<option value="${escapeHtml(f)}" ${f === selectedFolder ? "selected" : ""}>${escapeHtml(f)}</option>`).join("")}
        </select>
      </div>`;
  }

  const flashHtml = flash
    ? `<div class="flash ${flash.type === "error" ? "flash-error" : "flash-success"}">${escapeHtml(flash.message)}</div>`
    : "";

  const body = `
    <h1>${escapeHtml(config.label)}</h1>
    <p class="subtitle">${escapeHtml(config.section)} · ${escapeHtml(config.label)} on <strong>${escapeHtml(tenant.name)}</strong></p>
    ${flashHtml}
    <div class="card">
      ${
        config.supportsCreate
          ? `<div style="display:flex;justify-content:flex-end;margin-bottom:14px;"><a class="btn" href="${base}/new">New</a></div>`
          : resourceKey === "media"
            ? `<div style="display:flex;justify-content:flex-end;margin-bottom:14px;"><a class="btn" href="${base}/new">Upload / Add</a></div>`
            : ""
      }
      ${folderPickerHtml}
      ${
        rows.length === 0
          ? `<div class="empty">Nothing here yet.</div>`
          : resourceKey === "media"
            ? renderMediaGrid(rows, base, config)
            : `<table>
              <thead><tr>${config.listColumns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("")}<th></th></tr></thead>
              <tbody>
                ${rows
                  .map((row) => {
                    const id = row[config.idField];
                    return `<tr>
                      ${config.listColumns
                        .map((c) => {
                          if (c.toggle) {
                            const isOn = !!row[c.key];
                            return `<td>
                              <button type="button" class="badge badge-toggle-btn ${isOn ? "badge-ok" : "badge-dim"}"
                               ${onClick("lummetToggleField", [`${base}/${encodeURIComponent(id)}/toggle-field`, c.key, "$el"])}>
                                ${escapeHtml(isOn ? c.toggle.onLabel : c.toggle.offLabel)}
                              </button>
                            </td>`;
                          }
                          return `<td>${formatCell(row[c.key], c.type)}</td>`;
                        })
                        .join("")}
                      <td>
                        <a href="${base}/${encodeURIComponent(id)}/edit">${config.roleOnly ? "Edit role" : "Edit"}</a>
                        ${resourceKey === "users" ? ` &nbsp;·&nbsp; <a href="/system/users/${encodeURIComponent(id)}/item-access">Item access</a>` : ""}
                        ${
                          config.supportsDelete
                            ? ` &nbsp;·&nbsp; <a href="#"${onClick("lummetDelete", [`${base}/${encodeURIComponent(id)}/delete`], {confirm: `Delete this ${config.label.toLowerCase().replace(/s$/, "")}?`, prevent: true})}>Delete</a>`
                            : ""
                        }
                      </td>
                    </tr>`;
                  })
                  .join("")}
              </tbody>
            </table>`
      }
    </div>

    <script nonce="${nonceToken()}">
      function lummetFilterFolder(value, base) { location.href = value ? base + '?folder=' + encodeURIComponent(value) : base; }
      function lummetDelete(path) {
        fetch(path, { method: 'POST' })
          .then(r => r.json())
          .then(data => {
            if (data.success) location.reload();
            else alert('Delete failed: ' + (data.error || 'unknown error'));
          })
          .catch(() => alert('Delete failed.'));
      }

      function lummetToggleField(path, field, btn) {
        btn.disabled = true;
        fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field })
        })
          .then(r => r.json())
          .then(data => {
            if (data.success) location.reload();
            else { alert('Could not update: ' + (data.error || 'unknown error')); btn.disabled = false; }
          })
          .catch(() => { alert('Network error.'); btn.disabled = false; });
      }
    </script>
  `;

  return renderShell({ title: config.label, activeKey, admin, bodyHtml: body, env });
}

// -----------------------------------------------------
// CREATE / EDIT FORM
// -----------------------------------------------------

// Some tenant GET endpoints return array-shaped columns (reviews.pros/
// cons, casinos.features) as the raw JSON-encoded TEXT string straight
// out of D1 (`SELECT *` doesn't parse it), rather than as a real JS
// array. When that happens `Array.isArray` is false and the field
// would render blank even though the record has data — silently
// wiping it out on next save. Handle both shapes defensively.
function toListDisplayValue(rawStoredValue) {
  if (Array.isArray(rawStoredValue)) return rawStoredValue.join("\n");
  if (typeof rawStoredValue === "string" && rawStoredValue) {
    try {
      const parsed = JSON.parse(rawStoredValue);
      if (Array.isArray(parsed)) return parsed.join("\n");
    } catch {
      // not JSON — fall through to blank
    }
  }
  return "";
}

function renderField(field, record, fieldOptions) {
  const rawStoredValue = record ? record[field.name] : null;
  const value = record ? record[field.name] : "";
  const disabled = field.lockOnEdit && record ? "disabled" : "";
  const hiddenForLocked = field.lockOnEdit && record
    ? `<input type="hidden" name="${escapeHtml(field.name)}" value="${escapeHtml(value)}" />`
    : "";

  if (field.type === "list") {
    // Stored as a real array (e.g. reviews.pros, casinos.features).
    // Displayed one item per line, matching the tenant's own admin
    // UI exactly (en/static/js/admin.js splits/joins on "\n").
    const displayValue = toListDisplayValue(rawStoredValue);
    return `
      <label for="${field.name}">${escapeHtml(field.label)}${field.hint ? ` <span style="color:var(--text-dim);font-weight:400;">— ${escapeHtml(field.hint)}</span>` : ""}</label>
      <textarea id="${field.name}" name="${field.name}" rows="4" placeholder="One per line">${escapeHtml(displayValue)}</textarea>`;
  }

  if (field.type === "multi_select") {
    return renderMultiSelectField(field, rawStoredValue, (fieldOptions && fieldOptions[field.optionsResource]) || []);
  }

  if (field.type === "geo_rules") {
    return renderGeoRulesField(field, rawStoredValue, (fieldOptions && fieldOptions[field.optionsResource]) || []);
  }

  if (field.type === "geo_destinations") {
    return renderGeoDestinationsField(field, rawStoredValue, (fieldOptions && fieldOptions[field.optionsResource]) || []);
  }

  if (field.type === "resource_select") {
    return renderResourceSelectField(field, rawStoredValue, (fieldOptions && fieldOptions[field.optionsResource]) || []);
  }

  if (field.type === "content_json_rich") {
    return renderPageContentField(field, rawStoredValue);
  }

  if (field.type === "json_object") {
    // Stored as a real object/array (e.g. pages.content_json) — the
    // DB layer JSON.stringify()s it itself, so we pretty-print for
    // editing and parse back before sending (see coerceFieldValue).
    const displayValue =
      rawStoredValue && typeof rawStoredValue === "object"
        ? JSON.stringify(rawStoredValue, null, 2)
        : typeof rawStoredValue === "string" && rawStoredValue
          ? rawStoredValue
          : "";
    return `
      <label for="${field.name}">${escapeHtml(field.label)} <span style="color:var(--text-dim);font-weight:400;">— JSON</span></label>
      <textarea id="${field.name}" name="${field.name}" rows="8" class="mono" data-json-field="1">${escapeHtml(displayValue)}</textarea>
      <div class="json-error" style="display:none;color:var(--danger);font-size:12px;margin:-10px 0 14px;"></div>`;
  }

  if (field.type === "json_raw") {
    // Stored AS the raw JSON string itself (e.g. reviews.faq_json) —
    // the DB layer does not re-encode it, so what's typed here is
    // sent verbatim (only validated for parseability).
    const displayValue = typeof rawStoredValue === "string" ? rawStoredValue : "[]";
    return `
      <label for="${field.name}">${escapeHtml(field.label)} <span style="color:var(--text-dim);font-weight:400;">— JSON</span></label>
      <textarea id="${field.name}" name="${field.name}" rows="6" class="mono" data-json-field="1">${escapeHtml(displayValue)}</textarea>
      <div class="json-error" style="display:none;color:var(--danger);font-size:12px;margin:-10px 0 14px;"></div>`;
  }

  if (field.type === "richtext") {
    const html = typeof rawStoredValue === "string" ? rawStoredValue : "";
    return renderRichTextField(field, html);
  }

  if (field.type === "media") {
    return renderMediaPickerField(field, rawStoredValue);
  }

  if (field.type === "textarea") {
    return `
      <label for="${field.name}">${escapeHtml(field.label)}</label>
      <textarea id="${field.name}" name="${field.name}" rows="4" ${field.required ? "required" : ""}>${escapeHtml(value)}</textarea>`;
  }

  if (field.type === "checkbox") {
    const checked = value === 1 || value === true || value === "1" ? "checked" : "";
    return `
      <label style="display:flex;align-items:center;gap:8px;">
        <input type="checkbox" id="${field.name}" name="${field.name}" value="1" style="width:auto;margin:0;" ${checked} />
        ${escapeHtml(field.label)}
      </label>`;
  }

  if (field.type === "select") {
    // options can be a flat array of strings (value === label), or an
    // array of {value, label} pairs when the stored value and the
    // human-readable label need to differ (e.g. nav location codes
    // like "footer_casinos" displayed as "Footer — Casinos", matching
    // the tenant's own admin dropdown exactly). Existing plain-string
    // configs keep working unchanged.
    const options = (field.options || [])
      .map((opt) => {
        const optValue = typeof opt === "object" ? String(opt.value) : String(opt);
        const optLabel = typeof opt === "object" ? opt.label : opt;
        return `<option value="${escapeHtml(optValue)}" ${value === optValue ? "selected" : ""}>${escapeHtml(optLabel)}</option>`;
      })
      .join("");
    return `
      <label for="${field.name}">${escapeHtml(field.label)}${field.hint ? ` <span style="color:var(--text-dim);font-weight:400;">— ${escapeHtml(field.hint)}</span>` : ""}</label>
      <select id="${field.name}" name="${field.name}">${options}</select>`;
  }

  return `
    <label for="${field.name}">${escapeHtml(field.label)}</label>
    ${hiddenForLocked}
    <input type="${field.type === "number" ? "number" : "text"}" ${field.step ? `step="${field.step}"` : ""}
      id="${field.name}" name="${field.name}" value="${escapeHtml(value)}"
      ${field.required ? "required" : ""} ${disabled} />`;
}

// -----------------------------------------------------
// Page content — pages.content_json is stored as a JSON-encoded
// TEXT column, but the tenant's own admin (en/static/js/admin.js)
// treats it as effectively plain text/HTML: if what's typed isn't
// valid JSON, it's wrapped as { text: <what was typed> } before
// saving (see parseContentJson on the tenant, which then unwraps
// {text}/{html}/plain-string shapes back out for rendering). So for
// the common case, editing this field should just be the same rich
// text editor reviews/news content gets — no JSON in sight.
//
// The one thing this must not do is silently mangle a page that
// already has genuine multi-key structured content (a real little
// JSON object beyond {text} or {html}) — those fall back to the raw
// JSON editor so nothing is destroyed.
// -----------------------------------------------------

function parsePageContentForEdit(rawStoredValue) {
  let obj = null;
  if (rawStoredValue && typeof rawStoredValue === "object") {
    obj = rawStoredValue;
  } else if (typeof rawStoredValue === "string" && rawStoredValue.trim()) {
    try {
      obj = JSON.parse(rawStoredValue);
    } catch {
      // Not JSON at all — treat the raw string itself as the HTML/text.
      return { html: rawStoredValue, complex: false };
    }
  }
  if (obj == null) return { html: "", complex: false };
  if (typeof obj === "string") return { html: obj, complex: false };
  if (typeof obj !== "object") return { html: "", complex: false };
  const keys = Object.keys(obj);
  if (keys.length === 0) return { html: "", complex: false };
  if (keys.length === 1 && keys[0] === "text") return { html: obj.text || "", complex: false };
  if (keys.length === 1 && keys[0] === "html") return { html: obj.html || "", complex: false };
  return { html: "", complex: true, raw: JSON.stringify(obj, null, 2) };
}

function renderPageContentField(field, rawStoredValue) {
  const parsed = parsePageContentForEdit(rawStoredValue);

  if (parsed.complex) {
    return `
      <label for="${field.name}">${escapeHtml(field.label)} <span style="color:var(--text-dim);font-weight:400;">— this page has custom structured content beyond plain text/HTML, so it's shown as raw JSON here to avoid losing anything</span></label>
      <textarea id="${field.name}" name="${field.name}" rows="10" class="mono" data-json-field="1">${escapeHtml(parsed.raw)}</textarea>
      <div class="json-error" style="display:none;color:var(--danger);font-size:12px;margin:-10px 0 14px;"></div>
      <input type="hidden" name="${field.name}__mode" value="json" />`;
  }

  return renderRichTextField(field, parsed.html) + `<input type="hidden" name="${field.name}__mode" value="richtext" />`;
}

// -----------------------------------------------------
// Rich text editor — a minimal, self-contained contenteditable
// editor with no external/CDN dependency. Its output is a plain
// HTML string synced into a hidden textarea on every input, which
// is what actually gets submitted — matching what the tenant's own
// `content` columns store (see en/static/js/admin.js: `content:
// formData.get("content") || ""`, sent as raw HTML, never escaped
// or JSON-encoded).
// -----------------------------------------------------

let richTextInstanceCounter = 0;

export function renderRichTextField(field, html) {
  const instanceId = `rte_${field.name}_${richTextInstanceCounter++}`;
  return `
    <label for="${instanceId}_editor">${escapeHtml(field.label)}</label>
    <div class="rte-toolbar" id="${instanceId}_toolbar">
      <button type="button" data-cmd="bold" title="Bold"><b>B</b></button>
      <button type="button" data-cmd="italic" title="Italic"><i>I</i></button>
      <button type="button" data-cmd="formatBlock" data-arg="H2" title="Heading 2">H2</button>
      <button type="button" data-cmd="formatBlock" data-arg="H3" title="Heading 3">H3</button>
      <button type="button" data-cmd="formatBlock" data-arg="P" title="Paragraph">¶</button>
      <button type="button" data-cmd="insertUnorderedList" title="Bullet list">• List</button>
      <button type="button" data-cmd="insertOrderedList" title="Numbered list">1. List</button>
      <button type="button" data-cmd="formatBlock" data-arg="BLOCKQUOTE" title="Quote">"</button>
      <button type="button" data-cmd="createLink" data-prompt="1" title="Link">Link</button>
      <button type="button" data-cmd="unlink" title="Remove link">Unlink</button>
      <button type="button" data-toggle-source="1" title="Toggle HTML source">&lt;/&gt;</button>
    </div>
    <div class="rte-editor" id="${instanceId}_editor" contenteditable="true">${html}</div>
    <textarea id="${instanceId}_source" style="display:none;font-family:monospace;" rows="10">${escapeHtml(html)}</textarea>
    <textarea name="${field.name}" id="${instanceId}_hidden" style="display:none;">${escapeHtml(html)}</textarea>
    <script nonce="${nonceToken()}">
      (function() {
        const editor = document.getElementById("${instanceId}_editor");
        const hidden = document.getElementById("${instanceId}_hidden");
        const source = document.getElementById("${instanceId}_source");
        const toolbar = document.getElementById("${instanceId}_toolbar");
        let sourceMode = false;

        function sync() {
          hidden.value = sourceMode ? source.value : editor.innerHTML;
        }

        editor.addEventListener("input", sync);
        source.addEventListener("input", sync);

        toolbar.addEventListener("click", (e) => {
          const btn = e.target.closest("button");
          if (!btn) return;
          e.preventDefault();

          if (btn.dataset.toggleSource) {
            sourceMode = !sourceMode;
            if (sourceMode) {
              source.value = editor.innerHTML;
              editor.style.display = "none";
              source.style.display = "block";
            } else {
              editor.innerHTML = source.value;
              editor.style.display = "block";
              source.style.display = "none";
            }
            sync();
            return;
          }

          editor.focus();
          const cmd = btn.dataset.cmd;
          let arg = btn.dataset.arg || null;
          if (btn.dataset.prompt) {
            arg = prompt("Link URL:");
            if (!arg) return;
          }
          document.execCommand(cmd, false, arg);
          sync();
        });

        // Keep the hidden field in sync right before the form submits,
        // in case the last edit didn't fire an input event.
        editor.closest("form")?.addEventListener("submit", sync);
      })();
    </script>`;
}

// -----------------------------------------------------
// Media picker — a numeric media-library id field (e.g.
// casinos.logo_media_id, news.featured_image) with a thumbnail
// preview and a picker that lists the active tenant's real media
// library, fetched through this control plane's own authenticated
// session (never exposing tenant credentials to the browser).
// -----------------------------------------------------

let mediaPickerInstanceCounter = 0;

function renderMediaPickerField(field, currentId) {
  const instanceId = `media_${field.name}_${mediaPickerInstanceCounter++}`;
  const idValue = currentId != null && currentId !== "" ? currentId : "";

  return `
    <label>${escapeHtml(field.label)}</label>
    <div class="media-field" id="${instanceId}">
      <div class="media-preview" id="${instanceId}_preview">
        ${idValue ? `<span style="color:var(--text-dim);font-size:12px;">Media #${escapeHtml(idValue)} selected</span>` : `<span style="color:var(--text-dim);font-size:12px;">No image selected</span>`}
      </div>
      <input type="hidden" name="${field.name}" id="${instanceId}_input" value="${escapeHtml(idValue)}" />
      <div class="actions" style="margin-bottom:14px;">
        <button type="button" class="btn btn-secondary btn-small"${onClick("lummetOpenMediaPicker", [instanceId])}>Choose image</button>
        ${idValue ? `<button type="button" class="btn btn-secondary btn-small"${onClick("lummetClearMedia", [instanceId])}>Remove</button>` : ""}
      </div>
      <div class="media-picker-panel" id="${instanceId}_panel" style="display:none;border:1px solid var(--panel-border);border-radius:8px;padding:12px;margin-bottom:14px;max-height:300px;overflow-y:auto;"></div>
    </div>
    <script nonce="${nonceToken()}">
      ${BROWSER_HELPER}
      window.lummetMediaCache = window.lummetMediaCache || null;

      window.lummetOpenMediaPicker = async function(instanceId) {
        const panel = document.getElementById(instanceId + "_panel");
        const isOpen = panel.style.display !== "none";
        if (isOpen) { panel.style.display = "none"; return; }

        panel.style.display = "block";
        panel.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">Loading…</div>';

        try {
          if (!window.lummetMediaCache) {
            const res = await fetch("/api/media-picker");
            const data = await res.json();
            window.lummetMediaCache = data.success ? data.data : [];
          }
          const items = window.lummetMediaCache || [];
          if (items.length === 0) {
            panel.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">No media found on this tenant.</div>';
            return;
          }
          panel.innerHTML = items.map(function(item) {
            const thumb = item.thumbnail_url || item.url;
            return '<div style="display:inline-block;width:80px;margin:4px;cursor:pointer;text-align:center;" ' +
              lummetAttrs('click', 'lummetSelectMedia', [instanceId, item.id, item.filename || '']) + '>' +
              '<img src="' + lummetEscAttr(thumb) + '" style="width:72px;height:72px;object-fit:cover;border-radius:6px;border:1px solid var(--panel-border);" loading="lazy" />' +
              '<div style="font-size:10px;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">#' + item.id + '</div>' +
              '</div>';
          }).join("");
        } catch (err) {
          panel.innerHTML = '<div style="color:var(--danger);font-size:13px;">Could not load media.</div>';
        }
      };

      window.lummetSelectMedia = function(instanceId, id, filename) {
        document.getElementById(instanceId + "_input").value = id;
        document.getElementById(instanceId + "_preview").innerHTML =
          '<span style="color:var(--text-dim);font-size:12px;">Media #' + id + (filename ? ' — ' + filename : '') + ' selected</span>';
        document.getElementById(instanceId + "_panel").style.display = "none";
      };

      window.lummetClearMedia = function(instanceId) {
        document.getElementById(instanceId + "_input").value = "";
        document.getElementById(instanceId + "_preview").innerHTML =
          '<span style="color:var(--text-dim);font-size:12px;">No image selected</span>';
      };
    </script>`;
}

// -----------------------------------------------------
// Resource select — a single-value dropdown sourced from another
// resource (e.g. reviews/news/pages.author_id -> authors,
// blocks.component_id -> components). Replaces having to know and
// type a raw numeric id by hand.
// -----------------------------------------------------

export function renderResourceSelectField(field, currentValue, options) {
  const current = currentValue == null ? "" : String(currentValue);
  const optionsHtml = options
    .map((opt) => {
      const optValue = String(opt[field.optionValueKey]);
      const optLabel = String(opt[field.optionLabelKey] ?? optValue);
      return `<option value="${escapeHtml(optValue)}" ${current === optValue ? "selected" : ""}>${escapeHtml(optLabel)}</option>`;
    })
    .join("");
  return `
    <label for="${field.name}">${escapeHtml(field.label)}${field.hint ? ` <span style="color:var(--text-dim);font-weight:400;">— ${escapeHtml(field.hint)}</span>` : ""}</label>
    <select id="${field.name}" name="${field.name}" ${field.required ? "required" : ""}>
      <option value="">${field.required ? "Select…" : "— none —"}</option>
      ${optionsHtml}
    </select>`;
}

// -----------------------------------------------------
// Multi-select — checkbox group for a field whose value is an array
// of ids referencing another resource (e.g. casinos.category_ids ->
// categories). Checkboxes can't share a `name` and survive this
// control plane's parseForm (which keeps only the last value per
// key — see index.js), so selections are tracked in a hidden JSON
// input instead, same pattern as the media picker.
// -----------------------------------------------------

let multiSelectInstanceCounter = 0;

export function renderMultiSelectField(field, rawStoredValue, options) {
  const instanceId = `ms_${field.name}_${multiSelectInstanceCounter++}`;
  const selected = new Set(
    (Array.isArray(rawStoredValue) ? rawStoredValue : []).map((v) => String(v))
  );

  const optionsHtml = options
    .map((opt) => {
      const optValue = String(opt[field.optionValueKey]);
      const optLabel = String(opt[field.optionLabelKey]);
      const checked = selected.has(optValue) ? "checked" : "";
      return `
        <label style="display:inline-flex;align-items:center;gap:6px;border:1px solid var(--panel-border);padding:4px 10px;border-radius:16px;font-weight:400;font-size:13px;margin:0 6px 6px 0;">
          <input type="checkbox" data-ms-option value="${escapeHtml(optValue)}" style="width:auto;margin:0;" ${checked} />
          ${escapeHtml(optLabel)}
        </label>`;
    })
    .join("");

  return `
    <label>${escapeHtml(field.label)}${field.hint ? ` <span style="color:var(--text-dim);font-weight:400;">— ${escapeHtml(field.hint)}</span>` : ""}</label>
    <div class="multi-select-field" id="${instanceId}" style="margin-bottom:14px;">
      ${options.length ? `<div style="display:flex;flex-wrap:wrap;">${optionsHtml}</div>` : `<div style="color:var(--text-dim);font-size:13px;">None available.</div>`}
      <input type="hidden" name="${field.name}" id="${instanceId}_input" value='${escapeHtml(JSON.stringify([...selected]))}' />
    </div>
    <script nonce="${nonceToken()}">
      (function() {
        const root = document.getElementById("${instanceId}");
        const hidden = document.getElementById("${instanceId}_input");
        function sync() {
          const checked = Array.from(root.querySelectorAll("[data-ms-option]:checked")).map(function(c) { return c.value; });
          hidden.value = JSON.stringify(checked);
        }
        root.querySelectorAll("[data-ms-option]").forEach(function(c) { c.addEventListener("change", sync); });
        root.closest("form")?.addEventListener("submit", sync);
      })();
    </script>`;
}

// -----------------------------------------------------
// Geo rules — per-country allow/block editor for a field whose value
// is an array of { country_code, status, bonus_override } (e.g.
// casinos.geo_rules). Rows are built/removed directly in the DOM;
// a hidden JSON input mirrors current row state on every change and
// right before submit, same sync-on-submit pattern as the rich text
// editor.
// -----------------------------------------------------

let geoRulesInstanceCounter = 0;
let geoDestinationsInstanceCounter = 0;

function geoRuleRowHtml(instanceId, code, label, status, bonusOverride) {
  const safeCode = escapeHtml(code);
  return `
    <tr data-geo-row data-country="${safeCode}">
      <td style="padding:6px 8px;">${escapeHtml(label)} <span class="mono" style="color:var(--text-dim);">(${safeCode})</span></td>
      <td style="padding:6px 8px;">
        <select data-geo-status style="width:auto;">
          <option value="allowed" ${status === "allowed" ? "selected" : ""}>Allowed</option>
          <option value="blocked" ${status === "blocked" ? "selected" : ""}>Blocked</option>
        </select>
      </td>
      <td style="padding:6px 8px;"><input type="text" data-geo-bonus value="${escapeHtml(bonusOverride || "")}" placeholder="optional" style="width:100%;margin:0;" /></td>
      <td style="padding:6px 8px;"><button type="button" class="btn btn-secondary btn-small" data-geo-remove>✕</button></td>
    </tr>`;
}

function renderGeoRulesField(field, rawStoredValue, countries) {
  const instanceId = `geo_${field.name}_${geoRulesInstanceCounter++}`;
  const rules = Array.isArray(rawStoredValue) ? rawStoredValue : [];
  const labelByCode = {};
  for (const c of countries) labelByCode[c[field.optionValueKey]] = c[field.optionLabelKey];

  const rowsHtml = rules
    .map((r) => geoRuleRowHtml(instanceId, r.country_code, labelByCode[r.country_code] || r.country_code, r.status, r.bonus_override))
    .join("");

  const countryOptionsHtml = countries
    .map((c) => `<option value="${escapeHtml(c[field.optionValueKey])}" data-label="${escapeHtml(c[field.optionLabelKey])}">${escapeHtml(c[field.optionLabelKey])} (${escapeHtml(c[field.optionValueKey])})</option>`)
    .join("");

  return `
    <label>${escapeHtml(field.label)}${field.hint ? ` <span style="color:var(--text-dim);font-weight:400;">— ${escapeHtml(field.hint)}</span>` : ""}</label>
    <div class="geo-rules-field" id="${instanceId}" style="margin-bottom:14px;">
      <table style="width:100%;border-collapse:collapse;margin-bottom:10px;" id="${instanceId}_table">
        <thead><tr style="text-align:left;font-size:12px;color:var(--text-dim);"><th style="padding:6px 8px;">Country</th><th style="padding:6px 8px;">Status</th><th style="padding:6px 8px;">Bonus override</th><th></th></tr></thead>
        <tbody id="${instanceId}_rows">${rowsHtml}</tbody>
      </table>
      ${countries.length ? `
      <div style="display:flex;gap:8px;align-items:center;">
        <select id="${instanceId}_add_country" style="flex:1;">
          <option value="">Add a country…</option>
          ${countryOptionsHtml}
        </select>
        <button type="button" class="btn btn-secondary btn-small" id="${instanceId}_add_btn">Add</button>
      </div>` : `<div style="color:var(--text-dim);font-size:13px;">No countries configured yet.</div>`}
      <input type="hidden" name="${field.name}" id="${instanceId}_input" />
    </div>
    <script nonce="${nonceToken()}">
      (function() {
        const tbody = document.getElementById("${instanceId}_rows");
        const hidden = document.getElementById("${instanceId}_input");
        const addSelect = document.getElementById("${instanceId}_add_country");
        const addBtn = document.getElementById("${instanceId}_add_btn");

        function sync() {
          const rows = Array.from(tbody.querySelectorAll("[data-geo-row]"));
          const rules = rows.map(function(tr) {
            return {
              country_code: tr.getAttribute("data-country"),
              status: tr.querySelector("[data-geo-status]").value,
              bonus_override: tr.querySelector("[data-geo-bonus]").value || null
            };
          });
          hidden.value = JSON.stringify(rules);
        }

        tbody.addEventListener("change", sync);
        tbody.addEventListener("input", sync);
        tbody.addEventListener("click", function(e) {
          if (e.target.closest("[data-geo-remove]")) {
            e.target.closest("tr").remove();
            sync();
          }
        });

        if (addBtn) {
          addBtn.addEventListener("click", function() {
            const code = addSelect.value;
            if (!code) return;
            if (tbody.querySelector('[data-country="' + code + '"]')) { addSelect.value = ""; return; }
            const opt = addSelect.options[addSelect.selectedIndex];
            const label = opt.getAttribute("data-label") || code;
            const tr = document.createElement("tr");
            tr.setAttribute("data-geo-row", "1");
            tr.setAttribute("data-country", code);
            tr.innerHTML =
              '<td style="padding:6px 8px;">' + label + ' <span class="mono" style="color:var(--text-dim);">(' + code + ')</span></td>' +
              '<td style="padding:6px 8px;"><select data-geo-status style="width:auto;"><option value="allowed">Allowed</option><option value="blocked">Blocked</option></select></td>' +
              '<td style="padding:6px 8px;"><input type="text" data-geo-bonus placeholder="optional" style="width:100%;margin:0;" /></td>' +
              '<td style="padding:6px 8px;"><button type="button" class="btn btn-secondary btn-small" data-geo-remove>✕</button></td>';
            tbody.appendChild(tr);
            addSelect.value = "";
            sync();
          });
        }

        sync();
        tbody.closest("form")?.addEventListener("submit", sync);
      })();
    </script>`;
}

// Sibling of renderGeoRulesField()/geoRuleRowHtml() above, for
// tracking_links.geo_destinations (tracking_link_geo_destinations on
// the tenant side) -- a simpler two-column shape (country + override
// URL only, no status/bonus_override) since blocking is already
// handled by the plain allowed_geos/blocked_geos list fields on this
// same resource. See worker/database/tracking-links.js's
// setGeoDestinations() on the tenant for the exact shape expected.
function geoDestinationRowHtml(instanceId, code, label, destinationUrl) {
  const safeCode = escapeHtml(code);
  return `
    <tr data-geodest-row data-country="${safeCode}">
      <td style="padding:6px 8px;">${escapeHtml(label)} <span class="mono" style="color:var(--text-dim);">(${safeCode})</span></td>
      <td style="padding:6px 8px;"><input type="text" data-geodest-url value="${escapeHtml(destinationUrl || "")}" placeholder="https://..." style="width:100%;margin:0;" /></td>
      <td style="padding:6px 8px;"><button type="button" class="btn btn-secondary btn-small" data-geodest-remove>✕</button></td>
    </tr>`;
}

function renderGeoDestinationsField(field, rawStoredValue, countries) {
  const instanceId = `geodest_${field.name}_${geoDestinationsInstanceCounter++}`;
  const destinations = Array.isArray(rawStoredValue) ? rawStoredValue : [];
  const labelByCode = {};
  for (const c of countries) labelByCode[c[field.optionValueKey]] = c[field.optionLabelKey];

  const rowsHtml = destinations
    .map((d) => geoDestinationRowHtml(instanceId, d.country_code, labelByCode[d.country_code] || d.country_code, d.destination_url))
    .join("");

  const countryOptionsHtml = countries
    .map((c) => `<option value="${escapeHtml(c[field.optionValueKey])}" data-label="${escapeHtml(c[field.optionLabelKey])}">${escapeHtml(c[field.optionLabelKey])} (${escapeHtml(c[field.optionValueKey])})</option>`)
    .join("");

  return `
    <label>${escapeHtml(field.label)}${field.hint ? ` <span style="color:var(--text-dim);font-weight:400;">— ${escapeHtml(field.hint)}</span>` : ""}</label>
    <div class="geo-destinations-field" id="${instanceId}" style="margin-bottom:14px;">
      <table style="width:100%;border-collapse:collapse;margin-bottom:10px;" id="${instanceId}_table">
        <thead><tr style="text-align:left;font-size:12px;color:var(--text-dim);"><th style="padding:6px 8px;">Country</th><th style="padding:6px 8px;">Override destination URL</th><th></th></tr></thead>
        <tbody id="${instanceId}_rows">${rowsHtml}</tbody>
      </table>
      ${countries.length ? `
      <div style="display:flex;gap:8px;align-items:center;">
        <select id="${instanceId}_add_country" style="flex:1;">
          <option value="">Add a country…</option>
          ${countryOptionsHtml}
        </select>
        <button type="button" class="btn btn-secondary btn-small" id="${instanceId}_add_btn">Add</button>
      </div>` : `<div style="color:var(--text-dim);font-size:13px;">No countries configured yet.</div>`}
      <input type="hidden" name="${field.name}" id="${instanceId}_input" />
    </div>
    <script nonce="${nonceToken()}">
      (function() {
        const tbody = document.getElementById("${instanceId}_rows");
        const hidden = document.getElementById("${instanceId}_input");
        const addSelect = document.getElementById("${instanceId}_add_country");
        const addBtn = document.getElementById("${instanceId}_add_btn");

        function sync() {
          const rows = Array.from(tbody.querySelectorAll("[data-geodest-row]"));
          const destinations = rows.map(function(tr) {
            return {
              country_code: tr.getAttribute("data-country"),
              destination_url: tr.querySelector("[data-geodest-url]").value
            };
          }).filter(function(d) { return d.destination_url; }); // drop rows left blank rather than send an unusable override
          hidden.value = JSON.stringify(destinations);
        }

        tbody.addEventListener("change", sync);
        tbody.addEventListener("input", sync);
        tbody.addEventListener("click", function(e) {
          if (e.target.closest("[data-geodest-remove]")) {
            e.target.closest("tr").remove();
            sync();
          }
        });

        if (addBtn) {
          addBtn.addEventListener("click", function() {
            const code = addSelect.value;
            if (!code) return;
            if (tbody.querySelector('[data-country="' + code + '"]')) { addSelect.value = ""; return; }
            const opt = addSelect.options[addSelect.selectedIndex];
            const label = opt.getAttribute("data-label") || code;
            const tr = document.createElement("tr");
            tr.setAttribute("data-geodest-row", "1");
            tr.setAttribute("data-country", code);
            tr.innerHTML =
              '<td style="padding:6px 8px;">' + label + ' <span class="mono" style="color:var(--text-dim);">(' + code + ')</span></td>' +
              '<td style="padding:6px 8px;"><input type="text" data-geodest-url placeholder="https://..." style="width:100%;margin:0;" /></td>' +
              '<td style="padding:6px 8px;"><button type="button" class="btn btn-secondary btn-small" data-geodest-remove>✕</button></td>';
            tbody.appendChild(tr);
            addSelect.value = "";
            sync();
          });
        }

        sync();
        tbody.closest("form")?.addEventListener("submit", sync);
      })();
    </script>`;
}

export async function renderResourceForm(env, admin, resourceKey, config, id, formError) {
  const activeKey = nav(resourceKey, config);
  const { tenant } = await resolveActiveTenant(env, admin);

  if (!tenant) return noActiveTenantNotice(env, admin, config, activeKey);

  let record = null;
  if (id) {
    const result = await getFromTenant(env, tenant, `${BASE_PATH}/${resourceKey}/${encodeURIComponent(id)}`);
    if (!result.ok) return errorNotice(env, admin, config, tenant, activeKey, result);
    record = result.data.data;
  }

  const base = basePagePath(resourceKey, config);
  const isEdit = !!id;
  const flashHtml = formError ? `<div class="flash flash-error">${escapeHtml(formError)}</div>` : "";

  // Some field types (multi_select, geo_rules) present choices drawn
  // from another resource on this same tenant (e.g. casinos.category_ids
  // picks from the categories list). Fetch each distinct optionsResource
  // referenced by this config's fields once, up front.
  const optionResourceKeys = [...new Set(config.fields.filter((f) => f.optionsResource).map((f) => f.optionsResource))];
  const fieldOptions = {};
  // Each is a network call to the tenant's Super API, so they run together rather than one after another.
  const optResults = await Promise.all(optionResourceKeys.map((key) => getFromTenant(env, tenant, `${BASE_PATH}/${key}`)));
  optionResourceKeys.forEach((key, i) => {
    const optResult = optResults[i];
    fieldOptions[key] = optResult.ok ? (optResult.data.data || []) : [];
  });

  const body = `
    <h1>${isEdit ? `Edit ${escapeHtml(config.label.replace(/s$/, ""))}` : `New ${escapeHtml(config.label.replace(/s$/, ""))}`}</h1>
    <p class="subtitle">on <strong>${escapeHtml(tenant.name)}</strong></p>
    ${flashHtml}
    <div class="card" style="max-width:640px;">
      ${
        resourceKey === "media" && record
          ? `<div style="margin-bottom:18px;">
              <img src="${escapeHtml(record.url)}" alt="${escapeHtml(record.alt_text || record.filename || "")}" style="max-width:100%;max-height:320px;border-radius:8px;border:1px solid var(--panel-border);display:block;" />
              <div style="font-size:12px;color:var(--text-dim);margin-top:6px;">${escapeHtml(record.filename || "")}${record.width && record.height ? ` · ${record.width}×${record.height}` : ""}</div>
            </div>`
          : ""
      }
      <form method="POST" action="${isEdit ? `${base}/${encodeURIComponent(id)}/edit` : `${base}/new`}">
        ${config.fields.map((f) => renderField(f, record, fieldOptions)).join("")}
        <button class="btn" type="submit">${isEdit ? "Save changes" : "Create"}</button>
        <a class="btn btn-secondary" href="${base}">Cancel</a>
      </form>
      ${
        resourceKey === "reviews" && isEdit
          ? `<div style="border-top:1px solid var(--panel-border);margin-top:18px;padding-top:14px;">
              <a class="btn btn-secondary" href="/content/reviews/${encodeURIComponent(id)}/blocks">Manage extra content blocks</a>
            </div>`
          : ""
      }
      ${
        resourceKey === "news" && isEdit
          ? `<div style="border-top:1px solid var(--panel-border);margin-top:18px;padding-top:14px;">
              <a class="btn btn-secondary" href="/content/news/${encodeURIComponent(id)}/newsroom">Manage newsroom tags</a>
            </div>`
          : ""
      }
    </div>
  `;

  return renderShell({ title: isEdit ? `Edit ${config.label}` : `New ${config.label}`, activeKey, admin, bodyHtml: body, env });
}

// -----------------------------------------------------
// SUBMIT HANDLERS (called from index.js)
// -----------------------------------------------------

// Columns that exist on every record but are never sent back in a
// write — server-computed/identity fields. Anything else present
// in the fetched record (including fields this UI doesn't yet
// expose a form control for) is preserved as-is when merging.
const NON_WRITABLE_FIELDS = new Set([
  "id",
  "created_at",
  "updated_at",
  "created_by"
]);

/**
 * Converts one field's raw form-submitted string into the value
 * shape the tenant's database layer actually expects, matching the
 * tenant's own admin frontend (en/static/js/admin.js) exactly:
 *
 *   - "list"        newline-separated textarea -> real JS array of
 *                    trimmed, non-empty strings (matches admin.js's
 *                    pros/cons handling exactly: split("\n").map(trim)
 *                    .filter(Boolean))
 *   - "json_object"  textarea holding JSON -> parsed JS object/array,
 *                    since the DB layer JSON.stringify()s it itself
 *                    (e.g. pages.content_json) — sending an already-
 *                    parsed object here avoids double-encoding.
 *   - "json_raw"     textarea holding JSON -> the RAW STRING is sent
 *                    as-is (e.g. reviews.faq_json), because the DB
 *                    layer does NOT re-stringify it — it expects the
 *                    column's value to already be a JSON-encoded
 *                    string. Only validated for parseability, never
 *                    parsed into an object before sending.
 *   - "richtext"     raw HTML string, sent through unchanged.
 *   - "media"        numeric media-library id, or null.
 *   - "checkbox"     real boolean.
 *   - "number"       real number, or null if left blank.
 *   - "text"/"select" the raw string, or null if left blank (matches
 *                    admin.js's `formData.get(x) || null` convention
 *                    for optional text fields — NOT empty string).
 *
 * Throws a plain Error with a field-specific message on invalid
 * JSON, which the caller turns into a form-level validation error
 * shown to the admin — never silently sent as malformed data.
 */
function coerceFieldValue(field, rawValue, form) {
  switch (field.type) {
    case "checkbox":
      return rawValue === "1";

    case "number":
      return rawValue === "" || rawValue == null ? null : Number(rawValue);

    case "list":
      return rawValue
        ? String(rawValue)
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
        : [];

    case "json_object": {
      const text = (rawValue ?? "").trim();
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new Error(`"${field.label}" is not valid JSON: ${error.message}`);
      }
    }

    case "json_raw": {
      const text = (rawValue ?? "").trim() || "[]";
      try {
        JSON.parse(text); // validate only — send the raw string itself
      } catch (error) {
        throw new Error(`"${field.label}" is not valid JSON: ${error.message}`);
      }
      return text;
    }

    case "media":
      return rawValue === "" || rawValue == null ? null : Number(rawValue);

    case "resource_select":
      return rawValue === "" || rawValue == null ? null : (field.castTo === "string" ? rawValue : Number(rawValue));

    case "multi_select": {
      const text = (rawValue ?? "").trim();
      if (!text) return [];
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error(`"${field.label}" selection was malformed — please try again.`);
      }
      if (!Array.isArray(parsed)) return [];
      return field.castTo === "number" ? parsed.map(Number) : parsed;
    }

    case "geo_rules": {
      const text = (rawValue ?? "").trim();
      if (!text) return [];
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error(`"${field.label}" rules were malformed — please try again.`);
      }
      return Array.isArray(parsed) ? parsed : [];
    }

    case "geo_destinations": {
      const text = (rawValue ?? "").trim();
      if (!text) return [];
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error(`"${field.label}" overrides were malformed — please try again.`);
      }
      return Array.isArray(parsed) ? parsed : [];
    }

    case "richtext":
      return rawValue ?? "";

    case "content_json_rich": {
      const mode = form?.[`${field.name}__mode`] || "richtext";
      if (mode === "json") {
        const text = (rawValue ?? "").trim();
        if (!text) return {};
        try {
          return JSON.parse(text);
        } catch (error) {
          throw new Error(`"${field.label}" is not valid JSON: ${error.message}`);
        }
      }
      // richtext mode: wrap as { text: html } — exactly what the
      // tenant's own admin.js falls back to when what's typed isn't
      // valid JSON (see the comment above renderPageContentField),
      // so pages rendered this way display identically either path.
      return { text: rawValue ?? "" };
    }

    default: // "text", "select", "textarea"
      return rawValue === "" || rawValue == null ? null : rawValue;
  }
}

function coerceFormValues(config, form) {
  const body = {};
  for (const field of config.fields) {
    body[field.name] = coerceFieldValue(field, form[field.name], form);
  }
  return body;
}

export async function submitCreate(env, admin, resourceKey, config, form) {
  const { tenant } = await resolveActiveTenant(env, admin);
  if (!tenant) return { ok: false, error: "no_active_tenant" };

  let body;
  try {
    body = coerceFormValues(config, form);
  } catch (error) {
    return { ok: false, status: 422, reason: "invalid_input", message: error.message };
  }

  const result = await postToTenant(env, tenant, `${BASE_PATH}/${resourceKey}`, body);
  return result;
}

/**
 * Updates a record WITHOUT losing fields the current form doesn't
 * expose an input for. This tenant's own update functions
 * (verified directly against en/worker/database/*.js — e.g.
 * updateNews, updateCasino) are full-overwrite UPDATEs, not partial
 * updates: any field missing from the payload is NOT preserved —
 * it's silently reset to a hardcoded fallback default (e.g. a
 * missing `published` resets a news post to published=1, a missing
 * `author` resets it to "Admin"). So every update here fetches the
 * complete current record first and sends a complete merged
 * representation — edited fields overlaid on top of everything
 * else exactly as it already existed — never a partial object.
 */
export async function submitUpdate(env, admin, resourceKey, config, id, form) {
  const { tenant } = await resolveActiveTenant(env, admin);
  if (!tenant) return { ok: false, error: "no_active_tenant" };

  if (config.roleOnly) {
    return putToTenant(env, tenant, `${BASE_PATH}/${resourceKey}/${encodeURIComponent(id)}`, { role: form.role });
  }

  const existingResult = await getFromTenant(env, tenant, `${BASE_PATH}/${resourceKey}/${encodeURIComponent(id)}`);
  if (!existingResult.ok) return existingResult;

  const existingRecord = existingResult.data.data || {};

  let editedValues;
  try {
    editedValues = coerceFormValues(config, form);
  } catch (error) {
    return { ok: false, status: 422, reason: "invalid_input", message: error.message };
  }

  const body = {};
  for (const [key, value] of Object.entries(existingRecord)) {
    if (!NON_WRITABLE_FIELDS.has(key)) body[key] = value;
  }
  Object.assign(body, editedValues);

  const result = await putToTenant(env, tenant, `${BASE_PATH}/${resourceKey}/${encodeURIComponent(id)}`, body);
  return result;
}

/**
 * Flips one field on an existing record (e.g. Published <-> Draft
 * from the list view, no edit form needed) by fetching the full
 * current record and PUTting it back with just that field changed —
 * the exact same fetch->merge->PUT path submitUpdate() uses, so this
 * can never touch or lose any field the edit form doesn't already
 * touch. `pairField`/`pairOnValue`/`pairOffValue` let one click flip
 * a second, related field in lockstep (e.g. countries' `status`
 * column alongside `published`, so the two never drift out of sync).
 */
export async function submitToggleField(env, admin, resourceKey, id, toggleConfig) {
  const { tenant } = await resolveActiveTenant(env, admin);
  if (!tenant) return { ok: false, error: "no_active_tenant" };

  const existingResult = await getFromTenant(env, tenant, `${BASE_PATH}/${resourceKey}/${encodeURIComponent(id)}`);
  if (!existingResult.ok) return existingResult;

  const existingRecord = existingResult.data.data || {};
  const currentlyOn = !!existingRecord[toggleConfig.key];

  const body = {};
  for (const [key, value] of Object.entries(existingRecord)) {
    if (!NON_WRITABLE_FIELDS.has(key)) body[key] = value;
  }

  body[toggleConfig.key] = currentlyOn ? 0 : 1;
  if (toggleConfig.pairField) {
    body[toggleConfig.pairField] = currentlyOn ? toggleConfig.pairOffValue : toggleConfig.pairOnValue;
  }

  return putToTenant(env, tenant, `${BASE_PATH}/${resourceKey}/${encodeURIComponent(id)}`, body);
}

export async function submitDelete(env, admin, resourceKey, id) {
  const { tenant } = await resolveActiveTenant(env, admin);
  if (!tenant) return { ok: false, error: "no_active_tenant" };

  return deleteFromTenant(env, tenant, `${BASE_PATH}/${resourceKey}/${encodeURIComponent(id)}`);
}

export { resolveActiveTenant };

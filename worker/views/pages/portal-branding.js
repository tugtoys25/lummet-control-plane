// Staff screens for portal branding: the Branding section of Platform settings, and the Media library page.
// Super-admin only (the route layer enforces it). All page text and data is escaped; the browser script builds its DOM with
// textContent / setAttribute, so nothing from a file name or an alt text is ever parsed as HTML.
import { renderShell, escapeHtml as h } from "../layout.js";
import { nonceToken } from "../../csp.js";
import * as branding from "../../portal-branding.js";
import * as media from "../../platform-media.js";
import { MIME_TO_EXT } from "../../image-inspect.js";

const thumb = (m) => (m.kind === "video"
  ? `<video src="${h(m.url)}" preload="metadata" controls muted playsinline></video>`
  : m.kind === "document"
    ? `<span class="pm-tile">${h(typeLabel(m.mimeType).toUpperCase())}</span>`
    : `<img src="${h(m.url)}" alt="${h(m.altText)}" loading="lazy" />`);
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const typeLabel = (mime) => MIME_TO_EXT[mime] || String(mime || "file").split("/").pop();

const STYLE = `<style>
.pm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.pm-item{border:1px solid var(--panel-border);border-radius:var(--radius);background:var(--panel);padding:8px;text-align:left;color:var(--text);font:inherit;display:block;width:100%}
button.pm-item{cursor:pointer}
button.pm-item:hover:not(:disabled){border-color:var(--accent)}
.pm-item:disabled{opacity:.45;cursor:not-allowed}
.pm-thumb{height:96px;display:flex;align-items:center;justify-content:center;background:repeating-conic-gradient(rgba(128,128,128,.12) 0 25%,transparent 0 50%) 50%/16px 16px;border-radius:var(--radius-sm);overflow:hidden}
.pm-thumb img{max-width:100%;max-height:96px;object-fit:contain}
.pm-thumb video{max-width:100%;max-height:96px}
.pm-tile{font-weight:700;font-size:20px;letter-spacing:.05em;color:var(--text-dim)}
.pm-name{font-size:12px;margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pm-meta{font-size:11px;color:var(--text-dim)}
.pm-overlay{position:fixed;inset:0;background:var(--overlay,rgba(0,0,0,.55));z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px}
.pm-overlay[hidden]{display:none}
.pm-modal{background:var(--surface,var(--panel));color:var(--text);border:1px solid var(--panel-border);border-radius:var(--radius);width:min(820px,100%);max-height:90vh;display:flex;flex-direction:column;box-shadow:var(--shadow)}
.pm-modal header{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid var(--panel-border)}
.pm-modal header h3{margin:0}
.pm-body{padding:14px 16px;overflow:auto}
.pm-bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center}
.pm-bar input[type=search],.pm-bar select{width:auto;margin:0;min-width:140px}
.pm-status{font-size:13px;color:var(--text-dim);min-height:18px}
.brand-row{display:grid;grid-template-columns:minmax(140px,200px) 1fr;gap:8px 16px;align-items:start;padding:12px 0;border-top:1px solid var(--panel-border)}
.brand-row:first-of-type{border-top:0}
.brand-row label{font-weight:600;margin:0}
.brand-help{font-size:12px;color:var(--text-dim);margin-top:2px}
.brand-img{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.brand-img input{flex:1 1 220px;margin:0;min-width:0}
.brand-prev{width:40px;height:40px;object-fit:contain;border:1px solid var(--panel-border);border-radius:var(--radius-sm);background:repeating-conic-gradient(rgba(128,128,128,.12) 0 25%,transparent 0 50%) 50%/12px 12px}
.brand-prev[hidden]{display:none}
.brand-err{color:var(--danger-text);font-size:12px;margin-top:4px}
@media (max-width:640px){.brand-row{grid-template-columns:1fr}}
</style>`;

// Shared browser code: the media picker (a modal over the library) used by the branding form, plus the form handling.
const SCRIPT = String.raw`
(function () {
  var PAGE = 24;
  var st = { overlay: null, accept: '', size: 0, folder: '', q: '', page: 1, onPick: null, busy: false };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function api(url, opts) {
    return fetch(url, opts).then(function (r) { return r.json().catch(function () { return { success: false, error: 'bad_response' }; }); });
  }
  function human(code, detail) { return (code || 'failed').replace(/_/g, ' ') + (detail ? ' (' + detail + ')' : ''); }
  var EXT = { 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/jpeg': 'jpg', 'video/quicktime': 'mov', 'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'text/plain': 'txt' };
  function typeName(m) { return EXT[m] || String(m || '').split('/').pop(); }

  function close() { if (st.overlay) st.overlay.hidden = true; st.onPick = null; }
  function setStatus(t) { var s = document.getElementById('pm-status'); if (s) s.textContent = t || ''; }

  function render(data) {
    var grid = document.getElementById('pm-grid');
    grid.textContent = '';
    (data.items || []).forEach(function (m) {
      var ok = !st.size || (m.width === st.size && m.height === st.size) || (m.external && !m.width);
      var b = el('button', 'pm-item');
      b.type = 'button';
      b.disabled = !ok;
      if (!ok) b.title = 'This field needs ' + st.size + ' by ' + st.size + ' pixels';
      var th = el('div', 'pm-thumb'); if (m.kind === 'image' || !m.kind) { var img = el('img'); img.alt = m.altText || ''; img.loading = 'lazy'; img.src = m.url; th.appendChild(img); } else { th.appendChild(el('span', 'pm-tile', typeName(m.mimeType).toUpperCase())); }
      b.appendChild(th);
      b.appendChild(el('div', 'pm-name', m.filename));
      b.appendChild(el('div', 'pm-meta', typeName(m.mimeType) + (m.width ? ' · ' + m.width + '×' + m.height : '') + (m.external ? ' · link' : ' · ' + Math.max(1, Math.round(m.size / 1024)) + ' KB')));
      b.addEventListener('click', function () { var cb = st.onPick; close(); if (cb) cb(m); });
      grid.appendChild(b);
    });
    if (!(data.items || []).length) grid.appendChild(el('p', 'pm-meta', 'Nothing here yet. Upload an image.'));
    var pages = Math.max(1, Math.ceil((data.total || 0) / (data.pageSize || PAGE)));
    document.getElementById('pm-page').textContent = 'Page ' + data.page + ' of ' + pages;
    document.getElementById('pm-prev').disabled = data.page <= 1;
    document.getElementById('pm-next').disabled = data.page >= pages;
    var sel = document.getElementById('pm-folder'); var keep = st.folder; sel.textContent = '';
    var all = el('option', '', 'All folders'); all.value = ''; sel.appendChild(all);
    (data.folders || []).forEach(function (f) { var o = el('option', '', f.folder + ' (' + f.n + ')'); o.value = f.folder; if (f.folder === keep) o.selected = true; sel.appendChild(o); });
  }

  function load() {
    setStatus('Loading…');
    var u = '/api/platform/saas/media?page=' + st.page + '&folder=' + encodeURIComponent(st.folder) + '&q=' + encodeURIComponent(st.q) + (st.accept ? '&accept=' + encodeURIComponent(st.accept) : '');
    api(u).then(function (d) {
      if (!d.success) { setStatus('Could not load the library: ' + human(d.error)); return; }
      setStatus(d.storageConfigured ? '' : 'File storage is not set up (PLATFORM_MEDIA), so uploads are off. Pick an existing file or paste an https address.');
      document.getElementById('pm-upload-wrap').hidden = !d.storageConfigured;
      render(d);
    });
  }

  // One request per file, one after another: a failure names its file and the rest still go up, and the Worker never holds more than one file.
  function uploadMany(files, folder, alt, progress) {
    var list = Array.prototype.slice.call(files); var done = 0; var failed = []; var added = 0;
    return list.reduce(function (chain, f, i) {
      return chain.then(function () {
        progress('Uploading ' + (i + 1) + ' of ' + list.length + ': ' + f.name + '…');
        var fd = new FormData(); fd.append('file', f); fd.append('folder', folder || 'branding'); if (alt) fd.append('alt_text', alt);
        return api('/api/platform/saas/media', { method: 'POST', body: fd }).then(function (d) {
          if (d.success) { done += 1; if (!d.duplicate) added += 1; } else failed.push(f.name + ': ' + human(d.error, d.detail));
        });
      });
    }, Promise.resolve()).then(function () { return { total: list.length, done: done, added: added, failed: failed }; });
  }
  function summary(r) { return r.done + ' of ' + r.total + ' uploaded' + (r.done > r.added ? ' (' + (r.done - r.added) + ' already in the library)' : '') + '.' + (r.failed.length ? ' Not uploaded: ' + r.failed.join('; ') : ''); }
  window.lummetUploadMany = uploadMany; window.lummetUploadSummary = summary;
  function upload(files) {
    uploadMany(files, 'branding', '', setStatus).then(function (r) { setStatus(summary(r)); st.page = 1; load(); });
  }

  function build() {
    var o = el('div', 'pm-overlay'); o.hidden = true; o.id = 'pm-overlay';
    var m = el('div', 'pm-modal'); m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', 'Choose an image');
    var hd = el('header'); hd.appendChild(el('h3', '', 'Choose an image'));
    var x = el('button', 'btn btn-secondary btn-small', 'Close'); x.type = 'button'; x.addEventListener('click', close); hd.appendChild(x); m.appendChild(hd);
    var body = el('div', 'pm-body');
    var bar = el('div', 'pm-bar');
    var q = el('input'); q.type = 'search'; q.placeholder = 'Search…'; q.id = 'pm-q'; q.setAttribute('aria-label', 'Search the library');
    var t; q.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { st.q = q.value; st.page = 1; load(); }, 300); });
    var f = el('select'); f.id = 'pm-folder'; f.setAttribute('aria-label', 'Folder'); f.addEventListener('change', function () { st.folder = f.value; st.page = 1; load(); });
    var up = el('label', 'btn btn-small'); up.id = 'pm-upload-wrap'; up.textContent = '+ Upload (one or more) ';
    var fi = el('input'); fi.type = 'file'; fi.multiple = true; fi.accept = '.png,.jpg,.jpeg,.gif,.webp,.ico,.svg'; fi.hidden = true;
    fi.addEventListener('change', function () { if (fi.files && fi.files.length) upload(fi.files); fi.value = ''; });
    up.appendChild(fi);
    bar.appendChild(q); bar.appendChild(f); bar.appendChild(up); body.appendChild(bar);
    var s = el('div', 'pm-status'); s.id = 'pm-status'; s.setAttribute('role', 'status'); body.appendChild(s);
    var g = el('div', 'pm-grid'); g.id = 'pm-grid'; body.appendChild(g);
    var pg = el('div', 'pm-bar'); pg.style.marginTop = '12px';
    var pv = el('button', 'btn btn-secondary btn-small', 'Previous'); pv.type = 'button'; pv.id = 'pm-prev'; pv.addEventListener('click', function () { if (st.page > 1) { st.page -= 1; load(); } });
    var pn = el('span', 'pm-meta', ''); pn.id = 'pm-page';
    var nx = el('button', 'btn btn-secondary btn-small', 'Next'); nx.type = 'button'; nx.id = 'pm-next'; nx.addEventListener('click', function () { st.page += 1; load(); });
    pg.appendChild(pv); pg.appendChild(pn); pg.appendChild(nx); body.appendChild(pg);
    m.appendChild(body); o.appendChild(m);
    o.addEventListener('click', function (e) { if (e.target === o) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !o.hidden) close(); });
    document.body.appendChild(o);
    return o;
  }

  window.lummetMediaPicker = function (opts) {
    if (!st.overlay) st.overlay = build();
    st.accept = opts.accept || ''; st.size = opts.size || 0; st.onPick = opts.onPick; st.folder = ''; st.q = ''; st.page = 1;
    document.getElementById('pm-q').value = '';
    st.overlay.hidden = false; load();
    document.getElementById('pm-q').focus();
  };

  // ----- branding form -----
  function preview(input) {
    var img = input.closest('.brand-img'); if (!img) return;
    var p = img.querySelector('.brand-prev'); if (!p) return;
    var v = input.value.trim();
    if (v) { p.src = v; p.hidden = false; } else { p.removeAttribute('src'); p.hidden = true; }
  }
  document.addEventListener('input', function (e) { if (e.target && e.target.matches && e.target.matches('[data-brand-key]')) preview(e.target); });
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null; if (!t) return;
    var pick = t.closest('[data-brand-pick]');
    if (pick) {
      var input = document.querySelector('[data-brand-key="' + pick.getAttribute('data-brand-pick') + '"]');
      window.lummetMediaPicker({ accept: input.getAttribute('data-accept') || '', size: Number(input.getAttribute('data-size')) || 0, onPick: function (m) { input.value = m.url; preview(input); var er = input.closest('.brand-row').querySelector('.brand-err'); if (er) er.textContent = ''; } });
      return;
    }
    var clr = t.closest('[data-brand-clear]');
    if (clr) { var i2 = document.querySelector('[data-brand-key="' + clr.getAttribute('data-brand-clear') + '"]'); i2.value = ''; preview(i2); return; }
    if (t.closest('#brand-save')) {
      var values = {};
      document.querySelectorAll('[data-brand-key]').forEach(function (n) { values[n.getAttribute('data-brand-key')] = n.value; });
      var reason = document.getElementById('brand-reason').value.trim();
      var status = document.getElementById('brand-status');
      document.querySelectorAll('.brand-err').forEach(function (n) { n.textContent = ''; });
      if (reason.length < 3) { status.textContent = 'Give a reason (at least 3 characters). It goes in the audit log.'; return; }
      status.textContent = 'Saving…';
      api('/api/platform/saas/branding', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: values, reason: reason }) }).then(function (d) {
        if (d.success) { status.textContent = d.unchanged ? 'Nothing changed.' : 'Saved. Open pages pick it up within about 15 seconds.'; if (!d.unchanged) setTimeout(function () { location.reload(); }, 900); return; }
        if (d.errors) {
          Object.keys(d.errors).forEach(function (k) { var n = document.querySelector('[data-brand-key="' + k + '"]'); var er = n && n.closest('.brand-row').querySelector('.brand-err'); if (er) er.textContent = human(d.errors[k].error, d.errors[k].detail); });
          status.textContent = 'Fix the highlighted fields and save again.'; return;
        }
        status.textContent = 'Failed: ' + human(d.error, d.detail);
      });
    }
  });

  // ----- library page -----
  window.lummetMediaUpload = function (form) {
    var files = form.querySelector('input[type=file]').files; var s = document.getElementById('lib-status');
    if (!files || !files.length) { s.textContent = 'Choose one or more files first.'; return; }
    var btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    uploadMany(files, form.folder.value || 'branding', form.alt_text.value || '', function (t) { s.textContent = t; }).then(function (r) {
      s.textContent = summary(r);
      if (!r.failed.length) setTimeout(function () { location.reload(); }, 700); else btn.disabled = false;
    });
  };
  window.lummetMediaSave = function (id) {
    var row = document.querySelector('[data-media-id="' + id + '"]');
    api('/api/platform/saas/media/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ altText: row.querySelector('[name=alt]').value, folder: row.querySelector('[name=folder]').value }) })
      .then(function (d) { if (d.success) location.reload(); else alert('Failed: ' + human(d.error, d.detail)); });
  };
  window.lummetMediaDelete = function (id) {
    if (!confirm('Delete this file? It cannot be undone.')) return;
    api('/api/platform/saas/media/' + encodeURIComponent(id), { method: 'DELETE' }).then(function (d) { if (d.success) location.reload(); else alert('Not deleted: ' + human(d.error, d.detail)); });
  };
  function fullUrl(url) { return new URL(url, location.origin).href; }
  function flash(btn, text) { var old = btn.getAttribute('data-label') || btn.textContent; btn.setAttribute('data-label', old); btn.textContent = text; setTimeout(function () { btn.textContent = old; }, 1800); }
  window.lummetMediaCopy = function (btn, url) {
    var full = fullUrl(url);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(full).then(function () { flash(btn, 'Copied'); }, function () { window.prompt('Copy this address', full); });
    else window.prompt('Copy this address', full);
  };
  window.lummetMediaShare = function (btn, url, name) {
    var full = fullUrl(url);
    if (navigator.share) { navigator.share({ title: name || 'Image', url: full }).catch(function () {}); return; }
    window.lummetMediaCopy(btn, url); // no share sheet on this browser: copy the address instead
  };
  window.lummetMediaAddLink = function (form) {
    var s = document.getElementById('link-status');
    var body = { url: form.url.value, filename: form.filename.value, folder: form.folder.value || 'branding', altText: form.alt_text.value, width: form.width.value, height: form.height.value };
    if (!body.url.trim()) { s.textContent = 'Paste an image address first.'; return; }
    s.textContent = 'Adding…';
    api('/api/platform/saas/media/from-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (d) { if (d.success) location.reload(); else s.textContent = 'Not added: ' + human(d.error, d.detail); });
  };
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null; if (!t) return;
    var a = t.closest('[data-media-act]'); if (!a) return;
    var id = a.getAttribute('data-id'); var act = a.getAttribute('data-media-act');
    if (act === 'save') window.lummetMediaSave(id);
    else if (act === 'delete') window.lummetMediaDelete(id);
    else if (act === 'copy') window.lummetMediaCopy(a, a.getAttribute('data-url'));
    else if (act === 'share') window.lummetMediaShare(a, a.getAttribute('data-url'), a.getAttribute('data-name'));
  });
  document.addEventListener('submit', function (e) {
    var f = e.target; if (!f) return;
    if (f.id === 'lib-upload') { e.preventDefault(); window.lummetMediaUpload(f); }
    else if (f.id === 'lib-link') { e.preventDefault(); window.lummetMediaAddLink(f); }
  });
})();
`;

const script = () => `<script nonce="${nonceToken()}">${SCRIPT}</script>`;

function fieldRow(f) {
  const label = `<label for="brand-${h(f.key)}">${h(f.label)}</label><div class="brand-help">${h(f.help)}</div>`;
  if (f.type === "image") {
    const accept = (f.accept || []).join(",");
    return `<div class="brand-row"><div>${label}</div><div>
      <div class="brand-img">
        <img class="brand-prev" alt=""${f.value ? ` src="${h(f.value)}"` : " hidden"} />
        <input type="text" id="brand-${h(f.key)}" data-brand-key="${h(f.key)}" data-accept="${h(accept)}"${f.size ? ` data-size="${f.size}"` : ""} value="${h(f.value)}" placeholder="Choose a file, or paste an https address" maxlength="500" autocomplete="off" />
        <button type="button" class="btn btn-secondary btn-small" data-brand-pick="${h(f.key)}">Choose…</button>
        <button type="button" class="btn btn-secondary btn-small" data-brand-clear="${h(f.key)}">Clear</button>
      </div>
      <div class="brand-err" role="alert"></div>
      ${f.updatedBy ? `<div class="brand-help">Set by ${h(f.updatedBy)} · ${h(f.updatedAt || "")}</div>` : ""}
    </div></div>`;
  }
  if (f.type === "enum") {
    return `<div class="brand-row"><div>${label}</div><div>
      <select id="brand-${h(f.key)}" data-brand-key="${h(f.key)}"><option value="">Default</option>${f.options.map((o) => `<option${o === f.value ? " selected" : ""}>${h(o)}</option>`).join("")}</select>
      <div class="brand-err" role="alert"></div></div></div>`;
  }
  return `<div class="brand-row"><div>${label}</div><div>
    <input type="text" id="brand-${h(f.key)}" data-brand-key="${h(f.key)}" value="${h(f.value)}" maxlength="${f.type === "color" ? 7 : f.max || 100}"${f.type === "color" ? ' placeholder="#1a56db"' : ""} autocomplete="off" />
    <div class="brand-err" role="alert"></div></div></div>`;
}

/** The Branding section shown on the Platform settings page. */
export async function renderBrandingSection(env) {
  const fields = await branding.listFields(env);
  const storage = media.storageConfigured(env);
  const groups = branding.GROUPS.map((g) => `<div class="card"><h3 style="margin-top:0">${h(g.title)}</h3><p style="color:var(--text-dim);font-size:13px;margin-top:0">${h(g.help)}</p>${fields.filter((f) => f.group === g.id).map(fieldRow).join("")}</div>`).join("");
  return `${STYLE}
    <h2 id="branding">Branding</h2>
    <p style="color:var(--text-dim)">The name, logo, favicons and app icons of the control plane. Pick each image from the <a href="/platform/saas/media">media library</a> (or upload one in the picker), or paste an https address. Empty means the built-in look. An icon has to be the right type and size: a 96 px favicon must be a 96 by 96 PNG. Values are saved together and every save is audited.</p>
    ${storage ? "" : `<div class="flash flash-error">File storage is not set up: the <code>PLATFORM_MEDIA</code> R2 bucket is not bound, so uploads are off. Existing files and https addresses still work. See DEPLOYMENT.md.</div>`}
    ${groups}
    <div class="card">
      <label for="brand-reason">Reason (audited)</label>
      <input id="brand-reason" maxlength="500" placeholder="Why this change" autocomplete="off" />
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px"><button type="button" class="btn" id="brand-save">Save branding</button><span id="brand-status" class="pm-status" role="status"></span></div>
    </div>
    ${script()}`;
}

/** Staff console: the control plane's media library. */
export async function renderMediaLibraryPage(env, admin, { folder = "", q = "", page = 1, kind = "" } = {}) {
  const kindKey = media.KIND_FILTERS[kind] ? kind : "";
  const data = await media.listMedia(env, { folder, search: q, page, accept: kindKey ? media.KIND_FILTERS[kindKey] : null });
  const storage = media.storageConfigured(env);
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const link = (p) => `/platform/saas/media?${new URLSearchParams({ ...(folder ? { folder } : {}), ...(q ? { q } : {}), ...(kindKey ? { kind: kindKey } : {}), page: String(p) })}`;
  const cards = data.items.map((m) => `<div class="card" data-media-id="${h(m.id)}" style="margin:0">
      <div class="pm-thumb">${thumb(m)}</div>
      <div class="pm-name" title="${h(m.filename)}">${h(m.filename)}</div>
      <div class="pm-meta">${h(typeLabel(m.mimeType))}${m.width ? ` · ${m.width}×${m.height}` : ""} · ${m.external ? "link" : h(kb(m.size))}</div>
      ${m.external ? `<div class="pm-meta" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${h(m.url)}">${h(m.url)}</div>` : ""}
      <label style="margin-top:8px">Alt text</label><input name="alt" value="${h(m.altText)}" maxlength="200" />
      <label>Folder</label><input name="folder" value="${h(m.folder)}" maxlength="32" />
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
        <button type="button" class="btn btn-small" data-media-act="save" data-id="${h(m.id)}">Save</button>
        <button type="button" class="btn btn-secondary btn-small" data-media-act="copy" data-id="${h(m.id)}" data-url="${h(m.url)}">Copy link</button>
        <button type="button" class="btn btn-secondary btn-small" data-media-act="share" data-id="${h(m.id)}" data-url="${h(m.url)}" data-name="${h(m.filename)}">Share</button>
        <button type="button" class="btn btn-danger btn-small" data-media-act="delete" data-id="${h(m.id)}">Delete</button>
      </div>
    </div>`).join("");
  const upload = storage
    ? `<form id="lib-upload" class="card" style="max-width:560px">
        <h3 style="margin-top:0">Upload</h3>
        <label for="lib-file">Files (choose one or several)</label>
        <input id="lib-file" type="file" multiple accept="${media.ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(",")}" required />
        <p class="pm-meta" style="margin:0 0 8px">Images (PNG, JPEG, GIF, WebP, ICO, SVG) up to ${Math.round(media.MAX_IMAGE_BYTES / 1048576)} MB, video (MP4, MOV, WebM, OGG) up to ${Math.round(media.MAX_VIDEO_BYTES / 1048576)} MB, documents (PDF, TXT, DOC, DOCX) up to ${Math.round(media.MAX_DOCUMENT_BYTES / 1048576)} MB. They go up one after another.</p>
        <label for="lib-folder">Folder</label><input id="lib-folder" name="folder" value="branding" maxlength="32" />
        <label for="lib-alt">Alt text</label><input id="lib-alt" name="alt_text" maxlength="200" />
        <div id="lib-status" class="pm-status" role="status"></div>
        <button class="btn" type="submit">Upload</button>
      </form>`
    : `<div class="flash flash-error">File storage is not set up: the <code>PLATFORM_MEDIA</code> R2 bucket is not bound, so uploads are off. See DEPLOYMENT.md.</div>`;
  const linkForm = `<form id="lib-link" class="card" style="max-width:560px">
        <h3 style="margin-top:0">Add by link</h3>
        <p style="font-size:13px;color:var(--text-dim);margin-top:0">Keeps an image that is already hosted elsewhere in the library without uploading it. Works without file storage. The image stays at its own address: if it moves or is removed there, it stops showing here.</p>
        <label for="link-url">Image address (https) *</label><input id="link-url" name="url" type="url" required maxlength="500" placeholder="https://…" />
        <label for="link-name">File name</label><input id="link-name" name="filename" maxlength="120" placeholder="logo.png (taken from the address when empty)" />
        <label for="link-folder">Folder</label><input id="link-folder" name="folder" value="branding" maxlength="32" />
        <label for="link-alt">Alt text</label><input id="link-alt" name="alt_text" maxlength="200" />
        <div style="display:flex;gap:8px"><div style="flex:1"><label for="link-w">Width (optional)</label><input id="link-w" name="width" type="number" min="1" max="16384" /></div><div style="flex:1"><label for="link-h">Height (optional)</label><input id="link-h" name="height" type="number" min="1" max="16384" /></div></div>
        <div id="link-status" class="pm-status" role="status"></div>
        <button class="btn" type="submit">Add from link</button>
      </form>`;
  const body = `${STYLE}
    <h1>Media library</h1>
    <p class="subtitle">Platform · The control plane's own images, video and documents: logos, favicons and app icons, and anything else you want a link to. Separate from every tenant's media library. Use them in <a href="/platform/saas/settings#branding">Branding</a>.</p>
    <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">${upload}${linkForm}</div>
    <form method="get" style="display:flex;gap:8px;margin:16px 0;flex-wrap:wrap">
      <input type="search" name="q" value="${h(q)}" placeholder="Search file name or alt text" style="width:auto;margin:0" />
      <select name="folder" style="width:auto;margin:0"><option value="">All folders</option>${data.folders.map((f) => `<option value="${h(f.folder)}"${f.folder === folder ? " selected" : ""}>${h(f.folder)} (${h(f.n)})</option>`).join("")}</select>
      <select name="kind" style="width:auto;margin:0"><option value="">All types</option>${[["image", "Images"], ["video", "Video"], ["file", "Documents"]].map(([k, l]) => `<option value="${k}"${k === kindKey ? " selected" : ""}>${l}</option>`).join("")}</select>
      <button class="btn btn-secondary" type="submit">Filter</button>
    </form>
    ${cards ? `<div class="pm-grid" style="grid-template-columns:repeat(auto-fill,minmax(240px,1fr))">${cards}</div>` : `<p style="color:var(--text-dim)">No files yet.</p>`}
    <div style="display:flex;gap:10px;align-items:center;margin-top:16px">
      ${data.page > 1 ? `<a class="btn btn-secondary btn-small" href="${h(link(data.page - 1))}">Previous</a>` : ""}
      <span class="pm-meta">Page ${h(data.page)} of ${h(pages)} · ${h(data.total)} file${data.total === 1 ? "" : "s"}</span>
      ${data.page < pages ? `<a class="btn btn-secondary btn-small" href="${h(link(data.page + 1))}">Next</a>` : ""}
    </div>
    ${script()}`;
  return renderShell({ title: "Media library", activeKey: "saas-media", admin, bodyHtml: body, env });
}

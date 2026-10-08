import { renderShell, escapeHtml } from "../layout.js";
import { getTenant } from "../../registry.js";
import { postToTenant } from "../../client.js";
import { nonceToken } from "../../csp.js";

export async function renderMediaUploadForm(env, admin, formError) {
  if (!admin.activeTenantId) {
    const body = `
      <h1>Upload Media</h1>
      <div class="card"><p style="font-size:14px;">No active tenant is selected. Use the switcher at the top of the page to pick one.</p></div>
    `;
    return renderShell({ title: "Upload Media", activeKey: "system-media", admin, bodyHtml: body, env });
  }

  const flash = formError ? `<div class="flash flash-error">${escapeHtml(formError)}</div>` : "";

  const body = `
    <h1>Upload Media</h1>
    <p class="subtitle">System · Media · Upload</p>
    ${flash}
    <div class="card" style="max-width:520px;">
      <form id="uploadForm">
        <label for="file">File</label>
        <input type="file" id="file" name="file" accept="image/*" required />
        <label for="folder">Folder</label>
        <input type="text" id="folder" name="folder" value="general" />
        <label for="alt_text">Alt text</label>
        <input type="text" id="alt_text" name="alt_text" />
        <label for="caption">Caption</label>
        <input type="text" id="caption" name="caption" />
        <div id="uploadStatus" style="font-size:13px;color:var(--text-dim);margin-bottom:14px;"></div>
        <button class="btn" type="submit" id="uploadBtn">Upload</button>
        <a class="btn btn-secondary" href="/system/media">Cancel</a>
      </form>
    </div>

    <div class="card" style="max-width:520px;">
      <h3 style="margin-top:0;">Or add an image already hosted elsewhere</h3>
      <p style="font-size:13px;color:var(--text-dim);margin-top:0;">Adds it to the media library by URL, without re-uploading the file — same as the tenant's own "Add Image from External URL" option.</p>
      <form id="urlForm">
        <label for="url_url">Image URL *</label>
        <input type="url" id="url_url" name="url" required placeholder="https://…" />
        <label for="url_filename">Filename *</label>
        <input type="text" id="url_filename" name="filename" required placeholder="my-image.jpg" />
        <label for="url_thumbnail">Thumbnail URL</label>
        <input type="url" id="url_thumbnail" name="thumbnail_url" placeholder="optional — defaults to the image itself" />
        <label for="url_folder">Folder</label>
        <input type="text" id="url_folder" name="folder" value="general" />
        <label for="url_alt">Alt text</label>
        <input type="text" id="url_alt" name="alt_text" />
        <div id="urlStatus" style="font-size:13px;color:var(--text-dim);margin-bottom:14px;"></div>
        <button class="btn" type="submit" id="urlBtn">Add from URL</button>
      </form>
    </div>
    <script nonce="${nonceToken()}">
      document.getElementById("urlForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const statusEl = document.getElementById("urlStatus");
        const btn = document.getElementById("urlBtn");
        btn.disabled = true;
        statusEl.textContent = "Adding…";
        try {
          const res = await fetch("/api/media/from-url", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: document.getElementById("url_url").value,
              filename: document.getElementById("url_filename").value,
              thumbnail_url: document.getElementById("url_thumbnail").value || undefined,
              folder: document.getElementById("url_folder").value || "general",
              alt_text: document.getElementById("url_alt").value
            })
          });
          const data = await res.json();
          if (data.success) {
            location.href = "/system/media?flash=Added&flash_type=success";
          } else {
            statusEl.textContent = "Failed: " + (data.message || data.error || "unknown error");
            btn.disabled = false;
          }
        } catch (err) {
          statusEl.textContent = "Could not add.";
          btn.disabled = false;
        }
      });
    </script>
    <script nonce="${nonceToken()}">
      document.getElementById("uploadForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const fileInput = document.getElementById("file");
        const file = fileInput.files[0];
        const statusEl = document.getElementById("uploadStatus");
        const btn = document.getElementById("uploadBtn");
        if (!file) { statusEl.textContent = "Choose a file first."; return; }

        btn.disabled = true;
        statusEl.textContent = "Reading file…";

        const reader = new FileReader();
        reader.onload = async () => {
          const base64 = reader.result.split(",")[1];
          statusEl.textContent = "Uploading…";

          try {
            const res = await fetch("/api/media/upload", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                filename: file.name,
                mime_type: file.type,
                folder: document.getElementById("folder").value || "general",
                alt_text: document.getElementById("alt_text").value,
                caption: document.getElementById("caption").value,
                data_base64: base64
              })
            });
            const data = await res.json();
            if (data.success) {
              location.href = "/system/media?flash=Uploaded&flash_type=success";
            } else {
              statusEl.textContent = "Failed: " + (data.message || data.error || "unknown error");
              btn.disabled = false;
            }
          } catch (err) {
            statusEl.textContent = "Upload failed.";
            btn.disabled = false;
          }
        };
        reader.onerror = () => { statusEl.textContent = "Could not read file."; btn.disabled = false; };
        reader.readAsDataURL(file);
      });
    </script>
  `;

  return renderShell({ title: "Upload Media", activeKey: "system-media", admin, bodyHtml: body, env });
}

/**
 * Server-side handler for the base64 JSON the upload form's client
 * script sends. Forwards to the active tenant's Super API upload
 * endpoint through the normal authenticated client.js path.
 */
export async function submitMediaUpload(env, admin, payload) {
  if (!admin.activeTenantId) return { ok: false, status: 422, reason: "no_active_tenant" };

  const tenant = await getTenant(env, admin.activeTenantId);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };

  return postToTenant(env, tenant, "/en/api/super/media/upload", payload);
}

/**
 * Adds an externally-hosted image by URL, metadata only — no bytes
 * pass through this worker. Mirrors the tenant's own "Add Image
 * from External URL" admin form.
 */
export async function submitMediaFromUrl(env, admin, payload) {
  if (!admin.activeTenantId) return { ok: false, status: 422, reason: "no_active_tenant" };

  const tenant = await getTenant(env, admin.activeTenantId);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };

  return postToTenant(env, tenant, "/en/api/super/media/from-url", payload);
}

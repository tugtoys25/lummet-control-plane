// =====================================================
// REVIEW BLOCKS
// Manages en/worker/database/review_blocks.js records for one
// review — ordered title+content sub-sections shown below the
// review's main content on the tenant (e.g. "Deposit Methods",
// "Mobile Experience"). Wraps the Super API endpoints added in
// handlers.js's REVIEW BLOCKS section.
//
// Lives as its own page (rather than embedded in the review edit
// form) because each block gets its own full rich text editor —
// several rich text editor instances stacked in one page is fine
// (the editor's instance-counter design already supports that), but
// keeping it a separate screen keeps the main review form's already
// long field list from getting longer.
// =====================================================

import { renderShell, escapeHtml } from "../layout.js";
import { getFromTenant } from "../../client.js";
import { getTenant } from "../../registry.js";
import { renderRichTextField } from "./crud.js";
import { nonceToken } from "../../csp.js";

const BASE_PATH = "/en/api/super";

export async function renderReviewBlocksPage(env, admin, reviewSlug) {
  const activeKey = "content-reviews";

  if (!admin.activeTenantId) {
    const body = `<h1>Review blocks</h1><div class="card"><p style="font-size:14px;">No active tenant is selected. Use the switcher at the top of the page to pick one.</p></div>`;
    return renderShell({ title: "Review blocks", activeKey, admin, bodyHtml: body, env });
  }

  const tenant = await getTenant(env, admin.activeTenantId);
  if (!tenant) {
    const body = `<h1>Review blocks</h1><div class="card"><p>Active tenant no longer exists.</p></div>`;
    return renderShell({ title: "Review blocks", activeKey, admin, bodyHtml: body, env });
  }

  const [reviewResult, blocksResult] = await Promise.all([
    getFromTenant(env, tenant, `${BASE_PATH}/reviews/${encodeURIComponent(reviewSlug)}`),
    getFromTenant(env, tenant, `${BASE_PATH}/review-blocks?review_slug=${encodeURIComponent(reviewSlug)}`)
  ]);

  if (!reviewResult.ok) {
    const body = `<h1>Review blocks</h1><div class="flash flash-error">Could not load that review.</div>`;
    return renderShell({ title: "Review blocks", activeKey, admin, bodyHtml: body, env });
  }
  if (!blocksResult.ok) {
    const body = `<h1>Review blocks</h1><div class="flash flash-error"><strong>${escapeHtml(String(blocksResult.status))}</strong> — ${escapeHtml(blocksResult.message || "Could not load review blocks. If this tenant hasn't redeployed with the new /en/api/super/review-blocks routes yet, that's why.")}</div>`;
    return renderShell({ title: "Review blocks", activeKey, admin, bodyHtml: body, env });
  }

  const review = reviewResult.data.data;
  const blocks = (blocksResult.data.data || []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const blockRowHtml = (block) => `
    <div class="card" style="margin-bottom:14px;" data-block-card="${block.id}">
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;">
        <input type="text" placeholder="Block title" value="${escapeHtml(block.title || "")}" name="title__${block.id}" style="flex:1;margin:0;" />
        <label style="font-size:12px;color:var(--text-dim);white-space:nowrap;">Position <input type="number" name="position__${block.id}" value="${escapeHtml(block.position ?? 0)}" style="width:60px;margin:0;" /></label>
      </div>
      ${renderRichTextField({ name: `content__${block.id}`, label: "Content" }, block.content || "")}
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button type="button" class="btn btn-small" data-block-save="${block.id}">Save</button>
        <button type="button" class="btn btn-secondary btn-small" data-block-delete="${block.id}" style="color:var(--danger);">Delete</button>
      </div>
    </div>`;

  const newBlockHtml = `
    <div class="card" style="margin-bottom:14px;border-style:dashed;">
      <h3 style="margin-top:0;">Add a block</h3>
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;">
        <input type="text" placeholder="Block title" name="title__new" style="flex:1;margin:0;" />
        <label style="font-size:12px;color:var(--text-dim);white-space:nowrap;">Position <input type="number" name="position__new" value="${blocks.length}" style="width:60px;margin:0;" /></label>
      </div>
      ${renderRichTextField({ name: "content__new", label: "Content" }, "")}
      <button type="button" class="btn btn-small" id="blockAddBtn" style="margin-top:10px;">Add block</button>
    </div>`;

  const body = `
    <h1>Review blocks</h1>
    <p class="subtitle">Content · Reviews · Extra sections for <strong>${escapeHtml(review.title || reviewSlug)}</strong> on <strong>${escapeHtml(tenant.name)}</strong></p>
    <div class="card">
      <p style="font-size:13px;color:var(--text-dim);margin-top:0;">These render below the review's main content on the live site, in position order (lowest first). Optional — a review with none just shows its main content as usual.</p>
    </div>
    ${blocks.map(blockRowHtml).join("") || `<p class="empty">No extra blocks yet.</p>`}
    ${newBlockHtml}
    <a class="btn btn-secondary" href="/content/reviews/${encodeURIComponent(reviewSlug)}/edit">Back to review</a>

    <script nonce="${nonceToken()}">
      const REVIEW_SLUG = ${JSON.stringify(reviewSlug)};

      function blockFieldValue(name) {
        const el = document.querySelector('[name="' + name + '"]');
        return el ? el.value : "";
      }

      async function blockApi(path, method, body) {
        const res = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
        const data = await res.json().catch(() => ({}));
        if (!data.success) alert("Could not save: " + (data.message || data.error || "unknown error"));
        return data.success;
      }

      document.body.addEventListener("click", (e) => {
        const saveBtn = e.target.closest("[data-block-save]");
        if (saveBtn) {
          const id = saveBtn.dataset.blockSave;
          blockApi("/api/review-blocks/" + id, "PUT", {
            title: blockFieldValue("title__" + id),
            content: blockFieldValue("content__" + id),
            position: Number(blockFieldValue("position__" + id)) || 0
          }).then((ok) => { if (ok) location.reload(); });
          return;
        }
        const delBtn = e.target.closest("[data-block-delete]");
        if (delBtn) {
          if (!confirm("Delete this block?")) return;
          blockApi("/api/review-blocks/" + delBtn.dataset.blockDelete, "DELETE").then((ok) => { if (ok) location.reload(); });
          return;
        }
        if (e.target.closest("#blockAddBtn")) {
          const title = blockFieldValue("title__new");
          if (!title.trim()) { alert("Give the block a title first."); return; }
          blockApi("/api/review-blocks", "POST", {
            review_slug: REVIEW_SLUG,
            title,
            content: blockFieldValue("content__new"),
            position: Number(blockFieldValue("position__new")) || 0
          }).then((ok) => { if (ok) location.reload(); });
        }
      });
    </script>
  `;

  return renderShell({ title: "Review blocks", activeKey, admin, bodyHtml: body, env });
}

async function resolveTenantOrNull(env, admin) {
  if (!admin.activeTenantId) return null;
  return getTenant(env, admin.activeTenantId);
}

export async function submitCreateReviewBlock(env, admin, payload) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  const { postToTenant } = await import("../../client.js");
  return postToTenant(env, tenant, `${BASE_PATH}/review-blocks`, payload);
}

export async function submitUpdateReviewBlock(env, admin, id, payload) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  const { putToTenant } = await import("../../client.js");
  return putToTenant(env, tenant, `${BASE_PATH}/review-blocks/${encodeURIComponent(id)}`, payload);
}

export async function submitDeleteReviewBlock(env, admin, id) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  const { deleteFromTenant } = await import("../../client.js");
  return deleteFromTenant(env, tenant, `${BASE_PATH}/review-blocks/${encodeURIComponent(id)}`);
}

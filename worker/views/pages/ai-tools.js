// =====================================================
// EDITORIAL AI TOOLS
// Wraps en/worker/super/handlers-ai.js (Super API v10) --
// generation-only wrappers around the tenant's own
// en/worker/ai/admin-tools.js. Every tool here returns text/JSON
// for the admin to review and paste into the normal Casinos/Reviews/
// SEO Meta screens -- there is no auto-save and no destructive
// action anywhere on this page (see handlers-ai.js header for why:
// this deliberately does NOT re-expose the tenant's separate
// natural-language "/api/admin/ai-command" layer).
//
// Gated requireSuperAdmin() in index.js, same boundary as
// Integrations -- this calls the tenant's Cloudflare Workers AI
// binding on every request, which costs the tenant real inference
// spend, so it isn't opened up through the ordinary editor
// permission matrix.
// =====================================================

import { renderShell, escapeHtml } from "../layout.js";
import { getFromTenant, postToTenant } from "../../client.js";
import { getTenant } from "../../registry.js";
import { nonceToken } from "../../csp.js";

const BASE_PATH = "/en/api/super/ai";

export async function renderAiToolsPage(env, admin) {
  const activeKey = "content-ai-tools";
  const title = "AI Tools";

  if (!admin.activeTenantId) {
    const body = `<h1>${title}</h1><div class="card"><p style="font-size:14px;">No active tenant is selected. Use the switcher at the top of the page to pick one.</p></div>`;
    return renderShell({ title, activeKey, admin, bodyHtml: body, env });
  }
  const tenant = await getTenant(env, admin.activeTenantId);
  if (!tenant) {
    const body = `<h1>${title}</h1><div class="card"><p>Active tenant no longer exists.</p></div>`;
    return renderShell({ title, activeKey, admin, bodyHtml: body, env });
  }

  const availability = await getFromTenant(env, tenant, `${BASE_PATH}/availability`);

  let availabilityHtml;
  if (!availability.ok) {
    availabilityHtml = `<div class="flash flash-error"><strong>${escapeHtml(String(availability.status))}</strong> — ${escapeHtml(availability.message || "Could not reach this tenant. If it hasn't redeployed with the /en/api/super/ai/* routes yet, that's why.")}</div>`;
  } else if (!availability.data.available) {
    availabilityHtml = `<div class="flash flash-error">This tenant has no Workers AI binding (<code>env.AI</code>) configured — every tool below will return "not generated" until it does.</div>`;
  } else {
    availabilityHtml = `<p style="font-size:13px;color:var(--text-dim);">Model: <code>${escapeHtml(availability.data.model)}</code> — every result below is a suggestion only; nothing is saved automatically.</p>`;
  }

  let seoDomainGuess = "";
  try {
    seoDomainGuess = tenant.api_base_url ? new URL(tenant.api_base_url).hostname : "";
  } catch (_) {
    seoDomainGuess = "";
  }

  const body = `
    <h1>${title}</h1>
    <p class="subtitle">Content · AI Tools on <strong>${escapeHtml(tenant.name)}</strong> · super-admin only</p>
    ${availabilityHtml}

    <div class="card">
      <h3 style="margin-top:0;">Generate a casino review</h3>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <label>Casino name<input type="text" id="revCasinoName" /></label>
        <label>Country code<input type="text" id="revCountry" value="RW" style="width:80px;" /></label>
        <label>Slug<input type="text" id="revSlug" /></label>
      </div>
      <button type="button" class="btn btn-small" id="genReviewBtn" style="margin-top:8px;">Generate</button>
      <textarea id="revOutput" readonly style="margin-top:10px;min-height:160px;width:100%;" placeholder="Generated review text appears here…"></textarea>
    </div>

    <div class="card">
      <h3 style="margin-top:0;">Generate SEO title + description</h3>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <label>Target domain<input type="text" id="seoDomain" value="${escapeHtml(seoDomainGuess)}" /></label>
        <label>Type<input type="text" id="seoType" value="casino" style="width:100px;" /></label>
        <label>Slug<input type="text" id="seoSlug" /></label>
        <label>Country<input type="text" id="seoCountryLabel" value="Global" style="width:100px;" /></label>
      </div>
      <button type="button" class="btn btn-small" id="genSeoBtn" style="margin-top:8px;">Generate</button>
      <pre id="seoOutput" style="margin-top:10px;min-height:60px;white-space:pre-wrap;"></pre>
    </div>

    <div class="card">
      <h3 style="margin-top:0;">Generate FAQs</h3>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <label>Casino name<input type="text" id="faqCasinoName" /></label>
        <label style="flex:1;min-width:220px;">Context <span style="color:var(--text-dim);font-weight:normal;">(optional)</span><input type="text" id="faqContext" /></label>
      </div>
      <button type="button" class="btn btn-small" id="genFaqBtn" style="margin-top:8px;">Generate</button>
      <div id="faqOutput" style="margin-top:10px;"></div>
    </div>

    <div class="card">
      <h3 style="margin-top:0;">Improve existing content</h3>
      <label>Content<textarea id="improveContent" style="min-height:140px;width:100%;"></textarea></label>
      <label>Improvement type
        <select id="improveType">
          <option value="readability">Readability</option>
          <option value="seo">SEO</option>
          <option value="clarity">Clarity</option>
          <option value="tone">Tone</option>
        </select>
      </label>
      <button type="button" class="btn btn-small" id="improveBtn" style="margin-top:8px;">Improve</button>
      <textarea id="improveOutput" readonly style="margin-top:10px;min-height:140px;width:100%;" placeholder="Improved text appears here…"></textarea>
    </div>

    <div class="card">
      <h3 style="margin-top:0;">Generate an article outline</h3>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <label style="flex:1;min-width:220px;">Topic<input type="text" id="outlineTopic" /></label>
        <label>Content type<input type="text" id="outlineType" value="review" style="width:120px;" /></label>
      </div>
      <button type="button" class="btn btn-small" id="genOutlineBtn" style="margin-top:8px;">Generate</button>
      <div id="outlineOutput" style="margin-top:10px;"></div>
    </div>

    <script nonce="${nonceToken()}">
      async function aiApi(path, body) {
        const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
        return res.json().catch(() => ({}));
      }
      function warnIfNotGenerated(data) {
        if (data.success && data.data && data.data.generated === false) {
          alert("The tenant's AI binding didn't return a result — check its Workers AI configuration.");
        }
      }

      document.getElementById("genReviewBtn").addEventListener("click", async () => {
        const casinoName = document.getElementById("revCasinoName").value.trim();
        const slug = document.getElementById("revSlug").value.trim();
        if (!casinoName || !slug) { alert("Casino name and slug are both required."); return; }
        const data = await aiApi("/api/ai/generate-review", {
          casinoName, slug, countryCode: document.getElementById("revCountry").value.trim() || "RW"
        });
        if (!data.success) { alert("Could not generate: " + (data.message || data.error || "unknown error")); return; }
        warnIfNotGenerated(data);
        document.getElementById("revOutput").value = (data.data && data.data.text) || "";
      });

      document.getElementById("genSeoBtn").addEventListener("click", async () => {
        const targetDomain = document.getElementById("seoDomain").value.trim();
        const slug = document.getElementById("seoSlug").value.trim();
        if (!targetDomain || !slug) { alert("Target domain and slug are both required."); return; }
        const data = await aiApi("/api/ai/generate-seo", {
          targetDomain, slug,
          type: document.getElementById("seoType").value.trim() || "casino",
          country: document.getElementById("seoCountryLabel").value.trim() || "Global"
        });
        if (!data.success) { alert("Could not generate: " + (data.message || data.error || "unknown error")); return; }
        warnIfNotGenerated(data);
        const seo = (data.data && data.data.seo) || null;
        document.getElementById("seoOutput").textContent = seo ? ("Title: " + seo.title + "\\n\\nDescription: " + seo.description) : "";
      });

      document.getElementById("genFaqBtn").addEventListener("click", async () => {
        const casinoName = document.getElementById("faqCasinoName").value.trim();
        if (!casinoName) { alert("Casino name is required."); return; }
        const data = await aiApi("/api/ai/generate-faqs", { casinoName, context: document.getElementById("faqContext").value.trim() });
        if (!data.success) { alert("Could not generate: " + (data.message || data.error || "unknown error")); return; }
        warnIfNotGenerated(data);
        const faqs = (data.data && data.data.faqs) || [];
        document.getElementById("faqOutput").innerHTML = faqs.length
          ? faqs.map((f) => "<p><strong>" + (f.q || "").replace(/</g, "&lt;") + "</strong><br>" + (f.a || "").replace(/</g, "&lt;") + "</p>").join("")
          : "<p class=\\"empty\\">No FAQs generated.</p>";
      });

      document.getElementById("improveBtn").addEventListener("click", async () => {
        const content = document.getElementById("improveContent").value.trim();
        if (!content) { alert("Paste some content first."); return; }
        const data = await aiApi("/api/ai/improve-content", { content, improvementType: document.getElementById("improveType").value });
        if (!data.success) { alert("Could not improve: " + (data.message || data.error || "unknown error")); return; }
        warnIfNotGenerated(data);
        document.getElementById("improveOutput").value = (data.data && data.data.text) || "";
      });

      document.getElementById("genOutlineBtn").addEventListener("click", async () => {
        const topic = document.getElementById("outlineTopic").value.trim();
        if (!topic) { alert("Topic is required."); return; }
        const data = await aiApi("/api/ai/generate-outline", { topic, contentType: document.getElementById("outlineType").value.trim() || "review" });
        if (!data.success) { alert("Could not generate: " + (data.message || data.error || "unknown error")); return; }
        warnIfNotGenerated(data);
        const outline = (data.data && data.data.outline) || [];
        document.getElementById("outlineOutput").innerHTML = outline.length
          ? outline.map((s) => "<p><strong>" + (s.title || "").replace(/</g, "&lt;") + "</strong><br>" + (s.points || []).map((p) => "&bull; " + p.replace(/</g, "&lt;")).join("<br>") + "</p>").join("")
          : "<p class=\\"empty\\">No outline generated.</p>";
      });
    </script>
  `;

  return renderShell({ title, activeKey, admin, bodyHtml: body, env });
}

async function resolveTenantOrNull(env, admin) {
  if (!admin.activeTenantId) return null;
  return getTenant(env, admin.activeTenantId);
}

function makeSubmitter(toolPath) {
  return async function submit(env, admin, payload) {
    const tenant = await resolveTenantOrNull(env, admin);
    if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
    return postToTenant(env, tenant, `${BASE_PATH}/${toolPath}`, payload);
  };
}

export const submitGenerateReview = makeSubmitter("generate-review");
export const submitGenerateSeoCopy = makeSubmitter("generate-seo");
export const submitGenerateFaqs = makeSubmitter("generate-faqs");
export const submitGenerateSchema = makeSubmitter("generate-schema");
export const submitGenerateOutline = makeSubmitter("generate-outline");
export const submitImproveContent = makeSubmitter("improve-content");
export const submitSuggestInternalLinks = makeSubmitter("suggest-links");

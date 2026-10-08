// =====================================================
// NEWSROOM TAGS
// Manages an article's Newsroom Taxonomy metadata + relations —
// wraps the Super API's v13 PUT /en/api/super/news/:id/newsroom-meta
// and GET/PUT .../newsroom-relations endpoints (see
// en/worker/super/handlers-newsroom.js).
//
// Lives as its own page (rather than embedded in the news edit form,
// same reasoning as review-blocks.js) because it needs its own set
// of API calls keyed by the article's NUMERIC id, whereas the
// ordinary news edit form (crud.js) operates by slug — these two
// identifiers are deliberately different (see handlers-newsroom.js's
// header comment for why setArticleMeta/setArticleRelations are
// separate tenant functions from updateNews).
//
// ARTICLE_TYPES/CONTENT_CLASSES/LABELS below are mirrored from the
// tenant's worker/database/newsroom.js vocabulary arrays (verified
// against that file) — keep these in sync if the tenant adds a new
// value to any of them.
//
// Simplifications, documented rather than hidden:
// - Entity role (per-article, e.g. "subject" vs "mentioned") is not
//   editable here — every entity checked is saved with role
//   "mentioned". Editing per-entity role would need a role dropdown
//   per checked entity; deferred until there's a real need for it.
// - primary_country is a plain dropdown over ALL countries, not
//   constrained client-side to only the countries checked below it.
//   The tenant's own setArticleRelations doesn't require
//   primary_country to be one of the checked countries either, so
//   this isn't a validation gap — just a simpler UI than a dependent
//   dropdown would be.
// - Related articles (cross-linking to other news items) is not
//   covered by this screen — it would need an article search/
//   autocomplete, not just a static option list.
// =====================================================

import { renderShell, escapeHtml } from "../layout.js";
import { getFromTenant, putToTenant } from "../../client.js";
import { getTenant } from "../../registry.js";
import { renderResourceSelectField, renderMultiSelectField } from "./crud.js";
import { nonceToken } from "../../csp.js";

const BASE_PATH = "/en/api/super";

const ARTICLE_TYPES = ["news", "analysis", "interview", "investigation", "explainer",
  "research", "opinion", "original_reporting", "press_release", "feature", "live"];
const CONTENT_CLASSES = ["editorial", "sponsored", "commercial", "press_release"];
const LABELS = ["breaking", "developing", "exclusive", "analysis", "investigation",
  "interview", "opinion", "research", "press_release"];

function plainSelectField(field, currentValue, values) {
  const current = currentValue == null ? "" : String(currentValue);
  const optionsHtml = values
    .map((v) => `<option value="${escapeHtml(v)}" ${current === v ? "selected" : ""}>${escapeHtml(v)}</option>`)
    .join("");
  return `
    <label for="${field.name}">${escapeHtml(field.label)}${field.hint ? ` <span style="color:var(--text-dim);font-weight:400;">— ${escapeHtml(field.hint)}</span>` : ""}</label>
    <select id="${field.name}" name="${field.name}">
      <option value="">— none —</option>
      ${optionsHtml}
    </select>`;
}

function errorPage(title, activeKey, admin, env, message) {
  const body = `<h1>${escapeHtml(title)}</h1><div class="flash flash-error">${escapeHtml(message)}</div>`;
  return renderShell({ title, activeKey, admin, bodyHtml: body, env });
}

export async function renderNewsroomTagsPage(env, admin, newsSlug) {
  const activeKey = "content-news";
  const title = "Newsroom tags";

  if (!admin.activeTenantId) {
    return errorPage(title, activeKey, admin, env, "No active tenant is selected. Use the switcher at the top of the page to pick one.");
  }
  const tenant = await getTenant(env, admin.activeTenantId);
  if (!tenant) return errorPage(title, activeKey, admin, env, "Active tenant no longer exists.");

  const articleResult = await getFromTenant(env, tenant, `${BASE_PATH}/news/${encodeURIComponent(newsSlug)}`);
  if (!articleResult.ok) return errorPage(title, activeKey, admin, env, "Could not load that article.");
  const article = articleResult.data.data;

  const [relationsResult, sectionsResult, topicsResult, entitiesResult, seriesResult, countriesResult] = await Promise.all([
    getFromTenant(env, tenant, `${BASE_PATH}/news/${article.id}/newsroom-relations`),
    getFromTenant(env, tenant, `${BASE_PATH}/newsroom-sections`),
    getFromTenant(env, tenant, `${BASE_PATH}/newsroom-topics`),
    getFromTenant(env, tenant, `${BASE_PATH}/newsroom-entities`),
    getFromTenant(env, tenant, `${BASE_PATH}/newsroom-series`),
    getFromTenant(env, tenant, `${BASE_PATH}/countries`)
  ]);

  if (!relationsResult.ok) {
    return errorPage(title, activeKey, admin, env, relationsResult.message || "Could not load this article's newsroom relations. If this tenant hasn't redeployed with the v13 Super API routes yet, that's why.");
  }

  const relations = relationsResult.data.data;
  const sections = sectionsResult.ok ? sectionsResult.data.data || [] : [];
  const topics = topicsResult.ok ? topicsResult.data.data || [] : [];
  const entities = entitiesResult.ok ? entitiesResult.data.data || [] : [];
  const series = seriesResult.ok ? seriesResult.data.data || [] : [];
  const countries = countriesResult.ok ? countriesResult.data.data || [] : [];

  let labels = [];
  try { labels = article.labels ? JSON.parse(article.labels) : []; } catch (_) { labels = []; }

  const body = `
    <h1>Newsroom tags</h1>
    <p class="subtitle">Content · News · Taxonomy for <strong>${escapeHtml(article.title || newsSlug)}</strong> on <strong>${escapeHtml(tenant.name)}</strong></p>

    <form id="newsroomTagsForm" class="card" style="max-width:640px;">
      <h3 style="margin-top:0;">Article metadata</h3>
      ${renderResourceSelectField({ name: "section_id", label: "Section", optionValueKey: "id", optionLabelKey: "name" }, article.section_id, sections)}
      ${plainSelectField({ name: "article_type", label: "Article type" }, article.article_type, ARTICLE_TYPES)}
      ${plainSelectField({ name: "content_class", label: "Content class", hint: "press_release requires \"PR provided by\" below" }, article.content_class, CONTENT_CLASSES)}
      ${renderMultiSelectField({ name: "labels", label: "Labels", optionValueKey: "value", optionLabelKey: "label" }, labels, LABELS.map((l) => ({ value: l, label: l })))}
      <label for="methodology">Methodology <span style="color:var(--text-dim);font-weight:400;">— optional, shown for research/investigation pieces</span></label>
      <textarea id="methodology" name="methodology">${escapeHtml(article.methodology || "")}</textarea>
      <label for="pr_provided_by">PR provided by</label>
      <input type="text" id="pr_provided_by" name="pr_provided_by" value="${escapeHtml(article.pr_provided_by || "")}" />
      <label for="pr_original_source_url">PR original source URL</label>
      <input type="text" id="pr_original_source_url" name="pr_original_source_url" value="${escapeHtml(article.pr_original_source_url || "")}" />
      <label for="pr_original_date">PR original date <span style="color:var(--text-dim);font-weight:400;">— ISO date, optional</span></label>
      <input type="text" id="pr_original_date" name="pr_original_date" value="${escapeHtml(article.pr_original_date || "")}" />

      <h3 style="border-top:1px solid var(--panel-border);margin-top:22px;padding-top:16px;">Relations</h3>
      ${renderMultiSelectField({ name: "topic_ids", label: "Topics", optionValueKey: "id", optionLabelKey: "name" }, relations.topic_ids, topics)}
      ${renderMultiSelectField({ name: "series_ids", label: "Series", optionValueKey: "id", optionLabelKey: "name" }, relations.series_ids, series)}
      ${renderMultiSelectField({ name: "entity_ids", label: "Entities", optionValueKey: "id", optionLabelKey: "name", hint: "saved with role \"mentioned\" — see note below" }, relations.entities.map((e) => e.id), entities)}
      ${renderMultiSelectField({ name: "country_codes", label: "Countries", optionValueKey: "id", optionLabelKey: "name" }, relations.countries.map((c) => c.code), countries.map((c) => ({ id: c.code, name: c.name })))}
      ${renderResourceSelectField({ name: "primary_country", label: "Primary country", optionValueKey: "code", optionLabelKey: "name" }, relations.countries.find((c) => c.is_primary)?.code || "", countries)}

      <button class="btn" type="submit" style="margin-top:16px;">Save</button>
      <a class="btn btn-secondary" href="/content/news/${encodeURIComponent(newsSlug)}/edit">Back to article</a>
    </form>

    <script nonce="${nonceToken()}">
      document.getElementById("newsroomTagsForm").addEventListener("submit", async function(e) {
        e.preventDefault();
        const fd = new FormData(e.target);
        const val = (name) => fd.get(name);
        const jsonVal = (name) => { try { return JSON.parse(fd.get(name) || "[]"); } catch (_) { return []; } };

        const metaPayload = {
          section_id: val("section_id") || null,
          article_type: val("article_type") || null,
          content_class: val("content_class") || null,
          labels: jsonVal("labels"),
          methodology: val("methodology") || null,
          pr_provided_by: val("pr_provided_by") || null,
          pr_original_source_url: val("pr_original_source_url") || null,
          pr_original_date: val("pr_original_date") || null
        };
        const relationsPayload = {
          topic_ids: jsonVal("topic_ids").map(Number),
          series_ids: jsonVal("series_ids").map(Number),
          entities: jsonVal("entity_ids").map(function(id) { return { id: Number(id), role: "mentioned" }; }),
          countries: jsonVal("country_codes").map(function(code) { return { code: code }; }),
          primary_country: val("primary_country") || null
        };

        async function put(path, body) {
          const res = await fetch(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
          const data = await res.json().catch(function() { return {}; });
          return { ok: !!data.success, message: data.message || data.error };
        }

        const metaResult = await put(${JSON.stringify(`/api/news/${article.id}/newsroom-meta`)}, metaPayload);
        if (!metaResult.ok) { alert("Could not save metadata: " + (metaResult.message || "unknown error")); return; }

        const relationsResult = await put(${JSON.stringify(`/api/news/${article.id}/newsroom-relations`)}, relationsPayload);
        if (!relationsResult.ok) { alert("Metadata saved, but relations failed: " + (relationsResult.message || "unknown error")); return; }

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

export async function submitNewsroomMeta(env, admin, newsId, payload) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return putToTenant(env, tenant, `${BASE_PATH}/news/${encodeURIComponent(newsId)}/newsroom-meta`, payload);
}

export async function submitNewsroomRelations(env, admin, newsId, payload) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return putToTenant(env, tenant, `${BASE_PATH}/news/${encodeURIComponent(newsId)}/newsroom-relations`, payload);
}

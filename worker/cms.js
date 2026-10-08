// =====================================================
// LUMMET CMS DATA LAYER
// Direct D1 reads/writes for lummet.com's own content
// (pages, authors, brands, partners, updates, publications,
// advertisements) and its homepage site settings. Every
// column allowed here comes straight from the CMS_RESOURCES
// contract in cms-resources.js — nothing outside that list
// is ever written, same discipline as the tenant's own
// settings safe-list.
// =====================================================

import { getCmsResourceConfig } from "./cms-resources.js";

function isUniqueConstraintError(err) {
  return /UNIQUE constraint failed/i.test(String(err?.message || err));
}

export async function listCmsRecords(env, resourceKey, { status } = {}) {
  const config = getCmsResourceConfig(resourceKey);
  if (!config) return { ok: false, status: 404, error: "unknown_resource" };

  let sql = `SELECT * FROM ${config.table}`;
  const binds = [];
  if (status) {
    sql += ` WHERE status = ?`;
    binds.push(status);
  }
  sql += ` ORDER BY ${config.orderBy || "id DESC"}`;

  const result = await env.LUMMET_DB.prepare(sql).bind(...binds).all();
  return { ok: true, data: result.results || [] };
}

export async function getCmsRecord(env, resourceKey, id) {
  const config = getCmsResourceConfig(resourceKey);
  if (!config) return { ok: false, status: 404, error: "unknown_resource" };

  const row = await env.LUMMET_DB.prepare(`SELECT * FROM ${config.table} WHERE id = ?`)
    .bind(id)
    .first();
  if (!row) return { ok: false, status: 404, error: "not_found" };
  return { ok: true, data: row };
}

export async function getCmsRecordBySlug(env, resourceKey, slug) {
  const config = getCmsResourceConfig(resourceKey);
  if (!config) return { ok: false, status: 404, error: "unknown_resource" };

  const row = await env.LUMMET_DB.prepare(`SELECT * FROM ${config.table} WHERE slug = ?`)
    .bind(slug)
    .first();
  if (!row) return { ok: false, status: 404, error: "not_found" };
  return { ok: true, data: row };
}

function coerceValue(field, raw) {
  if (field.type === "number") {
    // A blank number falls back to the field's declared default (columns such as
    // sort_order are NOT NULL DEFAULT 0, and an explicit NULL would be rejected).
    if (raw === "" || raw === undefined || raw === null) return field.default ?? null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (field.type === "resource_select" || field.type === "tenant_select") {
    if (raw === "" || raw === undefined || raw === null) return null;
    return raw;
  }
  if (raw === undefined) return null;
  return raw === "" ? null : raw;
}

/** Fields an admin may write. readOnly fields (e.g. a visitor's submission) are displayed but never saved. */
function writableFields(config) {
  return config.fields.filter((f) => !f.readOnly);
}

function validateAndCoerce(config, form) {
  const values = {};
  for (const field of writableFields(config)) {
    const raw = form[field.name];
    if (field.required && (raw === undefined || String(raw).trim() === "")) {
      return { ok: false, status: 422, error: "validation_error", message: `${field.label} is required.` };
    }
    values[field.name] = coerceValue(field, raw);
  }
  return { ok: true, values };
}

export async function createCmsRecord(env, resourceKey, form) {
  const config = getCmsResourceConfig(resourceKey);
  if (!config) return { ok: false, status: 404, error: "unknown_resource" };
  if (config.supportsCreate === false) return { ok: false, status: 405, error: "create_not_supported" };

  const validated = validateAndCoerce(config, form);
  if (!validated.ok) return validated;

  const columns = writableFields(config).map((f) => f.name);
  const placeholders = columns.map(() => "?").join(", ");
  const binds = columns.map((c) => validated.values[c]);

  try {
    const inserted = await env.LUMMET_DB.prepare(
      `INSERT INTO ${config.table} (${columns.join(", ")}) VALUES (${placeholders}) RETURNING id`
    ).bind(...binds).first();
    return { ok: true, id: inserted?.id ?? null };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { ok: false, status: 409, error: "slug_already_used", message: "That slug is already in use." };
    }
    return { ok: false, status: 500, error: "database_error", message: String(err?.message || err) };
  }
}

export async function updateCmsRecord(env, resourceKey, id, form) {
  const config = getCmsResourceConfig(resourceKey);
  if (!config) return { ok: false, status: 404, error: "unknown_resource" };

  const validated = validateAndCoerce(config, form);
  if (!validated.ok) return validated;

  const columns = writableFields(config).map((f) => f.name);
  const setClause = columns.map((c) => `${c} = ?`).join(", ");
  const binds = columns.map((c) => validated.values[c]);
  binds.push(id);

  try {
    await env.LUMMET_DB.prepare(
      `UPDATE ${config.table} SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(...binds).run();
    return { ok: true };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { ok: false, status: 409, error: "slug_already_used", message: "That slug is already in use." };
    }
    return { ok: false, status: 500, error: "database_error", message: String(err?.message || err) };
  }
}

export async function deleteCmsRecord(env, resourceKey, id) {
  const config = getCmsResourceConfig(resourceKey);
  if (!config) return { ok: false, status: 404, error: "unknown_resource" };

  await env.LUMMET_DB.prepare(`DELETE FROM ${config.table} WHERE id = ?`).bind(id).run();
  return { ok: true };
}

// -----------------------------------------------------
// Homepage / site-wide settings (key/value, same shape as
// the tenant's own `settings` table)
// -----------------------------------------------------

export const SITE_SETTING_KEYS = [
  "site_name",
  "site_title",
  "site_description",
  "canonical_url",
  "og_image",
  "logo_url",
  "accent_color",
  "accent_color_secondary",
  "hero_eyebrow",
  "hero_title",
  "hero_subtitle",
  "hero_cta_primary_label",
  "hero_cta_primary_href",
  "hero_cta_secondary_label",
  "hero_cta_secondary_href",
  "contact_email",
  "footer_text",
  "brands_title",
  "brands_intro",
  "updates_title",
  "updates_intro",
  "insights_title",
  "insights_intro",
  "partners_title",
  "partners_intro",
  "inquiry_rate_limit_per_hour"
];

export async function getSiteSettings(env) {
  const result = await env.LUMMET_DB.prepare(`SELECT key, value FROM lummet_site_settings`).all();
  const out = {};
  for (const row of result.results || []) out[row.key] = row.value;
  return out;
}

export async function setSiteSettings(env, updates) {
  const statements = [];
  for (const key of SITE_SETTING_KEYS) {
    if (!(key in updates)) continue;
    statements.push(
      env.LUMMET_DB.prepare(
        `INSERT INTO lummet_site_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
      ).bind(key, updates[key] === "" ? null : updates[key])
    );
  }
  if (statements.length) await env.LUMMET_DB.batch(statements);
  return { ok: true };
}

// -----------------------------------------------------
// Public helpers — what the live lummet.com site (home.js,
// /p/:slug) actually reads. Always filtered to published/
// active status; never exposes drafts.
// -----------------------------------------------------

export async function listPublished(env, resourceKey, limit = 20) {
  const config = getCmsResourceConfig(resourceKey);
  if (!config) return [];
  const statusValue = resourceKey === "advertisements" ? "active" : "published";
  const result = await env.LUMMET_DB.prepare(
    `SELECT * FROM ${config.table} WHERE status = ? ORDER BY ${config.orderBy || "id DESC"} LIMIT ?`
  ).bind(statusValue, limit).all();
  return result.results || [];
}

export async function getPublishedBySlug(env, resourceKey, slug) {
  const config = getCmsResourceConfig(resourceKey);
  if (!config) return null;
  return env.LUMMET_DB.prepare(
    `SELECT * FROM ${config.table} WHERE slug = ? AND status = 'published'`
  ).bind(slug).first();
}

export async function listActiveAdsForPlacement(env, placement) {
  const nowIso = new Date().toISOString().slice(0, 10);
  const result = await env.LUMMET_DB.prepare(
    `SELECT * FROM lummet_advertisements
     WHERE placement = ? AND status = 'active'
       AND (start_date IS NULL OR start_date <= ?)
       AND (end_date IS NULL OR end_date >= ?)
     ORDER BY sort_order`
  ).bind(placement, nowIso, nowIso).all();
  return result.results || [];
}

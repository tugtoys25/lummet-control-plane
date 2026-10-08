// =====================================================
// PUBLIC SITE — FORMS (/contact, /demo, /forms/:key)
//
// Everything a visitor sees comes from the database:
//   lummet_forms        title, intro, button label, success message, side panel, SEO
//   lummet_form_fields  the fields, their order, labels, types, required flags, select options
//   lummet_ui_strings   validation messages and generic labels
// Submissions are stored in lummet_inquiries and managed from the dashboard
// (Lummet Site -> Inquiries). Optionally a notification is POSTed to the URL in
// the INQUIRY_WEBHOOK_URL secret (Slack / Discord / any JSON webhook).
//
// Abuse protection (no third-party service, no cookies):
//   * same-origin check (Origin / Sec-Fetch-Site) instead of a CSRF token,
//     because the form has no session to protect
//   * hidden honeypot field: bots that fill it get a fake "success" and nothing is stored
//   * per-IP hourly limit (hashed IP, setting inquiry_rate_limit_per_hour)
//   * request, field and total size limits
// =====================================================

import * as data from "./data.js";
import { hashIPForRateLimit } from "../auth.js";
import { sanitizeHtml } from "./sanitize.js";
import { renderPage, textResponse } from "./render.js";
import { buildHead, breadcrumbLd, organizationLd, absoluteUrl } from "./seo.js";
import { stripTags, truncate, safeUrl, fill } from "./format.js";

export const HONEYPOT_FIELD = "hp_website";
const DEFAULT_RATE_LIMIT_PER_HOUR = 5;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TOTAL_CHARS = 20000;

const INPUT_TYPES = { text: "text", email: "email", tel: "tel", url: "url" };
const AUTOCOMPLETE = { name: "name", email: "email", company: "organization", organization: "organization", role: "organization-title", phone: "tel", tel: "tel" };

export function formPath(key) {
  return key === "contact" || key === "demo" ? `/${key}` : `/forms/${key}`;
}

function parseOptions(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((o) => o.trim())
    .filter(Boolean);
}

function cleanValue(raw, multiline) {
  let v = String(raw ?? "").replace(/\r\n?/g, "\n");
  v = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  if (!multiline) v = v.replace(/\n+/g, " ");
  return v.trim();
}

/** Turn the DB field rows into view models (with the visitor's values and errors merged in). */
function fieldViews(fields, values = {}, errors = {}, formKey) {
  return fields.map((f) => {
    const type = f.type === "textarea" || f.type === "select" ? f.type : INPUT_TYPES[f.type] ? f.type : "text";
    const options = type === "select" ? parseOptions(f.options) : [];
    const value = values[f.field_key] ?? "";
    const id = `${formKey}-${f.field_key}`;
    return {
      key: f.field_key,
      id,
      name: `f_${f.field_key}`,
      label: f.label,
      required: Boolean(f.required),
      placeholder: f.placeholder || "",
      help_text: f.help_text || "",
      max_length: f.max_length || 2000,
      value,
      error: errors[f.field_key] || "",
      has_error: Boolean(errors[f.field_key]),
      is_textarea: type === "textarea",
      is_select: type === "select",
      input_type: INPUT_TYPES[type] || "text",
      autocomplete: AUTOCOMPLETE[f.field_key] || "off",
      options: options.map((o) => ({ value: o, label: o, selected: o === value }))
    };
  });
}

export function validateSubmission(fields, formData, ui) {
  const values = {};
  const errors = {};
  let total = 0;
  for (const f of fields) {
    const multiline = f.type === "textarea";
    const value = cleanValue(formData.get(`f_${f.field_key}`), multiline);
    values[f.field_key] = value;
    total += value.length;

    if (!value) {
      if (f.required) errors[f.field_key] = ui.err_required || "";
      continue;
    }
    if (value.length > (f.max_length || 2000)) {
      errors[f.field_key] = ui.err_too_long || "";
    } else if (f.type === "email" && !(value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) {
      errors[f.field_key] = ui.err_email || "";
    } else if (f.type === "url" && !/^https?:\/\/\S+$/i.test(value)) {
      errors[f.field_key] = ui.err_url || "";
    } else if (f.type === "select" && !parseOptions(f.options).includes(value)) {
      errors[f.field_key] = ui.err_option || "";
    }
  }
  if (total > MAX_TOTAL_CHARS) {
    const first = fields[0]?.field_key;
    if (first) errors[first] = ui.err_too_large || "";
  }
  return { values, errors, ok: Object.keys(errors).length === 0 };
}

/** What gets stored: queryable columns plus a readable record that survives later field edits. */
export function buildInquiryRecord(formKey, fields, values) {
  const emailField = fields.find((f) => f.type === "email");
  const nameField = fields.find((f) => f.field_key === "name");
  const summaryField = fields.find((f) => f.field_key === "message") || fields.find((f) => f.type === "textarea");
  const rows = fields
    .filter((f) => values[f.field_key])
    .map((f) => ({ key: f.field_key, label: f.label, value: values[f.field_key] }));
  const details = rows.map((r) => (r.value.includes("\n") ? `${r.label}:\n${r.value}` : `${r.label}: ${r.value}`)).join("\n\n");
  const summarySource = (summaryField && values[summaryField.field_key]) || rows.find((r) => r.key !== "name" && r.key !== "email")?.value || "";
  return {
    form_key: formKey,
    name: nameField ? values[nameField.field_key] || null : null,
    email: emailField ? values[emailField.field_key] || null : null,
    summary: truncate(summarySource.replace(/\s+/g, " "), 140) || null,
    details,
    payload: JSON.stringify({ fields: rows })
  };
}

function sqliteTimestamp(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function sameOrigin(request, url) {
  const origin = request.headers.get("origin");
  if (origin && origin !== "null") return origin === url.origin;
  if (origin === "null") return false;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  return true;
}

async function notify(ctx, record, id) {
  const hook = ctx.env.INQUIRY_WEBHOOK_URL;
  if (!hook || !/^https:\/\//i.test(hook)) return;
  const who = [record.name, record.email].filter(Boolean).join(" ");
  const text = `New ${record.form_key} inquiry #${id}${who ? ` from ${who}` : ""}${record.summary ? `: ${record.summary}` : ""}`;
  const send = fetch(hook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, content: text, form: record.form_key, id, name: record.name, email: record.email, summary: record.summary })
  }).catch((err) => console.error("inquiry webhook failed:", err?.message || err));
  if (ctx.execCtx?.waitUntil) ctx.execCtx.waitUntil(send);
  else await send;
}

// ---------------------------------------------------------------- GET

async function renderForm(ctx, { key, form, fields, values = {}, errors = {}, sent = false, status = 200, banner = "" }) {
  const { site, ui } = ctx.siteCtx;
  const path = formPath(key);
  const introHtml = sanitizeHtml(form.intro || "");
  const hasErrors = Object.keys(errors).length > 0;
  const trail = [
    { label: ui.crumb_home, href: "/" },
    { label: form.title, href: path }
  ].map((c, i, a) => ({ ...c, last: i === a.length - 1 }));

  const sideBody = sanitizeHtml(form.side_body || "");
  const description = form.seo_description || truncate(stripTags(introHtml), 170);
  const head = buildHead({
    site,
    title: form.seo_title || form.title,
    description,
    path,
    image: safeUrl(form.og_image),
    noindex: sent || status !== 200,
    jsonLd: [
      organizationLd(site),
      { "@type": "ContactPage", name: form.title, url: absoluteUrl(site, path), description },
      breadcrumbLd(site, trail.map((t) => ({ label: t.label, href: t.href })))
    ]
  });

  const response = await renderPage(ctx, {
    template: "form",
    data: {
      form: {
        key,
        action: path,
        eyebrow: form.eyebrow || "",
        title: form.title,
        intro_html: introHtml,
        submit_label: form.submit_label,
        success_title: form.success_title,
        success_html: sanitizeHtml(form.success_message || ""),
        side_title: form.side_title || "",
        side_html: sideBody,
        has_side: Boolean(form.side_title || sideBody || site.has_contact)
      },
      fields: fieldViews(fields, values, errors, key),
      has_fields: fields.length > 0,
      sent,
      banner,
      has_errors: hasErrors,
      honeypot: HONEYPOT_FIELD,
      crumbs: trail
    },
    head,
    status,
    bodyClass: "page-form"
  });
  if (sent || status !== 200) {
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  }
  return response;
}

export async function formPage(ctx, { key }) {
  const form = await data.getForm(ctx.env, key);
  if (!form) return null;
  const fields = await data.listFormFields(ctx.env, key);
  return renderForm(ctx, { key, form, fields, sent: ctx.url.searchParams.get("sent") === "1" && fields.length > 0 });
}

// --------------------------------------------------------------- POST

export async function submitForm(ctx, { key }) {
  const { env, request, url } = ctx;
  const { ui, settings } = ctx.siteCtx;
  const form = await data.getForm(env, key);
  if (!form) return null;
  const fields = await data.listFormFields(env, key);
  if (!fields.length) return null;

  const fail = (status, message, extra = {}) =>
    renderForm(ctx, { key, form, fields, status, banner: message, ...extra });

  if (!sameOrigin(request, url)) return fail(403, ui.err_generic || "");

  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) return fail(413, ui.err_too_large || "");
  const type = (request.headers.get("content-type") || "").toLowerCase();
  if (!type.includes("application/x-www-form-urlencoded") && !type.includes("multipart/form-data")) {
    return fail(415, ui.err_generic || "");
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return fail(400, ui.err_generic || "");
  }

  const redirectToSent = () =>
    new Response(null, {
      status: 303,
      headers: { location: `${formPath(key)}?sent=1`, "cache-control": "no-store" }
    });

  // Honeypot: a human never sees this field. Pretend it worked, store nothing.
  if (String(formData.get(HONEYPOT_FIELD) || "").trim() !== "") return redirectToSent();

  const { values, errors, ok } = validateSubmission(fields, formData, ui);
  if (!ok) return fail(422, ui.form_errors_summary || "", { values, errors });

  const limit = Number(settings.inquiry_rate_limit_per_hour) > 0 ? Number(settings.inquiry_rate_limit_per_hour) : DEFAULT_RATE_LIMIT_PER_HOUR;
  const ipHash = (await hashIPForRateLimit(request)) || "";
  // Behind Cloudflare the header is always present. Without it (local dev) visitors
  // cannot be told apart, so the per-IP limit is skipped rather than shared by everyone.
  if (ipHash) {
    const recent = await data.countRecentInquiriesByIp(env, ipHash, sqliteTimestamp(Date.now() - 60 * 60 * 1000));
    if (recent >= limit) return fail(429, ui.err_rate || "", { values });
  }

  const record = buildInquiryRecord(key, fields, values);
  let id;
  try {
    id = await data.insertInquiry(env, { ...record, ip_hash: ipHash });
  } catch (err) {
    console.error("inquiry insert failed:", err?.message || err);
    return fail(500, ui.err_generic || "", { values });
  }
  await notify(ctx, record, id);
  return redirectToSent();
}

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
import { escapeHtml } from "./template.js";
import { buildHead, breadcrumbLd, organizationLd, absoluteUrl } from "./seo.js";
import { stripTags, truncate, safeUrl, fill } from "./format.js";
import { demoPlans } from "./demo-plans.js";
import { BUY_FORM_KEY, SELL_FORM_KEY, OTHER_OPTION, normalizeDomain, withDomainOptions, subjectFromRequest } from "./aftermarket-domains.js";

export const HONEYPOT_FIELD = "hp_website";
const DEFAULT_RATE_LIMIT_PER_HOUR = 5;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TOTAL_CHARS = 20000;

const INPUT_TYPES = { text: "text", email: "email", tel: "tel", url: "url" };
const AUTOCOMPLETE = { name: "name", email: "email", company: "organization", organization: "organization", role: "organization-title", phone: "tel", tel: "tel" };

export const CONTACT_SALES_KEY = "contact-sales";

export function formPath(key) {
  return key === "contact" || key === "demo" || key === CONTACT_SALES_KEY ? `/${key}` : `/forms/${key}`;
}

// Every public form carries the optional Turnstile check (PUBLIC_FORMS_TURNSTILE_REQUIRED): /contact, /demo, /contact-sales and the custom
// /forms/:key forms made in the dashboard. /contact-sales has always been protected like /contact; giving it its own record key (H.5)
// must not drop that.
const turnstileOn = (env) => String(env.PUBLIC_FORMS_TURNSTILE_REQUIRED || "off").toLowerCase() === "on";

/**
 * The form record and fields to show for `key`. /contact-sales (H.5) stores its inquiries under its own key `contact-sales`, so sales
 * enquiries are no longer mixed into /contact in the inbox. Until the owner creates a `contact-sales` form in the dashboard, the
 * wording and fields come from `fallbackKey` (`contact`), which is exactly what the page showed before. No migration is involved.
 */
async function resolveForm(env, key, fallbackKey = null) {
  let form = await data.getForm(env, key);
  let fields = form ? await data.listFormFields(env, key) : [];
  if ((!form || !fields.length) && fallbackKey) {
    const fbForm = await data.getForm(env, fallbackKey);
    const fbFields = fbForm ? await data.listFormFields(env, fallbackKey) : [];
    if (fbForm && fbFields.length) { form = fbForm; fields = fbFields; }
  }
  return { form, fields };
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
function fieldViews(fields, values = {}, errors = {}, formKey, ui = {}) {
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
      options: options.map((o) => ({ value: o, label: o === OTHER_OPTION && f.field_key === "domain" ? ui.aftermarket_other_option || o : o, selected: o === value }))
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
const ATTRIBUTION_KEYS = ["source", "medium", "campaign", "referrer"];

/** The hidden _attr field comes from the visitor's browser: keep only known keys and plain characters, bounded in size. */
export function cleanAttribution(raw) {
  const out = {};
  for (const part of String(raw || "").slice(0, 400).split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const key = part.slice(0, i).trim().toLowerCase();
    if (!ATTRIBUTION_KEYS.includes(key)) continue;
    const value = part.slice(i + 1).trim().replace(/[^A-Za-z0-9._~:/ +-]/g, "").slice(0, 80);
    if (value) out[key] = value;
  }
  return out;
}

export function buildInquiryRecord(formKey, fields, values, extra = {}) {
  const emailField = fields.find((f) => f.type === "email");
  const nameField = fields.find((f) => f.field_key === "name");
  const summaryField = fields.find((f) => f.field_key === "message") || fields.find((f) => f.type === "textarea");
  const rows = fields
    .filter((f) => values[f.field_key])
    .map((f) => ({ key: f.field_key, label: f.label, value: values[f.field_key] }));
  const details = rows.map((r) => (r.value.includes("\n") ? `${r.label}:\n${r.value}` : `${r.label}: ${r.value}`)).join("\n\n");
  const summarySource = (summaryField && values[summaryField.field_key]) || rows.find((r) => r.key !== "name" && r.key !== "email")?.value || "";
  // Domain enquiries: the domain the visitor chose (or typed under Other) is stored on its own, so the inbox can show and count
  // "who wants which domain", and the page they came from (redirect | host | landing | list) is kept next to it.
  let subjectRef = null;
  if (formKey === BUY_FORM_KEY) {
    const chosen = values.domain === OTHER_OPTION ? values.domain_other : values.domain || values.domain_other;
    subjectRef = normalizeDomain(chosen) || normalizeDomain(extra.subject) || null;
  } else if (formKey === SELL_FORM_KEY) {
    subjectRef = normalizeDomain(values.domain) || null;
  } else if (extra.subjectRef) {
    subjectRef = extra.subjectRef;                     // a business listing: "listing:<slug>"
  } else if (extra.subject) {
    subjectRef = normalizeDomain(extra.subject) || null;
  }
  const attribution = extra.attribution && Object.keys(extra.attribution).length ? Object.entries(extra.attribution).map(([k, v]) => `${k}=${v}`).join(", ") : "";
  const summaryText = truncate(summarySource.replace(/\s+/g, " "), 140) || null;
  return {
    form_key: formKey,
    name: nameField ? values[nameField.field_key] || null : null,
    email: emailField ? values[emailField.field_key] || null : null,
    summary: subjectRef ? truncate(`${extra.subjectLabel || subjectRef}${summaryText ? ` - ${summaryText}` : ""}`, 140) : summaryText,
    details: [details, extra.source ? `Source: ${extra.source}` : "", attribution ? `Came from: ${attribution}` : ""].filter(Boolean).join("\n\n"),
    payload: JSON.stringify({ fields: rows, subject: subjectRef, source: extra.source || null, attribution: extra.attribution || null }),
    subject_ref: subjectRef,
    source: extra.source || null
  };
}

function sqliteTimestamp(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

export function sameOrigin(request, url) {
  const origin = request.headers.get("origin");
  if (origin && origin !== "null") return origin === url.origin;
  if (origin === "null") return false;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  return true;
}

export async function notify(ctx, record, id) {
  const hook = ctx.env.INQUIRY_WEBHOOK_URL;
  if (!hook || !/^https:\/\//i.test(hook)) return;
  const who = [record.name, record.email].filter(Boolean).join(" ");
  const text = `New ${record.form_key} inquiry #${id}${record.subject_ref ? ` about ${record.subject_ref}` : ""}${who ? ` from ${who}` : ""}${record.summary ? `: ${record.summary}` : ""}`;
  const send = fetch(hook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, content: text, form: record.form_key, id, name: record.name, email: record.email, summary: record.summary })
  }).catch((err) => console.error("inquiry webhook failed:", err?.message || err));
  if (ctx.execCtx?.waitUntil) ctx.execCtx.waitUntil(send);
  else await send;
}

// ---------------------------------------------------------------- GET

async function renderForm(ctx, { key, path: pathOverride, form: formRow, fields, values = {}, errors = {}, sent = false, status = 200, banner = "", subject = null, source = null, hooks = null }) {
  const { site, ui } = ctx.siteCtx;
  // A domain for sale (redirect, its own host, or its landing page): the header says so and the select starts on that domain.
  let form = formRow;
  let listing = null;
  if (subject && subject.kind === "listing") {
    // A business for sale: its own title and facts; the enquiry form below is the same one the domains use.
    const r = subject.row;
    form = { ...formRow, title: r.title, seo_title: r.title, intro: `<p>${escapeHtml(r.summary || "")}</p>`, seo_description: truncate(r.summary || "", 170) };
    const facts = [
      [ui.listing_fact_category, r.category_name], [ui.listing_fact_location, r.location], [ui.listing_fact_revenue, r.revenue], [ui.listing_fact_profit, r.profit]
    ].filter(([, v]) => String(v || "").trim()).map(([label, value]) => ({ label, value: String(value).trim() }));
    listing = { headline: "", description: String(r.description || "").trim(), price: String(r.asking_price || "").trim() || ui.aftermarket_price_on_request, buy_url: "", has_buy: false, facts, has_facts: facts.length > 0, list_href: "/aftermarket/businesses", all_label: ui.listing_all };
  } else if (subject) {
    const title = fill(ui.aftermarket_for_sale_title, { domain: subject.domain });
    form = { ...formRow, title, seo_title: title, intro: `<p>${escapeHtml(fill(ui.aftermarket_for_sale_intro, { domain: subject.domain }))}</p>` };
    const price = String(subject.row?.asking_price || "").trim();
    const buyUrl = /^https:\/\//i.test(subject.row?.buy_url || "") ? subject.row.buy_url : "";
    listing = { domain: subject.domain, headline: String(subject.row?.headline || "").trim(), description: String(subject.row?.description || "").trim(), price: price || ui.aftermarket_price_on_request, buy_url: buyUrl, has_buy: Boolean(buyUrl), list_href: "/aftermarket/list-of-domains", all_label: ui.aftermarket_all_domains };
    if (!("domain" in values) && !sent) values = { ...values, domain: subject.domain };
  }
  const path = pathOverride || formPath(key);
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
    noindex: sent || status !== 200 || (subject ? subject.source === "redirect" : Boolean(pathOverride) && String(ctx.env.PUBLIC_TRUST_PAGES || "off").trim().toLowerCase() !== "on"),
    jsonLd: [
      organizationLd(site),
      { "@type": "ContactPage", name: form.title, url: absoluteUrl(site, path), description },
      breadcrumbLd(site, trail.map((t) => ({ label: t.label, href: t.href })))
    ]
  });

  // /demo only (not its trust-page aliases), and not on the "thanks" page: the plans under the form.
  const demo_plans = key === "demo" && !pathOverride && !sent && status === 200 ? await demoPlans(ctx) : null;

  const response = await renderPage(ctx, {
    template: "form",
    data: {
      demo_plans,
      form: {
        key,
        action: subject && subject.source === "redirect" ? `${path}?domain=${encodeURIComponent(subject.domain)}` : path,
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
      listing,
      fields: fieldViews(fields, values, errors, key, ui),
      has_fields: fields.length > 0,
      sent,
      banner,
      has_errors: hasErrors,
      honeypot: HONEYPOT_FIELD,
      turnstile: {
        required: turnstileOn(ctx.env),
        enabled: turnstileOn(ctx.env) && Boolean(ctx.env.TURNSTILE_SITE_KEY && ctx.env.TURNSTILE_SECRET_KEY),
        misconfigured: turnstileOn(ctx.env) && !(ctx.env.TURNSTILE_SITE_KEY && ctx.env.TURNSTILE_SECRET_KEY),
        siteKey: String(ctx.env.TURNSTILE_SITE_KEY || "")
      },
      crumbs: trail
    },
    head,
    status,
    form: true,
    bodyClass: "page-form"
  });
  if (sent || status !== 200) {
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  }
  return response;
}

export async function formPage(ctx, { key, path, fallbackKey = null, subject }) {
  const resolved = await resolveForm(ctx.env, key, fallbackKey);
  const { form } = resolved;
  if (!form) return null;
  if (subject === undefined) subject = key === BUY_FORM_KEY ? await subjectFromRequest(ctx) : null;
  const fields = await withDomainOptions(ctx.env, key, resolved.fields, subject);
  return renderForm(ctx, { key, path, form, fields, subject, sent: ctx.url.searchParams.get("sent") === "1" && fields.length > 0 });
}

// --------------------------------------------------------------- POST

/**
 * hooks (used by the seller form): validate(ctx, values) -> { field: message } to refuse a submission before anything is stored;
 * after(ctx, { values, id, record }) -> Response to send instead of the usual "sent" redirect.
 */
export async function submitForm(ctx, { key, path, fallbackKey = null, subject, hooks = null }) {
  const { env, request, url } = ctx;
  const { ui, settings } = ctx.siteCtx;
  const resolved = await resolveForm(env, key, fallbackKey);
  const { form } = resolved;
  if (!form) return null;
  if (subject === undefined) subject = key === BUY_FORM_KEY ? await subjectFromRequest(ctx) : null;
  const fields = await withDomainOptions(env, key, resolved.fields, subject);
  if (!fields.length) return null;
  const source = subject?.source || (key === BUY_FORM_KEY ? "form" : null);

  const fail = (status, message, extra = {}) =>
    renderForm(ctx, { key, path, form, fields, status, banner: message, subject, source, ...extra });

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
      headers: { location: `${path || formPath(key)}?sent=1`, "cache-control": "no-store" }
    });

  // Honeypot: a human never sees this field. Pretend it worked, store nothing.
  if (String(formData.get(HONEYPOT_FIELD) || "").trim() !== "") return redirectToSent();

  // Public form bot protection (contact, demo, contact-sales and every custom /forms/:key form) is opt-in and fail-closed.
  // No token is ever logged or persisted.
  if (turnstileOn(env)) {
    const token = String(formData.get("cf-turnstile-response") || "").trim();
    if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY || !token) {
      return fail(503, "This form is temporarily unavailable because bot protection is not configured. Please contact support directly.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: request.headers.get("CF-Connecting-IP") || "" }),
        signal: controller.signal
      });
      if (!verify.ok) return fail(503, "Bot protection could not be verified. Please try again or contact support directly.");
      const result = await verify.json();
      if (result.success !== true || result.hostname !== url.hostname) return fail(422, "Please complete the bot-protection check and submit again.");
    } catch {
      return fail(503, "Bot protection could not be verified. Please try again or contact support directly.");
    } finally { clearTimeout(timeout); }
  }

  const { values, errors } = validateSubmission(fields, formData, ui);
  if (key === BUY_FORM_KEY && fields.some((f) => f.field_key === "domain_other")) {
    if (values.domain === OTHER_OPTION) {
      if (!normalizeDomain(values.domain_other)) errors.domain_other = ui.aftermarket_err_other || ui.err_required || "";
    } else {
      values.domain_other = "";
      delete errors.domain_other;
    }
  }
  if (hooks?.validate && Object.keys(errors).length === 0) Object.assign(errors, (await hooks.validate(ctx, values)) || {});
  if (Object.keys(errors).length) return fail(422, ui.form_errors_summary || "", { values, errors });

  const limit = Number(settings.inquiry_rate_limit_per_hour) > 0 ? Number(settings.inquiry_rate_limit_per_hour) : DEFAULT_RATE_LIMIT_PER_HOUR;
  const ipHash = (await hashIPForRateLimit(request)) || "";
  // Behind Cloudflare the header is always present. Without it (local dev) visitors
  // cannot be told apart, so the per-IP limit is skipped rather than shared by everyone.
  if (ipHash) {
    const recent = await data.countRecentInquiriesByIp(env, ipHash, sqliteTimestamp(Date.now() - 60 * 60 * 1000));
    if (recent >= limit) return fail(429, ui.err_rate || "", { values });
  }

  const record = buildInquiryRecord(key, fields, values, { subject: subject?.domain, subjectRef: subject?.ref, subjectLabel: subject?.kind === "listing" ? subject.row?.title : null, source, attribution: cleanAttribution(formData.get("_attr")) });
  let id;
  try {
    id = await data.insertInquiry(env, { ...record, ip_hash: ipHash });
  } catch (err) {
    console.error("inquiry insert failed:", err?.message || err);
    return fail(500, ui.err_generic || "", { values });
  }
  await notify(ctx, record, id);
  if (hooks?.after) {
    const custom = await hooks.after(ctx, { values, id, record });
    if (custom) return custom;
  }
  return redirectToSent();
}

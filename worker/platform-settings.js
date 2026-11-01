// =====================================================
// PLATFORM SETTINGS: staff console first, wrangler.jsonc second, built-in default last.
//
// Precedence for every managed key:
//   1. a value a staff member saved in the console (table platform_settings, migration 0075)
//   2. the Worker var of the same name in wrangler.jsonc (or the dashboard)
//   3. the default written in the code that reads it
// Clearing a setting in the console deletes the row, so the wrangler value applies again.
//
// HOW IT WORKS WITHOUT TOUCHING THE CODE THAT READS CONFIG. The Worker reads settings synchronously as env.BILLING_ENFORCE and so on,
// in dozens of places. fetch(), scheduled() and queue() call withPlatformSettings(env) once, which returns a copy of env with the staff
// values laid over it. Everything downstream sees the staff value first and needs no change.
//
// WHAT IS MANAGEABLE. Only keys listed in SETTINGS. Never: secrets (STRIPE_SECRET_KEY, CREDENTIAL_KEK, RESEND_API_KEY, NOWPAYMENTS_*,
// TURNSTILE_SECRET_KEY, ...) and bindings (LUMMET_DB, BACKUPS, ...). Also kept in wrangler.jsonc on purpose (NOT_MANAGEABLE below):
// settings where a wrong value can lock staff out of the console that would be used to fix it. A row in platform_settings for a key that
// is not in SETTINGS is ignored, so the table can never override anything outside the list.
//
// FAIL SOFT. If the table is missing or unreadable, env is returned unchanged (wrangler values apply) and the failure is logged once per
// window. Reading settings never blocks a request.
//
// FRESHNESS. Each isolate caches the staff values for 15 seconds, so a change reaches every edge location within about that time. A save
// or clear in the isolate that handled it is visible at once.
// =====================================================

import * as repo from "./repositories/platform-settings.js";

const BASE = Symbol.for("lummet.platformSettings.base");
const CACHE_MS = 15_000;
const FAILURE_MS = 5_000;

const ON_OFF = ["off", "on"];
const TRI = ["off", "shadow", "on"];
const ENFORCE = ["off", "shadow", "enforce"];
const YES_NO = ["yes", "no"];

function def(key, group, type, opts = {}) {
  return { key, group, type, ...opts };
}

/** The settings a staff member can manage. `default` is shown when neither the console nor wrangler sets the key. */
export const SETTINGS = [
  // ---- Billing ----
  def("BILLING_ENFORCE", "Billing", "enum", { options: ENFORCE, default: "off", help: "Rollout flag for the billing lifecycle: off, shadow (record what would happen) or enforce." }),
  def("BILLING_SUSPEND_SITES", "Billing", "enum", { options: ENFORCE, default: "off", help: "Push a suspended or closed state to customer sites. Use enforce only once the tenant-edge serve gate exists." }),
  def("BILLING_EMAILS", "Billing", "enum", { options: TRI, default: "off", help: "Billing emails: off, shadow (decide and log, send nothing) or on." }),
  def("CARD_REQUIRED_TRIAL", "Billing", "enum", { options: ON_OFF, default: "off", help: "on = a trial can only start through Stripe Checkout (card up front)." }),
  def("BILLING_SAVE_FLOW", "Billing", "enum", { options: ON_OFF, default: "off", help: "Cancellation save flow (pause and resume offers)." }),
  def("BILLING_RENEWAL_NOTICES", "Billing", "enum", { options: ["yearly", "all", "off"], default: "yearly", help: "Which renewals get a reminder email." }),
  def("BILLING_WINBACK_EMAILS", "Billing", "enum", { options: ON_OFF, default: "off", help: "Promotional win-back emails. Needs an unsubscribe path first." }),
  def("BILLING_TRIAL_DAYS_DEFAULT", "Billing", "int", { min: 0, max: 3650, default: "7", help: "Trial length in days for every plan that offers a trial; changes the pricing page, billing page, Checkout and emails together. Empty or 0 = use each plan's own trial days." }),
  def("BILLING_GRACE_DAYS", "Billing", "int", { min: 0, max: 3650, default: "14", help: "Days from past due to restricted." }),
  def("BILLING_RESTRICTED_DAYS", "Billing", "int", { min: 0, max: 3650, default: "7", help: "Days restricted before suspended; also how long an expired trial stays live." }),
  def("BILLING_SUSPENDED_DAYS", "Billing", "int", { min: 0, max: 3650, default: "30", help: "Days suspended before closed." }),
  def("BILLING_REMINDER_DAYS", "Billing", "csvInt", { min: 0, max: 365, default: "3,1", help: "Days before a trial end, renewal, grace end or deletion to remind, e.g. 3,1." }),
  def("PAYMENT_GATEWAYS", "Billing", "csvEnum", { options: ["stripe", "nowpayments"], allowNone: true, default: "", help: "Gateways that are ON, in the order offered. Tick the boxes (or All on / All off) and save. All off (none) refuses new checkouts; existing subscriptions are untouched. Clearing the console value = the database switch decides." }),
  def("STRIPE_API_VERSION", "Billing", "text", { max: 40, pattern: /^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/, default: "", help: "Stripe API version for general calls, e.g. 2024-06-20." }),
  def("STRIPE_CHECKOUT_API_VERSION", "Billing", "text", { max: 40, pattern: /^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/, default: "", help: "Stripe API version for Checkout Sessions, e.g. 2025-03-31.basil." }),
  def("STRIPE_TAX_ENABLED", "Billing", "enum", { options: ["true", "false"], default: "false", help: "Turn on Stripe Tax at checkout." }),
  // ---- Revenue ----
  def("REVENUE_METRICS", "Revenue", "enum", { options: TRI, default: "shadow", help: "Record revenue movements; on also switches the readers on." }),
  def("REVENUE_ANALYTICS", "Revenue", "enum", { options: TRI, default: "off", help: "Staff revenue analytics views." }),
  def("REVENUE_REPORTING_CURRENCY", "Revenue", "currency", { default: "USD", help: "The one currency revenue is reported in (three letters)." }),
  // ---- Security and organizations ----
  def("ORG_SECURITY_POLICY", "Security", "enum", { options: ENFORCE, default: "off", help: "Organization-wide 2FA policy. enforce blocks members without 2FA." }),
  def("ORG_IP_ALLOWLIST", "Security", "enum", { options: ENFORCE, default: "off", help: "Per-organization IP allowlist (also needs the plan entitlement)." }),
  def("ORG_SSO_REQUIREMENT", "Security", "enum", { options: ["off", "shadow"], default: "off", help: "A stub: only off or shadow exist." }),
  def("API_ENTITLEMENT", "Security", "enum", { options: ENFORCE, default: "off", help: "Plan gate for the API (api.enabled): shadow only logs, enforce refuses new API keys and ends use of existing keys on a plan without API access." }),
  def("ORG_2FA_PASSKEY_COUNTS", "Security", "enum", { options: ON_OFF, default: "off", help: "on = a passkey sign-in that verified the person satisfies an organization 2FA requirement." }),
  def("ORG_2FA_SCOPE", "Security", "enum", { options: ["any_org", "active_org"], default: "any_org", help: "any_org: one organization requiring 2FA restricts the whole session. active_org: only that organization is restricted." }),
  def("CUSTOMER_SESSION_ADMIN", "Security", "enum", { options: TRI, default: "off", help: "Customer session list and revoke. shadow makes a revoke a dry run." }),
  def("CUSTOMER_AUDIT_CSV", "Security", "enum", { options: ON_OFF, default: "off", help: "Customer audit-log CSV export route." }),
  def("CUSTOMER_2FA_ENROLL_PAGE", "Security", "enum", { options: ON_OFF, default: "off", help: "The /app/security/2fa enrollment page." }),
  def("SYNTHETIC_MONITORS", "Security", "enum", { options: TRI, default: "off", help: "Synthetic monitors: off, shadow (probe and record) or on (a failing monitor pages you)." }),
  def("RATE_LIMIT_RETRY_AFTER", "Security", "enum", { options: ON_OFF, default: "off", help: "Send Retry-After on Worker 429 responses." }),
  def("HSTS_PRELOAD", "Security", "enum", { options: ON_OFF, default: "off", help: "Adds preload and a two-year max-age. Hard to undo and covers every subdomain. Needs HSTS_PRELOAD_APPROVED=yes." }),
  def("HSTS_PRELOAD_APPROVED", "Security", "enum", { options: YES_NO, default: "no", help: "Record the owner's approval for HSTS preload." }),
  def("CSP_REPORT_MODE", "Security", "enum", { options: ["basic", "full"], default: "basic", help: "CSP violation-report collection." }),
  def("ERROR_TRACKING", "Security", "enum", { options: TRI, default: "off", help: "Error tracking: off, shadow (log a summary, send nothing) or on (send scrubbed events to SENTRY_DSN). on needs ERROR_TRACKING_APPROVED=yes." }),
  def("ERROR_TRACKING_APPROVED", "Security", "enum", { options: YES_NO, default: "no", help: "Record the owner's approval of the tracker as a sub-processor." }),
  def("LOG_REDACTION", "Security", "enum", { options: ON_OFF, default: "off", help: "Scrub emails, IPs, tokens and secrets from console output." }),
  def("AUDIT_LOG_STREAM", "Security", "enum", { options: ON_OFF, default: "off", help: "Also write each audit row as a scrubbed log line. on needs LOG_REDACTION=on." }),
  def("OUTBOUND_DNS_CHECK", "Security", "enum", { options: ON_OFF, default: "off", help: "DNS check on outbound URLs. On in production unless set to off." }),
  def("CF_WAF_ZONE_ID", "Security", "hex32", { default: "", help: "Cloudflare zone id for WAF rate-limit rules (32 hex characters)." }),
  def("CF_WAF_MAX_RULES", "Security", "int", { min: 1, max: 1000, default: "", help: "Rate-limit rules your Cloudflare plan allows." }),
  def("CF_WAF_ALLOWED_PERIODS", "Security", "csvInt", { min: 1, max: 86400, default: "", help: "Rate-limit periods (seconds) your plan allows, e.g. 10,60." }),
  def("CF_WAF_MAX_TIMEOUT", "Security", "int", { min: 1, max: 604800, default: "", help: "Longest mitigation timeout (seconds) your plan allows." }),
  def("WAF_THRESHOLDS_CONFIRMED", "Security", "enum", { options: YES_NO, default: "no", help: "Confirm the WAF thresholds are real values, not placeholders." }),
  // ---- Public site ----
  def("PUBLIC_TRUST_PAGES", "Public site", "enum", { options: TRI, default: "off", help: "Trust pages: off, shadow (review, noindex) or on." }),
  def("PUBLIC_LEGAL_PAGES", "Public site", "enum", { options: ["off", "draft", "on"], default: "off", help: "Legal pages: off, draft (watermarked, noindex) or on. on only with recorded counsel approval per market." }),
  def("DEMO_PAGE_PLANS", "Public site", "enum", { options: ON_OFF, default: "off", help: "List plans under the /demo form." }),
  def("DEMO_PLANS_PRODUCT", "Public site", "text", { max: 80, pattern: /^[A-Za-z0-9_.:-]+$/, default: "", help: "Optional product id that picks which plan family /demo shows." }),
  def("PUBLIC_FORMS_TURNSTILE_REQUIRED", "Public site", "enum", { options: ON_OFF, default: "off", help: "Require Turnstile on the contact and demo forms (needs the site key and secret)." }),
  def("CUSTOMER_TURNSTILE_REQUIRED", "Public site", "enum", { options: ON_OFF, default: "off", help: "Require Turnstile on customer sign-up, sign-in and forgot-password (needs the site key and secret)." }),
  def("CONTACT_EMAIL", "Public site", "email", { default: "", help: "Shown on the homepage 'Get in Touch' section as a mailto link." }),
  def("STATUS_PROVIDER_URL", "Public site", "url", { default: "", help: "Public status page address (https)." }),
  def("SECURITY_CONTACT", "Public site", "text", { max: 200, pattern: /^(mailto:|https:\/\/)?[^\s<>"']+$/, default: "", help: "Security contact shown on the trust pages and security.txt." }),
  def("COOKIE_BANNER", "Public site", "enum", { options: ON_OFF, default: "on", help: "Cookie consent banner on the public site, sign-in pages and dashboard. Its text and links are Interface text (group cookies)." }),
  def("COOKIE_CONSENT_DAYS", "Public site", "int", { min: 1, max: 400, default: "180", help: "Days a visitor's cookie choice is remembered (browsers cap cookies at 400 days)." }),
  def("SECURITY_TXT_EXPIRES", "Public site", "text", { max: 40, pattern: /^\d{4}-\d{2}-\d{2}(T[0-9:.]+Z?)?$/, default: "", help: "security.txt Expires date, e.g. 2027-12-31." }),
  // ---- Platform ----
  def("PLATFORM_DOMAIN_SUFFIX", "Platform", "hostname", { default: "sites.lummet.app", help: "Placeholder domain a newly provisioned site gets before a custom domain is attached." }),
  def("CF_WORKERS_DEV_SUBDOMAIN", "Platform", "text", { max: 63, pattern: /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i, default: "workers", help: "workers.dev subdomain used as the health-check target for a site without a verified domain." })
];

const BY_KEY = new Map(SETTINGS.map((d) => [d.key, d]));

/**
 * Settings that stay in wrangler.jsonc ON PURPOSE. A wrong value here can lock staff out of the console that would be used to fix
 * it, or break sign-in for everyone. They are refused with `not_manageable` so the reason is clear.
 */
export const NOT_MANAGEABLE = new Set([
  "ENVIRONMENT",
  "PLATFORM_ACCESS_JWT_MODE", "CF_ACCESS_ISSUER", "CF_ACCESS_AUD",
  "WEBAUTHN_RP_ID", "WEBAUTHN_ORIGIN", "PORTAL_BASE_URL",
  "STAFF_2FA_REQUIRED", "STAFF_TURNSTILE_REQUIRED", "PASSWORD_HASH_FORMAT", "PASSWORD_HASH_ITERATIONS"
]);

export const getDef = (key) => BY_KEY.get(key) || null;

// ---------- validation ----------

/** Validates one raw value for a setting. Returns {ok:true, value} with the value normalised, or {ok:false, error}. */
export function validateValue(definition, raw) {
  const s = String(raw ?? "").trim();
  if (s === "") return { ok: false, error: "value_required" };
  if (/[\u0000-\u001f\u007f]/.test(s)) return { ok: false, error: "invalid_value" };
  const bad = { ok: false, error: "invalid_value" };
  switch (definition.type) {
    case "enum": {
      const v = s.toLowerCase();
      return definition.options.includes(v) ? { ok: true, value: v } : bad;
    }
    case "int": {
      if (!/^\d{1,9}$/.test(s)) return bad;
      const n = Number(s);
      return n >= definition.min && n <= definition.max ? { ok: true, value: String(n) } : bad;
    }
    case "csvInt": {
      const parts = s.split(",").map((p) => p.trim());
      if (parts.length < 1 || parts.length > 12 || !parts.every((p) => /^\d{1,9}$/.test(p))) return bad;
      const nums = parts.map(Number);
      return nums.every((n) => n >= definition.min && n <= definition.max) ? { ok: true, value: nums.join(",") } : bad;
    }
    case "csvEnum": {
      if (definition.allowNone && s.trim().toLowerCase() === "none") return { ok: true, value: "none" };
      const parts = [...new Set(s.toLowerCase().split(/[\s,;]+/).filter(Boolean))];
      return parts.length && parts.every((p) => definition.options.includes(p)) ? { ok: true, value: parts.join(",") } : bad;
    }
    case "text":
      return s.length <= definition.max && (!definition.pattern || definition.pattern.test(s)) ? { ok: true, value: s } : bad;
    case "email":
      return s.length <= 254 && /^[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}$/.test(s) ? { ok: true, value: s } : bad;
    case "url": {
      try {
        const u = new URL(s);
        return u.protocol === "https:" && !u.username && !u.password && s.length <= 500 ? { ok: true, value: s } : bad;
      } catch (_) { return bad; }
    }
    case "hostname": {
      const v = s.toLowerCase();
      return v.length <= 253 && /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(v) ? { ok: true, value: v } : bad;
    }
    case "currency":
      return /^[A-Za-z]{3}$/.test(s) ? { ok: true, value: s.toUpperCase() } : bad;
    case "hex32":
      return /^[0-9a-f]{32}$/i.test(s) ? { ok: true, value: s.toLowerCase() } : bad;
    default:
      return bad;
  }
}

const lc = (v) => String(v ?? "").trim().toLowerCase();

/**
 * Rules that span two settings, checked against the values that WOULD be in force after the change. Returns an error code or null.
 * They stop a save that would leave the platform in a state the rest of the code treats as a misconfiguration.
 */
export function crossChecks(key, effective) {
  if (key === "HSTS_PRELOAD" || key === "HSTS_PRELOAD_APPROVED") {
    if (lc(effective.HSTS_PRELOAD) === "on" && lc(effective.HSTS_PRELOAD_APPROVED) !== "yes") return "hsts_preload_needs_approval";
  }
  if (key === "ERROR_TRACKING" || key === "ERROR_TRACKING_APPROVED") {
    if (lc(effective.ERROR_TRACKING) === "on" && lc(effective.ERROR_TRACKING_APPROVED) !== "yes") return "error_tracking_needs_approval";
  }
  if (key === "AUDIT_LOG_STREAM" || key === "LOG_REDACTION") {
    if (lc(effective.AUDIT_LOG_STREAM) === "on" && lc(effective.LOG_REDACTION) !== "on") return "audit_stream_needs_log_redaction";
  }
  if (key === "CUSTOMER_TURNSTILE_REQUIRED" || key === "PUBLIC_FORMS_TURNSTILE_REQUIRED") {
    if (lc(effective[key]) === "on" && (!effective.TURNSTILE_SITE_KEY || !effective.TURNSTILE_SECRET_KEY)) return "turnstile_needs_keys";
  }
  if (key === "PAYMENT_GATEWAYS") {
    const listed = lc(effective.PAYMENT_GATEWAYS).split(/[\s,;]+/).filter(Boolean);
    const usable = listed.some((g) => g === "stripe" || (g === "nowpayments" && effective.NOWPAYMENTS_API_KEY && effective.NOWPAYMENTS_IPN_SECRET));
    if (listed.length && !listed.includes("none") && !usable) return "no_usable_payment_gateway";
  }
  return null;
}

// ---------- loading and the env overlay ----------

const caches = new WeakMap(); // LUMMET_DB binding -> { at, values: Map, promise }

/** The raw env as Cloudflare gave it, without the staff values laid over it. */
export function baseEnvOf(env) {
  return (env && env[BASE]) || env;
}

function readableValues(rows) {
  const values = new Map();
  for (const row of rows) {
    const definition = BY_KEY.get(row.key);
    if (!definition) continue; // not in the allow-list: ignored
    const checked = validateValue(definition, row.value);
    if (checked.ok) values.set(row.key, checked.value); // an unreadable stored value is skipped, wrangler applies
  }
  return values;
}

/** The staff-set values as a Map. Cached per isolate; {fresh:true} bypasses the cache. Never throws. */
export async function loadStaffValues(env, { fresh = false } = {}) {
  const db = baseEnvOf(env)?.LUMMET_DB;
  if (!db) return new Map();
  let entry = caches.get(db);
  const now = Date.now();
  if (!fresh && entry && (entry.promise || now - entry.at < entry.ttl)) return entry.promise ? entry.promise : entry.values;
  const promise = (async () => {
    try {
      const values = readableValues(await repo.listAll(baseEnvOf(env)));
      caches.set(db, { at: Date.now(), ttl: CACHE_MS, values, promise: null });
      return values;
    } catch (error) {
      console.error(JSON.stringify({ msg: "platform_settings_unreadable", error: String(error?.message || error).slice(0, 200) }));
      const values = entry?.values || new Map(); // keep the last good values if there were any
      caches.set(db, { at: Date.now(), ttl: FAILURE_MS, values, promise: null });
      return values;
    }
  })();
  caches.set(db, { at: now, ttl: CACHE_MS, values: entry?.values || new Map(), promise });
  return promise;
}

export function invalidateSettingsCache(env) {
  const db = baseEnvOf(env)?.LUMMET_DB;
  if (db) caches.delete(db);
}

/** env with the staff values laid over it (wrangler value stays underneath). Returns env itself when nothing is set. */
export async function withPlatformSettings(env, { fresh = false } = {}) {
  if (!env || !env.LUMMET_DB) return env;
  const values = await loadStaffValues(env, { fresh });
  if (!values.size) return env;
  const base = baseEnvOf(env);
  const overlay = { ...base };
  for (const [key, value] of values) overlay[key] = value;
  overlay[BASE] = base;
  return overlay;
}

// ---------- reading, for the staff console ----------

function effectiveOf(definition, staffValues, base) {
  const staff = staffValues.get(definition.key);
  if (staff !== undefined) return { value: staff, source: "staff" };
  const fromWrangler = base[definition.key];
  if (fromWrangler !== undefined && fromWrangler !== null && String(fromWrangler).trim() !== "") return { value: String(fromWrangler), source: "wrangler" };
  return { value: definition.default ?? "", source: "default" };
}

/** Every manageable setting with its effective value and where that value comes from. */
export async function listSettings(env) {
  const base = baseEnvOf(env);
  const rows = await repo.listAll(base);
  const meta = new Map(rows.map((r) => [r.key, r]));
  const staffValues = readableValues(rows);
  return SETTINGS.map((definition) => {
    const eff = effectiveOf(definition, staffValues, base);
    const row = meta.get(definition.key);
    const wrangler = base[definition.key];
    return {
      key: definition.key,
      group: definition.group,
      type: definition.type,
      options: definition.options || null,
      help: definition.help || "",
      value: eff.value,
      source: eff.source,
      staffValue: staffValues.has(definition.key) ? staffValues.get(definition.key) : null,
      wranglerValue: wrangler === undefined || wrangler === null || String(wrangler).trim() === "" ? null : String(wrangler),
      default: definition.default ?? "",
      updatedBy: eff.source === "staff" && row ? row.updated_by : null,
      updatedAt: eff.source === "staff" && row ? row.updated_at : null
    };
  });
}

export async function listSettingEvents(env, { limit = 30 } = {}) {
  return repo.listEvents(baseEnvOf(env), Math.min(200, Math.max(1, Number(limit) || 30)));
}

// ---------- writing ----------

function checkKey(key) {
  if (NOT_MANAGEABLE.has(key)) return { ok: false, status: 403, error: "not_manageable" };
  const definition = BY_KEY.get(key);
  if (!definition) return { ok: false, status: 404, error: "unknown_setting" };
  return { ok: true, definition };
}

const reasonOf = (reason) => String(reason ?? "").trim();

/** Saves a staff value. Needs a reason (audited). Returns {ok, setting} or {ok:false, status, error}. */
export async function setSetting(env, { key, value, actorId, reason }) {
  const known = checkKey(key);
  if (!known.ok) return known;
  if (reasonOf(reason).length < 3) return { ok: false, status: 422, error: "reason_required" };
  const checked = validateValue(known.definition, value);
  if (!checked.ok) return { ok: false, status: 422, error: checked.error };

  const base = baseEnvOf(env);
  const staffValues = await loadStaffValues(env, { fresh: true });
  const after = { ...base };
  for (const [k, v] of staffValues) after[k] = v;
  after[key] = checked.value;
  const conflict = crossChecks(key, after);
  if (conflict) return { ok: false, status: 422, error: conflict };

  const before = staffValues.get(key);
  if (before === checked.value) return { ok: true, unchanged: true, setting: await describeOne(env, key) };
  await repo.upsert(base, { key, value: checked.value, actorId });
  await repo.insertEvent(base, { key, action: "set", oldValue: before ?? null, newValue: checked.value, reason: reasonOf(reason), actorId });
  invalidateSettingsCache(env);
  return { ok: true, unchanged: false, setting: await describeOne(env, key) };
}

/** Removes the staff value, so the wrangler value (then the default) applies again. */
export async function clearSetting(env, { key, actorId, reason }) {
  const known = checkKey(key);
  if (!known.ok) return known;
  if (reasonOf(reason).length < 3) return { ok: false, status: 422, error: "reason_required" };

  const base = baseEnvOf(env);
  const staffValues = await loadStaffValues(env, { fresh: true });
  if (!staffValues.has(key) && !(await repo.getOne(base, key))) return { ok: true, unchanged: true, setting: await describeOne(env, key) };
  const after = { ...base };
  for (const [k, v] of staffValues) if (k !== key) after[k] = v;
  const conflict = crossChecks(key, after);
  if (conflict) return { ok: false, status: 422, error: conflict };

  await repo.remove(base, key);
  await repo.insertEvent(base, { key, action: "clear", oldValue: staffValues.get(key) ?? null, newValue: null, reason: reasonOf(reason), actorId });
  invalidateSettingsCache(env);
  return { ok: true, unchanged: false, setting: await describeOne(env, key) };
}

async function describeOne(env, key) {
  return (await listSettings(env)).find((s) => s.key === key);
}

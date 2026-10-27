// =====================================================
// PRODUCTION CONFIGURATION CHECK (v7C)
//
// A missing setting used to fail quietly: with PORTAL_BASE_URL empty, no verification, reset or invitation
// email is ever queued and sign-up still "succeeds". This lists what is missing (NAMES only, never values) so
// the staff SaaS overview and the alert check can say so out loud. Only evaluated when ENVIRONMENT is
// "production", so staging and tests are not nagged.
// =====================================================

import { parsePlatformAccessMode, normalizeAccessIssuer, isValidAccessAudience } from "./cloudflare-access-jwt.js";
import { parseDsn } from "./error-tracking.js";
import { MONITORS, applicability } from "./synthetic-monitors.js";

const has = (env, k) => typeof env[k] === "string" ? env[k].trim() !== "" : !!env[k];
const isHttp = (v) => /^https?:\/\//.test(String(v || ""));

const isNonNegInt = (v) => /^\d+$/.test(String(v ?? "").trim());

const RULES = [
  // Round 6.2B: legal pages. Explicit mode in production; "on" additionally needs a host-to-market map and recorded
  // counsel approvals (the approved text itself lives in published CMS pages legal-<market>-<slug>, not in a variable).
  // Round 6.3A: edge rate limiting. The WAF rules are applied by an owner-run script; these settings record the owner's
  // inputs so production cannot be declared ready while thresholds and plan limits are still placeholders.
  { key: "RATE_LIMIT_RETRY_AFTER", ok: (e) => ["off", "on"].includes(String(e.RATE_LIMIT_RETRY_AFTER || "").trim().toLowerCase()), impact: "Retry-After on Worker 429 responses is not explicitly set (must be off or on)" },
  { key: "CF_WAF_ZONE_ID", ok: (e) => /^[0-9a-f]{32}$/i.test(String(e.CF_WAF_ZONE_ID || "")), impact: "the Cloudflare zone id for WAF rate-limit rules is missing or not a 32-character id" },
  { key: "CF_WAF_MAX_RULES/CF_WAF_ALLOWED_PERIODS/CF_WAF_MAX_TIMEOUT", ok: (e) => Number.isInteger(Number(e.CF_WAF_MAX_RULES)) && Number(e.CF_WAF_MAX_RULES) > 0 && /^\d+(,\s*\d+)*$/.test(String(e.CF_WAF_ALLOWED_PERIODS || "").trim()) && Number.isInteger(Number(e.CF_WAF_MAX_TIMEOUT)) && Number(e.CF_WAF_MAX_TIMEOUT) > 0, impact: "the Cloudflare plan's rate-limit rule, period and mitigation-timeout limits are not recorded" },
  { key: "WAF_THRESHOLDS_CONFIRMED", ok: (e) => String(e.WAF_THRESHOLDS_CONFIRMED || "") === "yes", impact: "WAF rate-limit thresholds are still unconfirmed placeholders" },
  // Round 6.3C (stage _pre): HSTS preload and CSP report collection. Explicit in production so neither is left to a default
  // nobody chose. Preload is hard to undo, so "on" also needs the owner's recorded approval.
  { key: "HSTS_PRELOAD", ok: (e) => ["off", "on"].includes(String(e.HSTS_PRELOAD || "").trim().toLowerCase()), impact: "HSTS preload is not explicitly set (must be off or on)" },
  { key: "HSTS_PRELOAD_APPROVED", ok: (e) => String(e.HSTS_PRELOAD || "").trim().toLowerCase() !== "on" || String(e.HSTS_PRELOAD_APPROVED || "") === "yes", impact: "HSTS preload is on but the owner approval is not recorded (HSTS_PRELOAD_APPROVED=yes); preload is hard to undo and covers every subdomain" },
  { key: "CSP_REPORT_MODE", ok: (e) => ["basic", "full"].includes(String(e.CSP_REPORT_MODE || "").trim().toLowerCase()), impact: "CSP violation-report collection is not explicitly set (must be basic or full), so the CSP review procedure has no defined input" },
  { key: "CSP_REPORT_MAX_PER_MINUTE", ok: (e) => e.CSP_REPORT_MAX_PER_MINUTE === undefined || String(e.CSP_REPORT_MAX_PER_MINUTE).trim() === "" || /^\d+$/.test(String(e.CSP_REPORT_MAX_PER_MINUTE).trim()), impact: "the CSP report flood cap is not a whole number (unset means 60 per minute, 0 means unlimited)" },
  // Round 6.3C (stage 2): error tracking, log redaction, audit stream. All explicit in production so none is left to a default
  // nobody chose. A tracker is a third party that receives (scrubbed) error text, so "on" needs a valid DSN and the owner's
  // recorded approval (sub-processor entry). The audit stream copies audit rows into logs, so it needs redaction on.
  { key: "ERROR_TRACKING", ok: (e) => ["off", "shadow", "on"].includes(String(e.ERROR_TRACKING || "").trim().toLowerCase()), impact: "error tracking is not explicitly set (must be off, shadow or on)" },
  { key: "SENTRY_DSN", ok: (e) => String(e.ERROR_TRACKING || "").trim().toLowerCase() !== "on" || parseDsn(e.SENTRY_DSN).ok, impact: "error tracking is on but SENTRY_DSN (a Worker secret) is missing or is not a public HTTPS tracker address, so no error would be reported" },
  { key: "ERROR_TRACKING_APPROVED", ok: (e) => String(e.ERROR_TRACKING || "").trim().toLowerCase() !== "on" || String(e.ERROR_TRACKING_APPROVED || "") === "yes", impact: "error tracking is on but the owner approval (ERROR_TRACKING_APPROVED=yes, tracker added as a sub-processor) is not recorded" },
  { key: "ERROR_TRACKING_MAX_PER_MINUTE", ok: (e) => e.ERROR_TRACKING_MAX_PER_MINUTE === undefined || String(e.ERROR_TRACKING_MAX_PER_MINUTE).trim() === "" || /^\d+$/.test(String(e.ERROR_TRACKING_MAX_PER_MINUTE).trim()), impact: "the error-tracking events-per-minute cap is not a whole number" },
  { key: "LOG_REDACTION", ok: (e) => ["off", "on"].includes(String(e.LOG_REDACTION || "").trim().toLowerCase()), impact: "log redaction is not explicitly set (must be off or on)" },
  { key: "AUDIT_LOG_STREAM", ok: (e) => ["off", "on"].includes(String(e.AUDIT_LOG_STREAM || "").trim().toLowerCase()), impact: "the audit log stream is not explicitly set (must be off or on)" },
  { key: "AUDIT_LOG_STREAM/LOG_REDACTION", ok: (e) => String(e.AUDIT_LOG_STREAM || "").trim().toLowerCase() !== "on" || String(e.LOG_REDACTION || "").trim().toLowerCase() === "on", impact: "the audit log stream is on but LOG_REDACTION is not on, so free-text audit fields would reach the log destination unscrubbed" },
  { key: "PUBLIC_LEGAL_PAGES", ok: (e) => ["off", "draft", "on"].includes(String(e.PUBLIC_LEGAL_PAGES || "").trim().toLowerCase()), impact: "legal-page rollout mode is not explicitly set (must be off, draft or on)" },
  { key: "LEGAL_MARKET_BY_HOST/LEGAL_COUNSEL_APPROVALS", ok: (e) => {
      if (String(e.PUBLIC_LEGAL_PAGES || "off").trim().toLowerCase() !== "on") return true;
      const obj = (v) => { if (typeof v !== "string" || !v.trim()) return null; try { const x = JSON.parse(v); return x && typeof x === "object" && !Array.isArray(x) ? x : null; } catch (_) { return null; } };
      const hosts = obj(e.LEGAL_MARKET_BY_HOST), approvals = obj(e.LEGAL_COUNSEL_APPROVALS);
      return !!hosts && Object.keys(hosts).length > 0 && !!approvals && Object.keys(approvals).length > 0;
    }, impact: "legal pages are set to on but the host-to-market map or the recorded counsel approvals are missing or invalid JSON" },
  { key: "PUBLIC_TRUST_PAGES", ok: (e) => ["off", "shadow", "on"].includes(String(e.PUBLIC_TRUST_PAGES || "").trim().toLowerCase()), impact: "public trust-page rollout is not explicitly set (must be off, shadow or on)" },
  { key: "STATUS_PROVIDER_URL", ok: (e) => /^https:\/\/[^\s]+$/i.test(String(e.STATUS_PROVIDER_URL || "").trim()), impact: "the public status page has no verified HTTPS status-provider URL" },
  { key: "SECURITY_CONTACT", ok: (e) => /^(mailto:[^\s]+|https:\/\/[^\s]+)$/i.test(String(e.SECURITY_CONTACT || "").trim()), impact: "security.txt has no valid security reporting contact" },
  { key: "SECURITY_TXT_EXPIRES", ok: (e) => { const v = String(e.SECURITY_TXT_EXPIRES || "").trim(); return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v)) && Date.parse(v) > Date.now(); }, impact: "security.txt expiry is missing, invalid or not in the future" },
  { key: "ENVIRONMENT", ok: (e) => e.ENVIRONMENT === "production", impact: "the Stripe livemode guard cannot tell production from test events" },
  { key: "STRIPE_TAX_ENABLED", ok: (e) => ["true","false"].includes(String(e.STRIPE_TAX_ENABLED || "false").trim().toLowerCase()), impact: "Stripe automatic tax rollout must be explicitly false or true" },
  { key: "BILLING_SUSPEND_SITES", ok: (e) => ["off","shadow","enforce","on"].includes(String(e.BILLING_SUSPEND_SITES || "off").trim().toLowerCase()), impact: "site serve-gate rollout mode is invalid" },
  { key: "BILLING_ENFORCE", ok: (e) => ["off", "shadow", "enforce"].includes(String(e.BILLING_ENFORCE || "").trim().toLowerCase()), impact: "the billing lifecycle rollout flag is not set explicitly (must be off, shadow or enforce)" },
  { key: "BILLING_SAVE_FLOW", ok: (e) => ["off", "on"].includes(String(e.BILLING_SAVE_FLOW || "off").trim().toLowerCase()), impact: "temporary subscription pause/save flow flag is invalid (must be off or on)" },
  { key: "BILLING_EMAILS", ok: (e) => ["off", "shadow", "on"].includes(String(e.BILLING_EMAILS || "").trim().toLowerCase()), impact: "the billing email rollout flag is not set explicitly (must be off, shadow or on)" },
  { key: "REVENUE_METRICS", ok: (e) => e.REVENUE_METRICS === undefined || String(e.REVENUE_METRICS).trim() === "" || ["off", "shadow", "on"].includes(String(e.REVENUE_METRICS).trim().toLowerCase()), impact: "the revenue metrics rollout flag is invalid (must be off, shadow or on; unset means shadow)" },
  // Round 6.5A: synthetic monitors. Unset means off; a value that is set but invalid would silently mean off or a default, so
  // refuse it. When the flag is on, a monitor that cannot run (a setting missing) is a COVERAGE GAP: it would never page and never
  // look healthy, so it is named here. Setting names only, never values. A checkout monitor skipped because the Stripe key is live
  // is the owner's default choice (SYNTHETIC_CHECKOUT_ALLOW_LIVE) and is not nagged.
  { key: "SYNTHETIC_MONITORS", ok: (e) => e.SYNTHETIC_MONITORS === undefined || String(e.SYNTHETIC_MONITORS).trim() === "" || ["off", "shadow", "on"].includes(String(e.SYNTHETIC_MONITORS).trim().toLowerCase()), impact: "the synthetic monitor flag is invalid (must be off, shadow or on; unset means off), so no monitor would run and nothing would page" },
  { key: "SYNTHETIC_FAILURE_THRESHOLD", ok: (e) => e.SYNTHETIC_FAILURE_THRESHOLD === undefined || String(e.SYNTHETIC_FAILURE_THRESHOLD).trim() === "" || (/^\d{1,2}$/.test(String(e.SYNTHETIC_FAILURE_THRESHOLD).trim()) && Number(e.SYNTHETIC_FAILURE_THRESHOLD) >= 1 && Number(e.SYNTHETIC_FAILURE_THRESHOLD) <= 10), impact: "the synthetic monitor failure threshold is not a whole number from 1 to 10 (unset means 2), so the default would silently apply" },
  { key: "SYNTHETIC_STALE_MINUTES", ok: (e) => e.SYNTHETIC_STALE_MINUTES === undefined || String(e.SYNTHETIC_STALE_MINUTES).trim() === "" || (/^\d{1,3}$/.test(String(e.SYNTHETIC_STALE_MINUTES).trim()) && Number(e.SYNTHETIC_STALE_MINUTES) >= 10 && Number(e.SYNTHETIC_STALE_MINUTES) <= 120), impact: "the synthetic monitor stale limit is not a whole number of minutes from 10 to 120 (unset means 20), so the default would silently apply" },
  { key: "SYNTHETIC_CHECKOUT_ALLOW_LIVE", ok: (e) => e.SYNTHETIC_CHECKOUT_ALLOW_LIVE === undefined || String(e.SYNTHETIC_CHECKOUT_ALLOW_LIVE).trim() === "" || ["yes", "no"].includes(String(e.SYNTHETIC_CHECKOUT_ALLOW_LIVE).trim().toLowerCase()), impact: "the switch that lets the checkout monitor run against a live Stripe key is not yes or no (unset means no: the checkout monitor is skipped on a live key)" },
  ...MONITORS.map((m) => ({
    key: `SYNTHETIC_MONITORS/${m.name}`,
    ok: (e) => String(e.SYNTHETIC_MONITORS || "").trim().toLowerCase() !== "on" || applicability(m.name, e).state !== "not_configured",
    impact: (e) => `synthetic monitors are on but the ${m.label.toLowerCase()} monitor cannot run, so it is not covered (${applicability(m.name, e).reason || "not configured"}); see docs/SYNTHETIC_MONITORS.md`
  })),
  // The sign-in and checkout monitors log in over HTTP and cannot solve a Turnstile challenge, so with customer-login Turnstile on they
  // would fail on every run. They fail loudly (login_http_422), never fake success; this names the conflict before it pages.
  { key: "SYNTHETIC_MONITORS/CUSTOMER_TURNSTILE_REQUIRED", ok: (e) => String(e.SYNTHETIC_MONITORS || "").trim().toLowerCase() !== "on" || String(e.CUSTOMER_TURNSTILE_REQUIRED || "off").trim().toLowerCase() !== "on", impact: "synthetic monitors are on but customer login requires Turnstile, which the sign-in and checkout monitors cannot pass, so both will fail on every run (see docs/SYNTHETIC_MONITORS.md)" },
  // Round 6.4A: organization security policy (org-wide 2FA). Unset means off; a value that is set but invalid would silently mean off, so refuse it.
  { key: "ORG_SECURITY_POLICY", ok: (e) => e.ORG_SECURITY_POLICY === undefined || String(e.ORG_SECURITY_POLICY).trim() === "" || ["off", "shadow", "enforce"].includes(String(e.ORG_SECURITY_POLICY).trim().toLowerCase()), impact: "the organization security policy flag is invalid (must be off, shadow or enforce; unset means off), so org-wide 2FA would silently not apply" },
  // Round 6.4B: customer session list/revoke and audit-log CSV. Unset means off; a value that is set but invalid would silently mean off, so refuse it.
  { key: "CUSTOMER_SESSION_ADMIN", ok: (e) => e.CUSTOMER_SESSION_ADMIN === undefined || String(e.CUSTOMER_SESSION_ADMIN).trim() === "" || ["off", "shadow", "on"].includes(String(e.CUSTOMER_SESSION_ADMIN).trim().toLowerCase()), impact: "the customer session list and revoke flag is invalid (must be off, shadow or on; unset means off), so organization admins could not end a session" },
  { key: "PASSWORD_HASH_FORMAT", ok: (e) => e.PASSWORD_HASH_FORMAT === undefined || String(e.PASSWORD_HASH_FORMAT).trim() === "" || ["legacy", "v2"].includes(String(e.PASSWORD_HASH_FORMAT).trim().toLowerCase()), impact: "the password hash format flag is invalid (must be legacy or v2; unset means legacy), so password rehash on login would not behave as intended" },
  { key: "PASSWORD_HASH_ITERATIONS", ok: (e) => e.PASSWORD_HASH_ITERATIONS === undefined || String(e.PASSWORD_HASH_ITERATIONS).trim() === "" || (/^[0-9]+$/.test(String(e.PASSWORD_HASH_ITERATIONS).trim()) && Number(e.PASSWORD_HASH_ITERATIONS) >= 10000 && Number(e.PASSWORD_HASH_ITERATIONS) <= 100000), impact: "the password hash iteration count must be an integer from 10000 to 100000 (the Cloudflare Workers ceiling); any other value is ignored and 100000 is used" },
  { key: "CUSTOMER_2FA_ENROLL_PAGE", ok: (e) => e.CUSTOMER_2FA_ENROLL_PAGE === undefined || String(e.CUSTOMER_2FA_ENROLL_PAGE).trim() === "" || ["off", "on"].includes(String(e.CUSTOMER_2FA_ENROLL_PAGE).trim().toLowerCase()), impact: "the customer 2FA enrollment page flag is invalid (must be off or on; unset means off), so members of an organization that requires 2FA would have no page to enroll on" },
  { key: "CUSTOMER_AUDIT_CSV", ok: (e) => e.CUSTOMER_AUDIT_CSV === undefined || String(e.CUSTOMER_AUDIT_CSV).trim() === "" || ["off", "on"].includes(String(e.CUSTOMER_AUDIT_CSV).trim().toLowerCase()), impact: "the customer audit-log CSV flag is invalid (must be off or on; unset means off), so the export would silently be unavailable" },
  // Round 6.4C: organization IP allowlist, SSO requirement stub, list size. Unset means off / default; a value that is set but invalid would silently mean off, so refuse it.
  { key: "ORG_IP_ALLOWLIST", ok: (e) => e.ORG_IP_ALLOWLIST === undefined || String(e.ORG_IP_ALLOWLIST).trim() === "" || ["off", "shadow", "enforce"].includes(String(e.ORG_IP_ALLOWLIST).trim().toLowerCase()), impact: "the organization IP allowlist flag is invalid (must be off, shadow or enforce; unset means off), so a saved allowlist would silently not apply" },
  { key: "ORG_SSO_REQUIREMENT", ok: (e) => e.ORG_SSO_REQUIREMENT === undefined || String(e.ORG_SSO_REQUIREMENT).trim() === "" || ["off", "shadow"].includes(String(e.ORG_SSO_REQUIREMENT).trim().toLowerCase()), impact: "the SSO requirement stub flag is invalid (must be off or shadow; there is no enforce until an identity provider is named), so the requirement could not be recorded" },
  { key: "IP_ALLOWLIST_MAX_ENTRIES", ok: (e) => e.IP_ALLOWLIST_MAX_ENTRIES === undefined || String(e.IP_ALLOWLIST_MAX_ENTRIES).trim() === "" || /^[1-9]\d{0,2}$/.test(String(e.IP_ALLOWLIST_MAX_ENTRIES).trim()), impact: "the IP allowlist size limit is not a whole number from 1 to 999 (unset means 50; values above 200 are clamped to 200)" },
  { key: "REVENUE_ANALYTICS", ok: (e) => e.REVENUE_ANALYTICS === undefined || String(e.REVENUE_ANALYTICS).trim() === "" || ["off", "shadow", "on"].includes(String(e.REVENUE_ANALYTICS).trim().toLowerCase()), impact: "the revenue analytics (cohorts, funnel, deferred revenue, margin) rollout flag is invalid (must be off, shadow or on; unset means off)" },
  { key: "REVENUE_REPORTING_CURRENCY", ok: (e) => e.REVENUE_REPORTING_CURRENCY === undefined || String(e.REVENUE_REPORTING_CURRENCY).trim() === "" || /^[A-Za-z]{3}$/.test(String(e.REVENUE_REPORTING_CURRENCY).trim()), impact: "the revenue reporting currency is not a three-letter currency code (unset means USD, a placeholder the owner must confirm)" },
  { key: "RESEND_WEBHOOK_SECRET", ok: (e) => String(e.BILLING_EMAILS || "").trim().toLowerCase() !== "on" || has(e, "RESEND_WEBHOOK_SECRET"), impact: "billing emails are on but bounces and complaints are not recorded, so bad addresses keep being mailed" },
  { key: "STRIPE_API_VERSION", ok: (e) => /^\d{4}-\d{2}-\d{2}/.test(String(e.STRIPE_API_VERSION || "").trim()), impact: "the Stripe API version is not pinned by configuration" },
  { key: "BILLING_TRIAL_DAYS_DEFAULT", ok: (e) => isNonNegInt(e.BILLING_TRIAL_DAYS_DEFAULT), impact: "the default trial length is undefined" },
  { key: "BILLING_GRACE_DAYS", ok: (e) => isNonNegInt(e.BILLING_GRACE_DAYS) && Number(e.BILLING_GRACE_DAYS) > 0, impact: "the past-due grace period is undefined" },
  { key: "BILLING_RESTRICTED_DAYS", ok: (e) => isNonNegInt(e.BILLING_RESTRICTED_DAYS) && Number(e.BILLING_RESTRICTED_DAYS) > 0, impact: "the restricted period is undefined" },
  { key: "BILLING_SUSPENDED_DAYS", ok: (e) => isNonNegInt(e.BILLING_SUSPENDED_DAYS) && Number(e.BILLING_SUSPENDED_DAYS) > 0, impact: "the suspended period is undefined" },
  { key: "BILLING_REMINDER_DAYS", ok: (e) => /^\s*\d+(\s*,\s*\d+)*\s*$/.test(String(e.BILLING_REMINDER_DAYS || "")), impact: "trial and renewal reminder days are undefined" },
  { key: "PORTAL_BASE_URL", ok: (e) => isHttp(e.PORTAL_BASE_URL), impact: "no verification, reset or invitation emails are queued" },
  { key: "CUSTOMER_TURNSTILE_REQUIRED/TURNSTILE_SECRET_KEY/TURNSTILE_SITE_KEY", ok: (e) => String(e.CUSTOMER_TURNSTILE_REQUIRED || "off").toLowerCase() !== "on" || (has(e, "TURNSTILE_SECRET_KEY") && has(e, "TURNSTILE_SITE_KEY")), impact: "portal signup/login bot protection is enabled without complete server and site keys" },
  { key: "PUBLIC_FORMS_TURNSTILE_REQUIRED/TURNSTILE_SECRET_KEY/TURNSTILE_SITE_KEY", ok: (e) => String(e.PUBLIC_FORMS_TURNSTILE_REQUIRED || "off").toLowerCase() !== "on" || (has(e, "TURNSTILE_SECRET_KEY") && has(e, "TURNSTILE_SITE_KEY")), impact: "public contact/demo bot protection is enabled without complete server and site keys" },
  { key: "CREDENTIAL_KEK", ok: (e) => has(e, "CREDENTIAL_KEK"), impact: "stored secrets cannot be encrypted" },
  { key: "STRIPE_SECRET_KEY", ok: (e) => has(e, "STRIPE_SECRET_KEY"), impact: "checkout and billing fail" },
  { key: "STRIPE_WEBHOOK_SECRET", ok: (e) => has(e, "STRIPE_WEBHOOK_SECRET"), impact: "billing webhooks are rejected" },
  { key: "CF_API_TOKEN", ok: (e) => has(e, "CF_API_TOKEN"), impact: "sites cannot be provisioned" },
  { key: "CF_ACCOUNT_ID", ok: (e) => has(e, "CF_ACCOUNT_ID"), impact: "sites cannot be provisioned" },
  { key: "CF_ZONE_ID", ok: (e) => has(e, "CF_ZONE_ID"), impact: "site routes and custom domains fail" },
  // Round 6.3B: Cloudflare Access JWT for /platform/* and /api/platform/*. The mode must be explicit in production
  // (off, shadow or enforce); issuer and audience are required as soon as the mode is not off.
  { key: "PLATFORM_ACCESS_JWT_MODE", ok: (e) => has(e, "PLATFORM_ACCESS_JWT_MODE") && parsePlatformAccessMode(e) !== "invalid", impact: "Cloudflare Access JWT mode is not explicitly set or is invalid (must be off, shadow or enforce)" },
  { key: "CF_ACCESS_ISSUER/CF_ACCESS_AUD", ok: (e) => parsePlatformAccessMode(e) === "off" || (!!normalizeAccessIssuer(e.CF_ACCESS_ISSUER) && isValidAccessAudience(e.CF_ACCESS_AUD)), impact: "Cloudflare Access verification is on but the team domain (https://<team>.cloudflareaccess.com) or application audience tag is missing or invalid, so platform routes would be refused" },
  { key: "EMAIL_PROVIDER/RESEND_API_KEY/EMAIL_FROM", ok: (e) => e.EMAIL_PROVIDER === "resend" && has(e, "RESEND_API_KEY") && has(e, "EMAIL_FROM"), impact: "queued emails are never sent" },
  { key: "ALERT_WEBHOOK_URL or ALERT_EMAIL", ok: (e) => has(e, "ALERT_WEBHOOK_URL") || has(e, "ALERT_EMAIL"), impact: "no alert ever reaches a human" },
  // Cron Triggers cannot be seen from env, so this asks for the pinger token (set it even if you also use a Cron Trigger).
  { key: "ALERT_CHECK_TOKEN", ok: (e) => has(e, "ALERT_CHECK_TOKEN"), impact: "an external pinger cannot call /api/ops/alert-check, so alert checks, failed-job retries and webhook retries only run if a Cron Trigger is configured" },
  { key: "CSP_MODE", ok: (e) => String(e.CSP_MODE || "").toLowerCase() === "enforce", impact: "the script policy only reports; injected scripts are not blocked (set CSP_MODE=enforce once staging shows no violations)" },
  { key: "OUTBOUND_DNS_CHECK", ok: (e) => String(e.OUTBOUND_DNS_CHECK || "").toLowerCase() !== "off", impact: "customer webhook and SSO hostnames are not checked for resolving to private addresses" },
  { key: "WEBAUTHN_RP_ID/WEBAUTHN_ORIGIN", ok: (e) => has(e, "WEBAUTHN_RP_ID") && has(e, "WEBAUTHN_ORIGIN"), impact: "passkeys fail" },
  { key: "PORTAL_BASE_URL/PLATFORM_DOMAIN_SUFFIX", ok: (e) => isHttp(e.PORTAL_BASE_URL) && has(e, "PLATFORM_DOMAIN_SUFFIX") && !/localhost|workers\.dev/i.test(`${e.PORTAL_BASE_URL} ${e.PLATFORM_DOMAIN_SUFFIX}`), impact: "production portal and tenant hostnames are not explicitly configured" }
];

/** [{ key, impact }] for every missing or invalid production setting; [] outside production. */
export function configIssues(env) {
  if (!env || env.ENVIRONMENT !== "production") return [];
  return RULES.filter((r) => !r.ok(env)).map((r) => ({ key: r.key, impact: typeof r.impact === "function" ? r.impact(env) : r.impact }));
}

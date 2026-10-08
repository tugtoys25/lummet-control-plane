// =====================================================
// PRODUCTION CONFIGURATION CHECK (v7C)
//
// A missing setting used to fail quietly: with PORTAL_BASE_URL empty, no verification, reset or invitation
// email is ever queued and sign-up still "succeeds". This lists what is missing (NAMES only, never values) so
// the staff SaaS overview and the alert check can say so out loud. Only evaluated when ENVIRONMENT is
// "production", so staging and tests are not nagged.
// =====================================================

const has = (env, k) => typeof env[k] === "string" ? env[k].trim() !== "" : !!env[k];
const isHttp = (v) => /^https?:\/\//.test(String(v || ""));

const RULES = [
  { key: "PORTAL_BASE_URL", ok: (e) => isHttp(e.PORTAL_BASE_URL), impact: "no verification, reset or invitation emails are queued" },
  { key: "CREDENTIAL_KEK", ok: (e) => has(e, "CREDENTIAL_KEK"), impact: "stored secrets cannot be encrypted" },
  { key: "STRIPE_SECRET_KEY", ok: (e) => has(e, "STRIPE_SECRET_KEY"), impact: "checkout and billing fail" },
  { key: "STRIPE_WEBHOOK_SECRET", ok: (e) => has(e, "STRIPE_WEBHOOK_SECRET"), impact: "billing webhooks are rejected" },
  { key: "CF_API_TOKEN", ok: (e) => has(e, "CF_API_TOKEN"), impact: "sites cannot be provisioned" },
  { key: "CF_ACCOUNT_ID", ok: (e) => has(e, "CF_ACCOUNT_ID"), impact: "sites cannot be provisioned" },
  { key: "CF_ZONE_ID", ok: (e) => has(e, "CF_ZONE_ID"), impact: "site routes and custom domains fail" },
  { key: "EMAIL_PROVIDER/RESEND_API_KEY/EMAIL_FROM", ok: (e) => e.EMAIL_PROVIDER === "resend" && has(e, "RESEND_API_KEY") && has(e, "EMAIL_FROM"), impact: "queued emails are never sent" },
  { key: "ALERT_WEBHOOK_URL or ALERT_EMAIL", ok: (e) => has(e, "ALERT_WEBHOOK_URL") || has(e, "ALERT_EMAIL"), impact: "no alert ever reaches a human" },
  // Cron Triggers cannot be seen from env, so this asks for the pinger token (set it even if you also use a Cron Trigger).
  { key: "ALERT_CHECK_TOKEN", ok: (e) => has(e, "ALERT_CHECK_TOKEN"), impact: "an external pinger cannot call /api/ops/alert-check, so alert checks, failed-job retries and webhook retries only run if a Cron Trigger is configured" },
  { key: "CSP_MODE", ok: (e) => String(e.CSP_MODE || "").toLowerCase() === "enforce", impact: "the script policy only reports; injected scripts are not blocked (set CSP_MODE=enforce once staging shows no violations)" },
  { key: "OUTBOUND_DNS_CHECK", ok: (e) => String(e.OUTBOUND_DNS_CHECK || "").toLowerCase() !== "off", impact: "customer webhook and SSO hostnames are not checked for resolving to private addresses" },
  { key: "WEBAUTHN_RP_ID/WEBAUTHN_ORIGIN", ok: (e) => has(e, "WEBAUTHN_RP_ID") && has(e, "WEBAUTHN_ORIGIN"), impact: "passkeys fail" }
];

/** [{ key, impact }] for every missing or invalid production setting; [] outside production. */
export function configIssues(env) {
  if (!env || env.ENVIRONMENT !== "production") return [];
  return RULES.filter((r) => !r.ok(env)).map((r) => ({ key: r.key, impact: r.impact }));
}

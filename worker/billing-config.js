// =====================================================
// BILLING LIFECYCLE CONFIGURATION (Phase 0.2 / 1.1)
//
// All grace lengths and the rollout flag come from environment variables, never from constants buried in code.
//   BILLING_ENFORCE   off | shadow | enforce   (default off: every new code path is inert)
//   BILLING_GRACE_DAYS       past_due -> restricted      (default 14)
//   BILLING_RESTRICTED_DAYS  restricted -> suspended     (default 7); also how long an expired trial stays live
//   BILLING_SUSPENDED_DAYS   suspended -> closed         (default 30)
//   BILLING_TRIAL_DAYS_DEFAULT                           (default 7)
//   BILLING_REMINDER_DAYS    "3,1"                       (default) days before a trial end / renewal / grace end / deletion
//   BILLING_RENEWAL_NOTICES  yearly | all | off          (default yearly)
//   BILLING_WINBACK_EMAILS   off | on                    (default off: promotional, needs an unsubscribe path first)
// =====================================================

export const ENFORCE_MODES = ["off", "shadow", "enforce"];

function intVar(env, key, fallback, { min = 0, max = 3650 } = {}) {
  const raw = env && env[key];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export function billingMode(env) {
  const v = String((env && env.BILLING_ENFORCE) || "off").trim().toLowerCase();
  return ENFORCE_MODES.includes(v) ? v : "off";
}

/**
 * CARD_REQUIRED_TRIAL: off (default, nothing changes) | on. When on, a trial can only be started through Stripe Checkout (card
 * collected up front, 7-day trial applied by Stripe); the no-card POST /trial is refused, the billing page hides that button and
 * sends a customer who arrives with a chosen plan straight to Checkout, the saved plan choice is cleared once checkout starts,
 * and the pricing page lists only plans that can actually be bought online.
 */
export function cardRequiredTrial(env) {
  return String((env && env.CARD_REQUIRED_TRIAL) || "off").trim().toLowerCase() === "on";
}

export const EMAIL_MODES = ["off", "shadow", "on"];

/** BILLING_EMAILS: off (default, inert), shadow (decide and log, send nothing), on (queue the emails). */
export function emailsMode(env) {
  const v = String((env && env.BILLING_EMAILS) || "off").trim().toLowerCase();
  return EMAIL_MODES.includes(v) ? v : "off";
}

export const REVENUE_MODES = ["off", "shadow", "on"];

/**
 * REVENUE_METRICS (Round 6.1A): off (record nothing), shadow (default: record revenue movements, nothing reads them yet),
 * on (same writes; the 6.1B/6.1C readers switch on with it). An unset or invalid value is shadow.
 */
export function revenueMode(env) {
  const v = String((env && env.REVENUE_METRICS) || "shadow").trim().toLowerCase();
  return REVENUE_MODES.includes(v) ? v : "shadow";
}

/**
 * REVENUE_REPORTING_CURRENCY (Round 6.1B): the one currency the revenue figures are reported in (ISO 4217, three letters).
 * Default USD is a registered [OPEN] placeholder: the owner has not named the reporting currency. Nothing is converted into it
 * (conversion is Round 7.2); a subscription in any other currency is reported under its own currency code.
 */
export function revenueReportingCurrency(env) {
  const v = String((env && env.REVENUE_REPORTING_CURRENCY) || "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(v) ? v : "USD";
}

export const RENEWAL_NOTICE_MODES = ["off", "yearly", "all"];

/**
 * BILLING_RENEWAL_NOTICES: which renewals get a "your plan renews soon" email.
 *   yearly (default): only annual plans (a monthly customer already gets a receipt every month)
 *   all: every paid renewal    off: none
 */
export function renewalNoticeMode(env) {
  const v = String((env && env.BILLING_RENEWAL_NOTICES) || "yearly").trim().toLowerCase();
  return RENEWAL_NOTICE_MODES.includes(v) ? v : "yearly";
}

/** BILLING_WINBACK_EMAILS: promotional win-back mail. Default OFF until an unsubscribe path exists. */
export function winbackEnabled(env) {
  return String((env && env.BILLING_WINBACK_EMAILS) || "off").trim().toLowerCase() === "on";
}

export function billingConfig(env) {
  const reminder = String((env && env.BILLING_REMINDER_DAYS) || "3,1")
    .split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0 && n < 60);
  return {
    mode: billingMode(env),
    graceDays: intVar(env, "BILLING_GRACE_DAYS", 14, { min: 1 }),
    restrictedDays: intVar(env, "BILLING_RESTRICTED_DAYS", 7, { min: 1 }),
    suspendedDays: intVar(env, "BILLING_SUSPENDED_DAYS", 30, { min: 1 }),
    trialDaysDefault: intVar(env, "BILLING_TRIAL_DAYS_DEFAULT", 7, { min: 0 }),
    reminderDays: reminder.length ? reminder : [3, 1],
    // Suspending a site only changes a database row until the serve gate (sprint 1.3, tenant repo) exists, so
    // pushing sites to "suspended" is a separate switch, default off.
    suspendSitesMode: (() => { const raw=String((env && env.BILLING_SUSPEND_SITES)||"off").trim().toLowerCase(); return raw==="on"?"enforce":["off","shadow","enforce"].includes(raw)?raw:"off"; })(),
    suspendSites: ["on","enforce"].includes(String((env && env.BILLING_SUSPEND_SITES) || "off").trim().toLowerCase())
  };
}

/**
 * The clock. `X-Test-Now` (epoch ms or ISO date) is honoured ONLY when ENVIRONMENT=staging, and only here,
 * so production can never be time-travelled by a header.
 */
export function effectiveNow(env, request) {
  const real = Date.now();
  if (!env || env.ENVIRONMENT !== "staging" || !request || !request.headers) return real;
  const raw = request.headers.get("X-Test-Now");
  if (!raw) return real;
  const t = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(t) ? t : real;
}

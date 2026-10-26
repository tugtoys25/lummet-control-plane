// Round 6.1C revenue analytics. Read-only projections over the 6.1A/6.1B ledger and existing SaaS tables.
// REVENUE_ANALYTICS defaults to off; use shadow to expose staff-only read views while owners validate definitions.
//
// Rules this module keeps (blueprint section 13, 6.1B):
//   * Money is never added across currencies: every figure is reported per currency.
//   * Unknown is null ("unknown" on screen), never zero.
//   * Every SQL statement lives in ./repositories/revenue-analytics.js and returns aggregates or a bounded page.
import * as repo from "./repositories/revenue-analytics.js";

// An invoice whose service period is at least this long is treated as a prepaid annual (or longer) term.
export const ANNUAL_TERM_MIN_DAYS = 300;
export const MAX_COHORT_MONTHS = 120;

export function analyticsMode(env) {
  const value = String(env.REVENUE_ANALYTICS || "off").trim().toLowerCase();
  return ["off", "shadow", "on"].includes(value) ? value : "off";
}

export function csvCell(value) {
  // Finite numbers are system-generated and never a formula; keep a negative number numeric for downstream tools.
  if (typeof value === "number" && Number.isFinite(value)) return `"${value}"`;
  let s = value == null ? "" : String(value);
  // Spreadsheet formula injection: neutralize formula-leading characters after optional whitespace/control chars.
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""').replace(/\r/g, " ").replace(/\n/g, " ")}"`;
}
export function toCsv(headers, rows) {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const pct = (numerator, denominator) => (denominator > 0 ? Math.round((numerator / denominator) * 10000) / 100 : null);
// SQLite-format UTC timestamp, so the clock can be fixed in tests and compared with CURRENT_TIMESTAMP columns.
export const sqlNow = (ms = Date.now()) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

const TIER_KEY = /^[a-zA-Z0-9_.-]{1,80}$/;

export async function financeUnitCosts(env) {
  const row = await repo.getSetting(env, "finance_unit_costs_by_tier");
  if (!row?.value) return {};
  let parsed;
  try { parsed = JSON.parse(row.value); } catch (error) {
    // A corrupt setting must not read as "zero cost". Treat as unset and say so in the log.
    console.warn("finance_unit_costs_by_tier is not valid JSON; treating all costs as unknown", String(error?.message || error));
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const clean = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (TIER_KEY.test(key) && Number.isInteger(value) && value >= 0) clean[key] = value;
  }
  return clean;
}

export async function setFinanceUnitCosts(env, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, status: 422, error: "costs_object_required" };
  const costs = {};
  for (const [key, value] of Object.entries(input)) {
    if (!TIER_KEY.test(key)) return { ok: false, status: 422, error: "invalid_tier_key" };
    if (!Number.isInteger(value) || value < 0 || value > 1000000000) return { ok: false, status: 422, error: "cost_must_be_nonnegative_integer_cents" };
    costs[key] = value;
  }
  await repo.setSetting(env, "finance_unit_costs_by_tier", JSON.stringify(costs));
  return { ok: true, costs };
}

// One row per (cohort month, currency), newest month first. Definitions (also in DECISIONS):
//   starting MRR = the cohort organizations' ledger movements in their cohort month; current MRR = their MRR in the ledger now;
//   NRR = current / starting; GRR = sum over organizations of MIN(current, starting) / starting (no expansion credit);
//   logo churn = organizations with a churn movement and zero MRR now / organizations in the cohort.
export async function monthlyCohorts(env, { limit = 24 } = {}) {
  const months = Math.max(1, Math.min(MAX_COHORT_MONTHS, Number(limit) || 24));
  const rows = await repo.listCohortRows(env);
  const keep = new Set();
  const out = [];
  for (const r of rows) {
    keep.add(r.cohort_month);
    if (keep.size > months) break;
    const start = num(r.start_cents); const current = num(r.current_cents); const retained = num(r.retained_cents);
    const logos = num(r.logos); const churned = num(r.churned_logos);
    out.push({
      cohortMonth: r.cohort_month, currency: String(r.currency || "USD").toUpperCase(), logos,
      startingMrrCents: start, currentMrrCents: current, retainedMrrCents: retained,
      nrrPercent: start > 0 ? pct(current, start) : null,
      grrPercent: start > 0 ? pct(retained, start) : null,
      churnedLogos: churned, logoChurnPercent: pct(churned, logos)
    });
  }
  return out;
}

// Organization-level funnel as of `now`. Rates are null (unknown) when the denominator is zero.
export async function funnelSummary(env, { now = Date.now() } = {}) {
  const at = sqlNow(now);
  const c = await repo.funnelCounts(env, at);
  const trialsEnded = num(c.ended?.n); const trialsPaid = num(c.converted?.n);
  const signupsMatured = num(c.signups?.n); const activated = num(c.activated?.n);
  return {
    asOf: at, organizations: num(c.orgs?.n),
    trialsEnded, trialsEndedStillInWindow: num(c.inWindow?.n), trialToPaid14Days: trialsPaid, trialToPaidPercent: pct(trialsPaid, trialsEnded),
    signupsMatured, activated14Days: activated, activationPercent: pct(activated, signupsMatured)
  };
}

export async function paginatedAnalyticsList(env, { kind = "trials", limit = 50, offset = 0 } = {}) {
  const take = Math.max(1, Math.min(100, Number(limit) || 50)); const skip = Math.max(0, Number(offset) || 0);
  return kind === "activation" ? repo.listActivationRows(env, { limit: take, offset: skip }) : repo.listTrialRows(env, { limit: take, offset: skip });
}

export async function arpaByCurrency(env) {
  const rows = await repo.listArpaRows(env);
  return rows.map((r) => {
    const paying = num(r.paying_organizations); const mrr = num(r.mrr_cents);
    return { currency: String(r.currency || "USD").toUpperCase(), mrrCents: mrr, payingOrganizations: paying, arpaCents: paying > 0 ? Math.round(mrr / paying) : null };
  });
}

// Prepaid terms still running at `now`, net of tax, recognized evenly over the invoice's service period; per currency.
export async function deferredRevenueSummary(env, { now = Date.now() } = {}) {
  const rows = await repo.deferredRevenueRows(env, { now: sqlNow(now), minTermDays: ANNUAL_TERM_MIN_DAYS });
  return rows.map((r) => {
    const prepaid = num(r.prepaid_cents); const deferred = Math.min(prepaid, num(r.deferred_cents));
    return { currency: String(r.currency || "USD").toUpperCase(), invoices: num(r.invoices), prepaidCents: prepaid, recognizedCents: prepaid - deferred, deferredCents: deferred };
  });
}

export async function grossMarginByTier(env) {
  const costs = await financeUnitCosts(env);
  const rows = await repo.listGrossMarginRows(env);
  return rows.map((r) => {
    const unitCost = Object.prototype.hasOwnProperty.call(costs, r.tier) ? costs[r.tier] : null;
    const subscriptions = num(r.subscriptions);
    // If any live subscription lacks a revenue-ledger state, revenue is unknown rather than reconstructed from list prices.
    const revenueCents = num(r.metered_subscriptions) === subscriptions ? num(r.mrr_cents) : null;
    const costCents = unitCost == null ? null : unitCost * subscriptions;
    const marginCents = revenueCents == null || costCents == null ? null : revenueCents - costCents;
    return {
      tier: r.tier, plan: r.plan, currency: r.currency || "USD", subscriptions, revenueCents, unitCostCents: unitCost, totalCostCents: costCents,
      grossMarginCents: marginCents, grossMarginPercent: marginCents != null && revenueCents > 0 ? pct(marginCents, revenueCents) : null
    };
  });
}

export async function dashboardData(env, { now = Date.now() } = {}) {
  const mode = analyticsMode(env);
  if (mode === "off") return { enabled: false, mode, cohorts: [], funnel: null, arpa: [], deferredRevenue: [], margins: [] };
  const [cohorts, funnel, arpa, deferredRevenue, margins] = await Promise.all([
    monthlyCohorts(env), funnelSummary(env, { now }), arpaByCurrency(env), deferredRevenueSummary(env, { now }), grossMarginByTier(env)
  ]);
  return { enabled: true, mode, cohorts, funnel, arpa, deferredRevenue, margins };
}

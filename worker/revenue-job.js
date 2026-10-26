// =====================================================
// DAILY REVENUE JOB (Round 6.1B, release 2.6.0.2): MRR, ARR and the movement bridge, blueprint section 13.
//
// Reads the 6.1A ledger (subscription_movements) and writes revenue_snapshots, one row per (day, currency). No SQL here: the repository
// owns it. Called from the daily cron only (worker/index.js, after the revenue backfill step); never from a UI action.
//
//   REVENUE_METRICS=off     -> the job does nothing
//   REVENUE_METRICS=shadow  -> (default) the job writes snapshots; the staff overview reads them
//   REVENUE_METRICS=on      -> same writes; reserved for the 6.1C readers
//
// What a snapshot row means (day D, currency C), all derived from stored rows so a re-run gives the same answer:
//   mrr_cents      the ledger summed to the end of D for C. The ledger already holds the section 13 definition per subscription:
//                  active and past_due, annual / 12, minus recurring discounts, trials and one-time fees excluded (worker/revenue.js).
//   arr_cents      12 x mrr_cents
//   active, trialing, past_due   subscriptions in that status at the end of D, by plan currency
//   new_mrr, expansion_mrr       the sums of D's movements of that kind
//   contraction_mrr, churned_mrr the same, stored as positive magnitudes
// so, for every day: mrr(D) = mrr(D-1) + new + expansion - contraction - churned.
//
// Idempotent: the (day, currency) row is upserted; a run recomputes the last few days (so a late event is picked up) and otherwise
// resumes from the newest snapshot. A run that stops part way (the Worker is evicted, a write fails) leaves complete days behind and the
// next daily run carries on from there; overlapping runs write the same values.
//
// Currencies are NEVER summed. Each currency has its own row. When more than one currency has live revenue the report is flagged
// 'mixed_currency', the single-total figure is withheld (null) and the per-currency figures are shown. Conversion is Round 7.2.
// =====================================================

import { revenueMode, revenueReportingCurrency } from "./billing-config.js";
import * as repo from "./repositories/revenue.js";

export const MAX_DAYS_PER_RUN = 45;
/** The newest days recomputed on every run, so an event that arrives a day or two late still lands in its day. */
export const RECOMPUTE_DAYS = 3;
/** [OPEN] owner input not supplied: the MRR tolerance against a provider (Stripe) report, in basis points (100 = 1%). Placeholder. */
export const DEFAULT_MRR_TOLERANCE_BPS = 100;

const DAY_MS = 86400000;
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ""));
export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (day, n) => utcDay(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);
const yesterday = (now) => addDays(utcDay(now), -1);

/** True when `actualCents` is within `toleranceBps` basis points of `expectedCents` (exact when the expectation is zero). Pure. */
export function mrrWithinTolerance(actualCents, expectedCents, toleranceBps = DEFAULT_MRR_TOLERANCE_BPS) {
  const a = Number(actualCents), e = Number(expectedCents);
  if (!Number.isFinite(a) || !Number.isFinite(e)) return false;
  if (e === 0) return a === 0;
  return Math.abs(a - e) * 10000 <= Math.abs(e) * Number(toleranceBps);
}

/** The snapshot rows for one day, one per currency, computed from the ledger and the status history. Pure of side effects. */
export async function computeDaySnapshots(env, day) {
  const [cumulative, totals, counts] = await Promise.all([repo.cumulativeMrrByCurrency(env, day), repo.movementTotalsForDay(env, day), repo.statusCountsAsOf(env, day)]);
  const currencies = new Set([...cumulative.map((r) => r.currency), ...totals.map((r) => r.currency), ...counts.map((r) => r.currency)]);
  const rows = [];
  for (const currency of [...currencies].sort()) {
    const mrr = Number(cumulative.find((r) => r.currency === currency)?.mrr_cents) || 0;
    const delta = (kind) => Number(totals.find((r) => r.currency === currency && r.kind === kind)?.delta_cents) || 0;
    const count = (status) => Number(counts.find((r) => r.currency === currency && r.status === status)?.n) || 0;
    rows.push({
      day, currency, mrrCents: mrr, arrCents: mrr * 12, active: count("active"), trialing: count("trialing"), pastDue: count("past_due"),
      newMrr: delta("new"), expansionMrr: delta("expansion"), contractionMrr: -delta("contraction"), churnedMrr: -delta("churn")
    });
  }
  return rows;
}

/**
 * Which currencies carry live revenue (money, or active / past_due subscriptions; a trial alone is not revenue yet), whether that is more
 * than one, and what is worth flagging. Works on snapshot rows in either shape (database or computed).
 */
export function assessCurrencies(rows, reportingCurrency) {
  const get = (r, a, b) => Number(r[a] ?? r[b]) || 0;
  const live = (rows || []).filter((r) => get(r, "mrr_cents", "mrrCents") > 0 || get(r, "active", "active") > 0 || get(r, "past_due", "pastDue") > 0).map((r) => r.currency).sort();
  const flags = [];
  const mixed = live.length > 1;
  if (mixed) flags.push("mixed_currency");
  if (live.length >= 1 && !live.includes(reportingCurrency)) flags.push("reporting_currency_mismatch");
  else if (mixed) flags.push("reporting_currency_partial");
  return { currencies: live, mixed, flags };
}

/**
 * Write snapshots for the days that need them. Options: `now` (ms, injectable), `day` (compute exactly that day), `maxDays` (bound per run).
 * Returns { status: 'ok' | 'disabled' | 'no_data', from, to, days, complete, mixedCurrency, currencies, flags }.
 */
export async function runDailyRevenueJob(env, { now = Date.now(), day = null, maxDays = MAX_DAYS_PER_RUN } = {}) {
  if (revenueMode(env) === "off") return { status: "disabled" };
  const earliest = await repo.earliestRevenueDay(env);
  if (!earliest) return { status: "no_data" };
  const target = isDay(day) ? day : yesterday(now);
  const limit = Math.max(1, Math.min(400000, Number(maxDays) || MAX_DAYS_PER_RUN));
  let start;
  if (isDay(day)) start = day;
  else {
    const latest = await repo.latestSnapshotDay(env);
    const resume = latest ? addDays(latest, 1) : earliest;
    const recompute = addDays(target, -(RECOMPUTE_DAYS - 1));
    start = resume < recompute ? resume : recompute;
    if (start < earliest) start = earliest;
  }
  if (start > target) return { status: "no_data", reason: "nothing_reportable_yet", from: start, to: target, days: 0, complete: true };
  const end = (() => { const e = addDays(start, limit - 1); return e < target ? e : target; })();
  const reporting = revenueReportingCurrency(env);
  let days = 0, last = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const rows = await computeDaySnapshots(env, d);
    for (const row of rows) await repo.upsertSnapshot(env, row);
    days++; last = rows;
  }
  const assessment = assessCurrencies(last, reporting);
  if (assessment.mixed) console.warn(JSON.stringify({ msg: "revenue_mixed_currency", day: end, currencies: assessment.currencies, reportingCurrency: reporting, note: "reported per currency; never summed (conversion is Round 7.2)" }));
  return { status: "ok", from: start, to: end, days, complete: end === target, mixedCurrency: assessment.mixed, currencies: assessment.currencies, flags: assessment.flags };
}

const shape = (r) => ({
  currency: r.currency, mrrCents: Number(r.mrr_cents) || 0, arrCents: Number(r.arr_cents) || 0, active: Number(r.active) || 0, trialing: Number(r.trialing) || 0, pastDue: Number(r.past_due) || 0,
  newMrr: Number(r.new_mrr) || 0, expansionMrr: Number(r.expansion_mrr) || 0, contractionMrr: Number(r.contraction_mrr) || 0, churnedMrr: Number(r.churned_mrr) || 0
});

/**
 * What the staff overview shows: the newest snapshot day, per currency. `mrrCents` is a single figure ONLY when exactly one currency
 * has revenue; with several it is null and the caller must show perCurrency. Unknown is never reported as zero.
 */
export async function currentRevenueSummary(env, { now = Date.now() } = {}) {
  const mode = revenueMode(env);
  if (mode === "off") return { available: false, reason: "off", mode };
  const rows = await repo.latestSnapshotRows(env);
  if (!rows.length) return { available: false, reason: "no_snapshot", mode };
  const reporting = revenueReportingCurrency(env);
  const day = rows[0].day;
  const assessment = assessCurrencies(rows, reporting);
  const perCurrency = rows.map(shape);
  const flags = [...assessment.flags];
  if (day < addDays(yesterday(now), -1)) flags.push("stale");
  const single = !assessment.mixed ? (perCurrency.find((c) => c.currency === assessment.currencies[0]) || perCurrency.find((c) => c.currency === reporting) || perCurrency[0]) : null;
  return {
    available: true, mode, day, reportingCurrency: reporting, mixedCurrency: assessment.mixed, stale: flags.includes("stale"), flags, perCurrency,
    currency: single ? single.currency : null, mrrCents: single ? single.mrrCents : null, arrCents: single ? single.arrCents : null
  };
}

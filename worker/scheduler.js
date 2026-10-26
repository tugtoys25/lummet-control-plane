// =====================================================
// SCHEDULER HEARTBEAT AND CRON DISPATCH (Phase 0.2)
//
// Crons declared in wrangler.jsonc:
//   "*/5 * * * *"  the tick: today's sweep (health, outbox, jobs, alerts, ...) plus the billing lifecycle sweep
//   "0 2 * * *"    daily  (reserved: reconciliation, usage and revenue snapshots arrive in later phases)
//   "0 7 * * 1"    weekly (reserved: internal revenue digest)
// An UNKNOWN cron expression falls through to the tick, i.e. today's behaviour, so adding or changing a trigger can
// never silently stop the existing sweep from running.
// =====================================================

import * as repo from "./repositories/billing-lifecycle.js";

export const TICK_CRON = "*/5 * * * *";
export const DAILY_CRON = "0 2 * * *";
export const WEEKLY_CRON = "0 7 * * 1";

export function cronKind(cron) {
  if (cron === DAILY_CRON) return "daily";
  if (cron === WEEKLY_CRON) return "weekly";
  return "tick";
}

const RETENTION_DAYS = 14;

/** Records that a scheduled run happened. Never throws: a heartbeat failure must not stop the sweep it measures. */
export async function recordTick(env, cron, { ok = true, detail = null } = {}) {
  try {
    await repo.insertTick(env, { cron: cron || TICK_CRON, ok, detail: detail ? String(detail).slice(0, 300) : null });
    await repo.pruneTicks(env, RETENTION_DAYS);
    return true;
  } catch (e) {
    console.error(JSON.stringify({ msg: "scheduler_tick_not_recorded", error: e?.message || String(e) }));
    return false;
  }
}

export async function lastTick(env, cron = TICK_CRON) {
  return repo.lastTick(env, cron);
}

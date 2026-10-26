// Synthetic monitor probe state (Round 6.5A). (Repository.)
//
// Monitor state REUSES the existing alert_state table (migration 0025); there is no new table and no migration.
// The paging itself is the existing alert machinery: a row `synthetic_<monitor>` is written only by alerts.js
// (firing, last_count, first_seen_at, last_notified_at). This file owns a second, separate row per monitor, key
// `probe:<monitor>`, which records what the probes themselves saw. The columns are reused like this:
//
//   firing            0 = last probe ok, 1 = last probe failed, 2 = last probe blocked (a dependency failed)
//   last_count        consecutive failed probes (0 when the last real probe passed; unchanged while blocked)
//   first_seen_at     when the current run of failures began (NULL when healthy)
//   last_notified_at  time of the last probe that PASSED ("last ok"; never touched by a failure)
//   updated_at        time of the last probe result of any kind (the staleness clock; only this file writes it)
//
// Keeping probe observations apart from the alert row matters: the alert check rewrites updated_at and last_count on
// its own row every run, which would otherwise hide a monitor that has stopped reporting.

export const PROBE_PREFIX = "probe:";
export const RESULT_OK = 0;
export const RESULT_FAIL = 1;
export const RESULT_BLOCKED = 2;

const probeKey = (monitor) => `${PROBE_PREFIX}${monitor}`;

export async function getProbe(env, monitor) {
  return env.LUMMET_DB.prepare(`SELECT key, firing, last_count, first_seen_at, last_notified_at, updated_at FROM alert_state WHERE key = ?`).bind(probeKey(monitor)).first();
}

export async function listProbes(env) {
  return (await env.LUMMET_DB.prepare(`SELECT key, firing, last_count, first_seen_at, last_notified_at, updated_at FROM alert_state WHERE key LIKE 'probe:%' ORDER BY key`).all()).results;
}

/** The probe passed: the failure run is cleared and the last-ok time moves forward. */
export async function recordOk(env, monitor, nowIso) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO alert_state (key, firing, last_count, first_seen_at, last_notified_at, updated_at) VALUES (?, 0, 0, NULL, ?, ?)
     ON CONFLICT(key) DO UPDATE SET firing = 0, last_count = 0, first_seen_at = NULL,
       last_notified_at = excluded.last_notified_at, updated_at = excluded.updated_at`
  ).bind(probeKey(monitor), nowIso, nowIso).run();
}

/** The probe failed: one more consecutive failure; the start of the run is kept; "last ok" is left alone. */
export async function recordFail(env, monitor, nowIso) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO alert_state (key, firing, last_count, first_seen_at, last_notified_at, updated_at) VALUES (?, 1, 1, ?, NULL, ?)
     ON CONFLICT(key) DO UPDATE SET firing = 1, last_count = alert_state.last_count + 1,
       first_seen_at = CASE WHEN alert_state.last_count > 0 AND alert_state.first_seen_at IS NOT NULL THEN alert_state.first_seen_at ELSE excluded.first_seen_at END,
       updated_at = excluded.updated_at`
  ).bind(probeKey(monitor), nowIso, nowIso).run();
}

/** The probe could not run because something it depends on failed. The failure count and "last ok" are NOT changed. */
export async function recordBlocked(env, monitor, nowIso) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO alert_state (key, firing, last_count, first_seen_at, last_notified_at, updated_at) VALUES (?, 2, 0, NULL, NULL, ?)
     ON CONFLICT(key) DO UPDATE SET firing = 2, updated_at = excluded.updated_at`
  ).bind(probeKey(monitor), nowIso).run();
}

/** Reason code of the most recent failure transition of a monitor (written to the audit log by the monitor runner). */
export async function latestFailureReason(env, monitor) {
  const found = await env.LUMMET_DB.prepare(
    `SELECT error_message FROM lummet_audit_logs WHERE resource = 'synthetic_monitor' AND resource_id = ? AND success = 0 ORDER BY rowid DESC LIMIT 1`
  ).bind(monitor).first();
  return found ? found.error_message : null;
}

# Runbook: D1 incident

`LUMMET_DB` is the control plane's only database: organizations, subscriptions, billing history, audit logs, entitlements.
Two recovery tools exist and they are not the same thing:

| Tool | What it is | Granularity | Cost of using it |
|---|---|---|---|
| D1 Time Travel | Cloudflare's point-in-time restore of the **same** database | any minute in the retention window | Restores in place: everything written after the chosen point is gone from that database |
| Control-plane backup in R2 (`BACKUPS`) | Our encrypted export, about daily, newest 14 kept, needs `CREDENTIAL_KEK` | one export (not a snapshot: tables are read one after another) | Restores into a **new** database; data since the export is lost; you repoint the Worker |

See [backup and restore](../CONTROL_PLANE_BACKUP.md) for what the export contains and its limits. Time Travel is the primary
tool; the export is the independent second copy.

## Trigger

- 5xx from the control plane with database errors in the Worker logs; `server_errors` fires; many alerts fire at once.
- `backup_stale` (no successful backup in 36 hours) with other symptoms, or `cron_not_running`.
- Cloudflare reports a D1 incident, or someone ran a destructive statement or a bad migration.
- Data is missing or wrong (rows deleted, a table empty) rather than the service being down.

## First 15 minutes

1. Decide which kind of incident it is, because the actions differ:
   - **Unavailable or slow** (Cloudflare side): nothing is lost; do not restore anything. Go to [Cloudflare incident](cloudflare-incident.md).
   - **Data lost or corrupted** (our side): stop further writes, then follow the recovery section.
2. Open the incident record ([template](../RUNBOOKS.md#incident-record)) and write the UTC time you first saw the problem. That time
   is the anchor for every restore decision.
3. Stop the thing that is writing damage: a running migration or script, a bad deploy (roll the Worker back), a sweep acting on
   wrong data. Moving `BILLING_ENFORCE` and `BILLING_SUSPEND_SITES` to `shadow` stops billing state changes and site pushes
   while you investigate (a recorded configuration change and redeploy).
4. Record the current Time Travel bookmark **before touching anything**: `node scripts/record-d1-bookmark.mjs` (staging helper,
   needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`) or `wrangler d1 time-travel info <database>` for the production
   database named in `wrangler.jsonc`. A bookmark taken now lets you undo a restore.
5. Confirm the newest backup is intact without restoring it: staff page SaaS > DB backups > Verify
   (`/api/platform/saas/cp-backups/:id/verify`), which re-reads every part and checks hashes, decryption and row counts.
6. Tenant sites keep serving: the control plane is not in their request path, and the access channel fails open for sites it
   cannot reach ([site access gate](../SITE_ACCESS_GATE.md)). Do not suspend or redeploy sites to "help".

## Do not

- Do not run a Time Travel restore, or restore a backup over the live database, without the incident lead's written decision
  and a fresh bookmark. An in-place restore discards every write after the restore point, including payments recorded since.
- Do not apply migrations to "fix" an incident, and do not edit or renumber shipped migrations.
- Do not hand-edit billing, access or audit rows to match what you think they should be.
- Do not restore a backup into the production database name. The drill tool refuses it; a manual restore should never skip that rule.
- Do not paste `CREDENTIAL_KEK` anywhere. Without it no backup can be read; keep a copy outside Cloudflare.

## Recovery and verification

**A. Cloudflare-side outage.** Wait, communicate, then verify: sign in as staff, open the alerts page, run "Run check now",
check the sweep ran (`cron_not_running` clear), and read [webhook backlog](webhook-backlog.md) because Stripe events that failed
during the outage will be redelivered.

**B. Recent bad write (minutes to hours), same database.**
1. Pick the restore point from the incident record: the last time you are sure the data was right.
2. Check `wrangler d1 time-travel restore --help` for the exact flags in your wrangler version (**NOT VERIFIED** here), then
   restore by bookmark or timestamp, and keep the bookmark the command prints so the restore can itself be undone.
3. Every write after that point is gone. List them from other sources: Stripe events (redelivered by Stripe for a limited time;
   replay with [webhook backlog](webhook-backlog.md)), Resend sent mail, the Logpush audit stream if enabled
   ([Logpush](../LOGPUSH.md)). Then run `scripts/reconcile-billing.mjs`.

**C. Database lost or restore point outside Time Travel's window.** Use the backup: follow the
[restore drill](restore-drill.md) procedure with the real production target decision made by the lead: new database, apply
all migrations, `scripts/restore-control-plane.mjs`, load the SQL, then point `LUMMET_DB` at the new database and redeploy.
Expect to lose everything since the export. Sessions are not in the export on purpose; everyone signs in again.

After any restore: verify row counts against the manifest, sign in as staff and as a customer, confirm one organization's
subscription matches Stripe, run the reconcile script, and confirm `backup_stale` and the alerts clear.

## Record the incident

Anchor time, bookmarks recorded (ids, not tokens), restore point chosen and why, who approved, what was written after the point
and how each item was recovered or declared lost (counts), reconcile output, and the next backup's verification result.

## Who and how (placeholders)

**[OPEN]** Who may authorize a restore, and the recovery-point objective (how much data loss is acceptable), are owner
decisions (`docs/PLACEHOLDERS.md`, Round 6.5B). The backup interval is code (about 20 hours between exports); that is a
mechanism, not an approved objective. The restore-time objective is the one the [restore drill](restore-drill.md) measures against.

## Evidence status

STATIC REVIEW. NOT VERIFIED: no Time Travel restore and no production-sized backup restore has been run. The backup export
itself was never run against a real D1 database from the build environment ([backup doc](../CONTROL_PLANE_BACKUP.md)).

## Database size

If the incident looks like the database growing too large, run the read-only `scripts/d1-size-check.mjs` and read [the size and table-move plan](../D1_SIZE_AND_TABLE_MOVE_PLAN.md). Nothing in that plan is built or moved yet; the output is NOT VERIFIED until run against the real database.

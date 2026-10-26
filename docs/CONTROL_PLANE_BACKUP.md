# Control-plane database backups (roadmap 2.3)

The `backups.js` module backs up each customer's site content. This is
different: it backs up the platform's **own** database (organizations,
subscriptions, billing history, audit logs, entitlements). Losing that loses
the business's operational state.

## What you get

- A full export about once a day to the `BACKUPS` R2 bucket, encrypted with
  `CREDENTIAL_KEK`, with a manifest of hashes and row counts. The newest 14
  are kept.
- **SaaS > DB backups** in the staff console: list, "Back up now", "Verify"
  (re-reads every part, checks its hash, decrypts it, and checks row counts).
- An alert if no successful backup exists for 36 hours (only when `BACKUPS` is
  configured).
- Not exported on purpose: sessions, login attempts, one-time tokens and auth
  challenges.

## Requirements and limits (read these)

1. **Needs the Workers Paid plan.** The export makes well over 100 database
   calls in one run. The free plan allows about 50 per request and far less CPU
   time, so on free it will fail (and the stale-backup alert will tell you).
   This was not run against a real D1 database from here.
2. **Not a point-in-time snapshot.** Tables are read one after another. Use D1
   Time Travel as your primary recovery tool and confirm it is on:
   `wrangler d1 time-travel info <database>`. This export is the independent
   second copy.
3. **`CREDENTIAL_KEK` is required to read any backup.** Keep a copy of it
   somewhere separate from Cloudflare (a password manager). A backup you cannot
   decrypt is not a backup.
4. `PRAGMA foreign_key_list` is used to order tables parents-first. It is
   supported by D1, but verify on the first real run via "Verify".

## Scheduling

Runs from the Cron Trigger if you have one, and also on every
`/api/ops/alert-check` ping (see `ALERTING.md`). It only does work when no
backup is under 20 hours old, so frequent pings are harmless.

## Restoring

1. Download the backup's folder from R2 (the `manifest.json` and every
   `part-NNNN.json` under `control-plane/<date>/<id>/`) into one directory.
2. Create a new D1 database and apply all migrations to it.
3. `CREDENTIAL_KEK=<key> node scripts/restore-control-plane.mjs ./dir > restore.sql`
   (it refuses corrupted or incomplete downloads).
4. `wrangler d1 execute <new-db> --remote --file restore.sql`, then point the
   Worker's `LUMMET_DB` binding at the new database.

Restoring replaces seeded catalog rows with the backed-up versions. Practice
this once on a scratch database before you ever need it.

## Restore drill

The practice restore has tooling and a report: [restore drill runbook](runbooks/restore-drill.md) (AT-15) and
`scripts/restore-drill.mjs`. It is owner-run and NOT VERIFIED until executed in staging with evidence. For a real data-loss
incident start from the [D1 incident runbook](runbooks/d1-incident.md); the restore-time and recovery-point objectives are
**[OPEN]** owner decisions.

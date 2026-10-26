# Runbook: restore drill (AT-15)

Proves, with evidence, that a control-plane backup can be turned back into a working database in staging, and measures how
long that takes. **The drill is owner-run.** Nothing here has been executed against real Cloudflare, so the result is
**NOT VERIFIED** until the owner has run it and attached the report and the evidence listed below.

Related: [backup and restore](../CONTROL_PLANE_BACKUP.md) (what the export contains and its limits), [D1 incident](d1-incident.md)
(when a real restore is needed), [go-live checklist](../GO_LIVE_CHECKLIST.md).

## What the tool does

`scripts/restore-drill.mjs` wraps the existing converter `scripts/restore-control-plane.mjs` and adds timing, checks and a report.

| Mode | Command shape | What happens |
|---|---|---|
| Dry run (default) | `CREDENTIAL_KEK=<key> node scripts/restore-drill.mjs --backup-dir ./restore-in --target-db <staging-db>` | Decrypts and checks every part, converts to SQL, confirms one INSERT per backed-up row. Writes nothing to any database and never runs wrangler. |
| Apply | the same plus `--apply --confirm <staging-db>` | Also runs the SQL into the staging database with `wrangler d1 execute --remote`, then counts rows per table and compares them with the manifest. |

Safety rules built into the tool: the target name must contain `staging`, must not be the production database named in
`wrangler.jsonc`, and `--apply` needs `--confirm` with the exact same name. The decrypted SQL is deleted after the run unless
`--keep-sql`. No key and no row is printed. A missing value is reported as `unknown`, never `0`. The tool never labels itself
VERIFIED; the label in every report is NOT VERIFIED until a person reviews it.

## Trigger

- The scheduled drill (the interval is an owner decision, **[OPEN]**) or the go-live checklist item "practice restore".
- Before relying on a backup in a real incident, or after a change to the backup format, the migrations or `CREDENTIAL_KEK`.

## First 15 minutes (setup)

1. Decide who runs it and who reviews it (**[OPEN]**: who may authorize a restore). Start a stopwatch; the manual steps below
   are timed by the person, not by the script.
2. Make sure `CREDENTIAL_KEK` is the key the backup was encrypted with, taken from the copy kept outside Cloudflare. A backup
   that only decrypts with the key stored in the same account proves nothing about a bad day. Never paste the key into a ticket.
3. Pick the backup: newest `manifest.json` and `part-NNNN.json` files under `control-plane/<date>/<id>/` in the `BACKUPS` bucket.
   Check it with the staff backups page first (Verify).
4. Confirm the staging database exists and is **empty of data but migrated**. If not, you create it in step 3 of the procedure
   (and time it).

## Procedure

Time each step. Record minutes for the four manual ones; the script times the rest.

1. **download**: copy `manifest.json` and every part file into one empty directory, for example `./restore-in`. Minutes: ___
2. **dry run** (no stopwatch needed, no risk):

```sh
CREDENTIAL_KEK=<key> node scripts/restore-drill.mjs --backup-dir ./restore-in --target-db <staging-db> --drill-id <id>
```

   Stop here if it fails. A hash mismatch means a corrupted or incomplete download; a count mismatch means the backup is not
   self-consistent. Both are findings, not things to work around.
3. **create_db**: create a fresh staging D1 database (`wrangler d1 create <staging-db>`). Minutes: ___
4. **migrate**: apply all migrations, `node scripts/migrate.mjs --db <staging-db> --remote`. Minutes: ___
5. **apply**, with your timings and the objective if the owner has set one:

```sh
CREDENTIAL_KEK=<key> node scripts/restore-drill.mjs --backup-dir ./restore-in --target-db <staging-db> \
  --apply --confirm <staging-db> --rto-minutes <n> --manual download=<min> --manual create_db=<min> --manual migrate=<min> --manual repoint=<min>
```

6. **repoint**: point a staging Worker's `LUMMET_DB` binding at the restored database, deploy it to staging only, and confirm
   it serves: sign in as staff, open the organizations list, open one site. Minutes: ___ (enter it as `--manual repoint=<min>` and
   run the apply report again, or edit the report's manual table by hand and say so).
7. Review `restore-drill-report.md` (written from `docs/RESTORE_DRILL_REPORT_TEMPLATE.md`). Delete `restore.sql` if `--keep-sql` was used.

## Do not

- Do not run `--apply` against production, ever. The tool refuses the production name; do not rename things to get past it.
- Do not restore into a database that has data you care about; `INSERT OR REPLACE` overwrites rows with the same key.
- Do not point production at a drill database. A real restore is the [D1 incident](d1-incident.md) procedure with its own approval.
- Do not paste the key, the SQL, a row, a customer name or an email into the report, a ticket or chat.
- Do not record a manual step you did not time. Leave it out; the total then stays `unknown`, which is the honest answer.
- Do not call the drill passed because the dry run passed. A dry run proves the backup is readable, not that a database comes back.

## Recovery and verification

The drill passes only when all of these hold, and each has evidence attached:

1. Dry run and apply both ended without a failed step; the apply report status is `APPLIED, PENDING OWNER REVIEW`.
2. Row counts per table match the manifest (the report's verify line). A mismatch fails the drill; find out why before repeating.
3. The staging Worker served real requests from the restored database (screenshot or request ids), after the repoint step.
4. All four manual timings were recorded, so the report shows a total recovery time rather than `unknown`.
5. The total is compared with the restore-time objective **only if the owner has set one**. With no objective the report says
   "no objective supplied"; that is a result, not a pass.
6. The owner records the outcome under the evidence label VERIFIED IN STAGING, with the report, the request ids and the date,
   in the go-live record. Until then the label stays NOT VERIFIED.

What the drill does not prove: point-in-time recovery (use D1 Time Travel for that and test it separately), data written after the
export, that the export is a consistent snapshot (tables are read one after another), or anything about R2 contents.

## Record the incident

Drill id, UTC start and end, who ran it and who reviewed it, backup id and its age in hours at drill start, the four manual
timings, the script timings, the total, the objective (or "none"), the verify result, the staging Worker request ids, findings,
and the follow-ups with owners. Keep the report file with the go-live record.

## Who and how (placeholders)

**[OPEN]** Owner decisions, registered in `docs/PLACEHOLDERS.md` (Round 6.5B): the restore-time objective (`RESTORE_RTO_MINUTES`
or `--rto-minutes`; none is assumed), the recovery-point objective (how much data loss is acceptable; none is assumed), who may
authorize a restore, who is paged and how, and the drill interval.

## Evidence status

TESTED LOCALLY: the dry run, the apply path against a stand-in database, the refusal rules and the report contents
(`test/runbooks-restore-drill-6-5b.test.js`). NOT VERIFIED: no drill has been run against real D1 or R2, no recovery time has
been measured, and AT-15 stays open until the owner attaches evidence.

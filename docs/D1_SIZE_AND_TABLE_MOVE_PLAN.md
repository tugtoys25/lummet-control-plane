# D1 size check and plan to move high-volume tables (Round 6.5C, release 2.6.0.14)

**This is a plan. Nothing is moved by this release.** The release adds a read-only size check and this document. Every statement
about current behavior is from reading the code (**STATIC REVIEW**). No size, row count or limit was measured on a real
database: every number is **NOT VERIFIED** until the owner runs the check against staging and production and attaches the output.

## 1. The check

`scripts/d1-size-check.mjs` lists table names and counts rows. It reads no row contents and writes nothing.

```
node scripts/d1-size-check.mjs --collect <d1-db-name> --remote --env staging
node scripts/d1-size-check.mjs --input snapshot.json --json
```

- Policy: `config/d1-size-policy.v1.json`. It ships unconfirmed. The maximum size of one D1 database on the owner's plan
  (`limitBytes`) is an owner fact from Cloudflare's published limits for that plan; it is not assumed here, so the database
  status reads `unknown` until it is set. The warn and critical percentages and the per-table row limits are placeholders.
- Output format `lummet-d1-size-check/1` (JSON, or the fixed text layout). `MOVE NEEDED` is `yes`, `no` or `unknown`.
  `no` is printed only when the size limit is known and every high-volume table is graded and below its limits.
- Exit codes: 0, 1 at or above `--fail-on` (default critical), 2 usage, 3 unknown with `--require-known`.
- `COUNT(*)` reads every row of a table. On a very large table that costs rows read; run it off-peak.
- The size comes from `wrangler d1 info`. That call was not run against a real database from the build environment, so if it
  returns no size the report says `unknown` (use `--database-bytes`).

## 2. What exists today (STATIC REVIEW)

| Table | What writes it | Retention in code today |
|---|---|---|
| `request_errors` | one row per 5xx or unhandled exception (`worker/repositories/request-errors.js`) | purged after 14 days by the maintenance tick |
| `lummet_audit_logs` | every audited action (`worker/audit.js`) | `pruneOldAuditLogs` in `worker/cron.js` deletes rows older than 180 days from the scheduled handler. `pruneAuditLogs` in `worker/audit.js` (default 90 days) has no caller |
| `email_outbox` | every queued email (`worker/email.js`) | no scheduled purge. Erasure deletes queued or failed rows for one person (`worker/erasure.js`). The encrypted body is cleared once sent, the row stays |
| `email_webhook_events` | provider delivery events (`worker/repositories/billing-notifications.js`) | `pruneWebhookEvents` (default 30 days) exists and has no caller |

`billing_notifications` is also email history. It is small per event and is not in the policy list; add it if the check shows it growing.
Of the four, only `email_outbox` and `email_webhook_events` appear to grow without a scheduled purge. Confirm with the
check before acting: this is code reading, not measurement.

## 3. Options, smallest change first

1. **Enforce retention in place.** Wire the existing prune functions (and add one for sent `email_outbox` rows) to the
   scheduled handler, with the retention period as an owner-set setting. No new database, no copy. Try this first.
2. **Archive, then purge.** Export old rows to an encrypted object in R2 before deleting them. Needed only if the owner must keep
   history longer than the primary database should hold it.
3. **Second D1 database for noisy data.** A new binding (for example a logs database) for tables that are written often and
   never joined to money or access state. This is the move the blueprint names. It adds a binding, a migration set for
   the second database and a second backup path, so it is the last resort.

## 4. Per table

- **`request_errors`: best candidate to move.** Best-effort diagnostic data, no personal data by design, purged at 14 days, read by the
  `server_errors` alert (`worker/repositories/alert-state.js`) and `worker/observability.js`. Moving it means changing
  the repository and those two readers to use the second binding. Failure to write must stay non-fatal.
- **`lummet_audit_logs`: keep in the main database unless retention alone is not enough.** It is the system of record for staff and
  customer actions, read by staff pages, the customer audit CSV and the synthetic monitors. Moving it risks splitting the
  record and breaking the "every staff action is audited" rule. The copy streamed to logs (`docs/LOGPUSH.md`) is a copy, not a replacement.
  Prefer option 1 or 2.
- **Email history: split queue from history.** `email_outbox` is also the live queue (`status` queued, sent, failed, due index). Never move
  rows that are still queued. Only sent or terminal rows are candidates, and only after option 1 has been judged
  not enough.

## 5. Order of work for any move (a later, owner-approved round)

1. Owner sets `limitBytes`, the percentages and the row limits, and sets `confirmed` to true.
2. Run the check on staging, then on production, and attach both outputs.
3. Record a D1 Time Travel bookmark first (`scripts/record-d1-bookmark.mjs`).
4. Ship the change behind a flag that defaults to off, with the new write path in shadow (write to both, read from the old).
5. Compare counts, switch reads, stop the old writes, then purge the old rows only after a retention window the owner chooses.

## 6. Rollback and forward-fix

- Before the flag is switched to read from the new place: switch the flag off. The old table still holds everything.
- After the switch: the old table still holds the data until the final purge, so rollback is switching reads back. After the
  final purge there is no rollback; the forward-fix is to restore from the second database's backup or from an archive.
- Never change a shipped migration. A second database has its own migration sequence.

## 7. Owner questions (all `[OPEN]` in `docs/PLACEHOLDERS.md`)

1. What is the maximum size of one D1 database on your plan, and what warn and critical percentages do you want?
2. What row limit per high-volume table should count as warn and as critical?
3. How long must audit rows, sent email rows and delivery events be kept, and may they be archived to R2?
4. Is a second D1 database acceptable (cost, a second backup path), or should retention in place be tried first?

# Restore drill report {{DRILL_ID}}

**Evidence label: {{EVIDENCE_LABEL}}.** The drill is owner-run. This report is a measurement written by a script. It is not
evidence of a successful restore until the owner has reviewed it and attached the evidence listed at the end. Procedure:
`docs/runbooks/restore-drill.md` (AT-15).

| Field | Value |
|---|---|
| Release | {{RELEASE_ID}} |
| Generated (UTC) | {{GENERATED_AT}} |
| Mode | {{MODE}} |
| Status | {{STATUS}} |
| Target database | {{TARGET_DB}} |
| Backup id | {{BACKUP_ID}} |
| Backup created (UTC) | {{BACKUP_CREATED_AT}} |
| Backup age at drill start (hours) | {{BACKUP_AGE_HOURS}} |
| Tables in backup | {{TABLE_COUNT}} |
| Rows in backup | {{ROW_TOTAL}} |

## Script steps

| Step | Status | Seconds | Detail |
|---|---|---|---|
{{STEP_TABLE}}

Row-count comparison against the manifest: {{VERIFY_RESULT}}

Decrypted SQL file: {{SQL_RETAINED}}

## Recovery time

Manual steps are timed by the person running the drill. A step that was not timed is `unknown`; the total is then `unknown`,
never a smaller number.

| Manual step | Minutes |
|---|---|
{{MANUAL_TABLE}}

| Measure | Value |
|---|---|
| Script time (seconds) | {{SCRIPT_SECONDS}} |
| Total recovery time | {{TOTAL_RECOVERY}} |
| Restore-time objective | {{RTO_OBJECTIVE}} |
| Comparison | {{RTO_EVALUATION}} |

The restore-time objective and the recovery-point objective are owner decisions. [OPEN] until the owner supplies them
(`docs/PLACEHOLDERS.md`, Round 6.5B). No objective is assumed.

## Owner review (fill in by hand)

- Reviewed by: ______  Date (UTC): ______
- Staging Worker served requests from the restored database (request ids or screenshots attached): yes / no
- Findings and follow-ups (with owners): ______
- Outcome label after review: NOT VERIFIED / VERIFIED IN STAGING (only with the evidence above attached)

This report contains no key, no row content and no customer data. If you add any, remove it before filing the report.

# Logpush for Worker logs and audit rows (Round 6.3C, release 2.6.0.8)

Config as code and a runbook. The job itself is created by the owner in Cloudflare; this repository never calls Cloudflare for Logpush.

## Files
- `config/logpush-policy.v1.json`: the reviewed plan (dataset, field allowlist, fields that are never requested, placeholders for the owner's values). Ships with `enabled: false`.
- `scripts/logpush-config.mjs`: offline check and renderer. `node scripts/logpush-config.mjs` prints the plan; `--strict` exits 1 while any `[OPEN]` value remains; `--out file` writes the report. It never prints a destination and never contacts Cloudflare.

## Why the `Event` field is not requested
In the `workers_trace_events` dataset the `Event` field carries the full request URL. One-time tokens (email verification, password reset, invitation) can be in a query string. The plan requests `Logs` and `Exceptions` (what the Worker wrote) plus timing and outcome fields, and the checker refuses `Event`, request or response headers, cookies and client addresses.

## Secrets
- No credential is stored in the plan. The destination's credentials are entered in the Cloudflare dashboard or API only. The checker refuses a destination that already contains `key=value` credentials, `user:pass@` or a signed-URL signature.
- Turn `LOG_REDACTION=on` before enabling the job. It scrubs emails, IP addresses, JWTs, Bearer and Basic credentials, provider keys, secret-like pairs, card numbers and long mixed tokens from everything the Worker writes with `console.*`, so it never reaches the destination. It is a safety net over free text, not proof that no personal data is in a log.
- Staff and customer request bodies are never logged by the Worker.

## Audit rows
Logpush cannot read D1. With `AUDIT_LOG_STREAM=on` each audit row is also written once as one JSON log line with `"event":"audit"` and an allowlisted, scrubbed set of fields (action, resource, resource id, success, status code, method, path without query, request id, actor type, ids of the admin, tenant, organization and customer, reason and error text after scrubbing). `ip_hash` is not streamed. The D1 table stays the system of record; the stream is a copy. `AUDIT_LOG_STREAM=on` requires `LOG_REDACTION=on` (`check-config` fails production otherwise). Split audit lines from other logs at the destination by matching the string `"event":"audit"`.

## Owner steps (live, not done by this release)
1. [OPEN] Choose the destination (R2, an S3-compatible bucket or a SIEM) and the retention period; record both in the plan and in the data-retention policy.
2. [OPEN] Decide the sample rate (log volume is billed).
3. Set `LOG_REDACTION=on` (and `AUDIT_LOG_STREAM=on` if audit rows are wanted), deploy, and read a day of logs in Workers Logs to see what is in them.
4. Create the job in Cloudflare from `node scripts/logpush-config.mjs` output, using a destination credential that can only write to that destination. Enable it.
5. Check that the first batch contains `Logs`, `Exceptions` and no `Event` field, and that no email, address or token is present. Attach that evidence to `docs/GO_LIVE_RECORD.md`.
6. Rollback: disable the job in Cloudflare; set `AUDIT_LOG_STREAM=off`. Nothing in the database changes.

## Evidence status
TESTED LOCALLY: plan validation, checker, audit stream, redaction wiring (`test/logpush-policy.test.js`, `test/edge-logging-6-3c.test.js`). NOT VERIFIED: any live Logpush job, destination delivery, field availability in the owner's Cloudflare plan, retention at the destination. Whether Logpush for Workers is available on the owner's plan is an [OPEN] owner fact.

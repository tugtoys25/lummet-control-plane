# CSP violation reporting and review (Round 6.3C)

`CSP_MODE` stays `report-only` by default. This round does **not** change that; it provides the evidence needed to decide.

## Collection
Browsers POST reports to `/api/csp-report` (no auth, always 204, stored nowhere). Each report becomes one JSON log line.
`CSP_REPORT_MODE`:
- `basic` (default): the 2.6.0.7 behaviour (four fields, query dropped).
- `full`: also accepts Reporting API batches (`application/reports+json`, max 10 per request), adds `disposition`, `source`, `line`, `format`; replaces ids and tokens in paths; never logs script samples, the original policy, nonces, query strings or fragments. Adds `report-to` and a same-origin `Reporting-Endpoints` header, and keeps reporting on the enforced policy after a later flip. A flood cap (`CSP_REPORT_MAX_PER_MINUTE`, default 60 per isolate, 0 = unlimited) logs one `csp_violation_suppressed` marker per minute when it drops reports.
Only the script policy is reported; the always-enforced base policy is not.

## Review procedure (staging, then production)
1. Set `CSP_REPORT_MODE=full` on staging. Collect logs: `wrangler tail --format json > tail.ndjson`, or Logpush files once configured.
2. Visit every page type in a real browser: portal login, signup, dashboard pages, billing, team, sites, domains, developer, staff console pages, public site pages, token pages (verify, reset, invitation). Silence on pages nobody opened proves nothing.
3. Run: `node scripts/csp-report-review.mjs tail.ndjson --from <start ISO> --to <end ISO>`.
4. Verdicts: `VIOLATIONS_FOUND` (fix or consciously accept each group), `INCOMPLETE` (flood cap dropped reports), `WINDOW_TOO_SHORT`, `NO_INPUT`, `NO_VIOLATIONS_IN_WINDOW`.
5. Only after a clean window **and** a human sign-off, an owner may set `CSP_MODE=enforce` for that environment. The shipped default is never flipped by a release.
Minimum window: default 7 days is a placeholder. [OPEN] owner decides the real value.

## Evidence labels
Parsing, scrubbing, headers, review tool: TESTED LOCALLY. Real-browser behaviour and any staging/production log evidence: NOT VERIFIED.

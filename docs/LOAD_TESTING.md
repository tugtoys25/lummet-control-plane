# Load and concurrency testing (roadmap 2.5)

Every automated test in this project runs on an in-memory SQLite stand-in.
That is right for logic, but it cannot tell you how real D1 behaves under
concurrent writes. This harness is for running against a **staging** copy of
the platform (a separate Worker and a separate D1 database). **Never run it
against production**: it creates and deletes data.

The harness itself is verified by `test/loadtest-harness.test.js` (it seeds a
database, starts an in-process copy of the Worker, and runs every scenario).
What has NOT been done from the build environment: any run against real
Cloudflare. The numbers below are things to measure, not results.

## 1. Seed staging

```
LOADTEST_PASSWORD='a-long-throwaway-password' node scripts/loadtest-seed.mjs --users 50 > seed.sql
wrangler d1 execute <STAGING-DB-NAME> --remote --file seed.sql
```

Creates 50 users (`lt-N@loadtest.invalid`), each with its own organization and
active subscription, plus one shared organization every user administers. It
seeds with SQL rather than the signup API on purpose: signup and login are rate
limited per IP, and a load test comes from one IP. Leaving the limits on is how
production behaves.

## 2. Run the scenarios

```
LOADTEST_PASSWORD='...' node scripts/loadtest.mjs \
  --base https://<staging-host> --allow-host <staging-host> \
  --scenario <name> --users 50 --concurrency 20 --duration 30 \
  --max-error-rate 0.01 --p95-ms 1000
```

`--allow-host` is required for any non-localhost target; it is a typo guard,
not a security control. The exit code is 1 when a threshold is exceeded.

| Scenario | What it does | What it tells you |
|----------|--------------|-------------------|
| `portal-read` | Portal pages and JSON reads | Baseline latency; read capacity |
| `write-own` | Create then revoke an API key, spread across 50 organizations | Normal write traffic shape |
| `write-hot` | Every user creating keys in ONE organization | Worst case for D1's single writer; look for 5xx, lock errors, latency growth |
| `login` | Password sign-in (PBKDF2) | CPU cost of sign-ins, see below |
| `ops-ping` | The alert and backup pinger tick (needs `ALERT_CHECK_TOKEN`) | That the tick stays cheap |

Suggested ladder for each scenario: concurrency 5, 10, 25, 50, 100 for 30
seconds each. Stop going up when error rate passes 1% or p95 passes your budget;
that concurrency is the knee.

## 3. Reading the output

`statuses` is a histogram of HTTP codes (0 = network error or timeout).
`serverErrors` counts 5xx and network failures. `rateLimited` (429) is shown
separately and is **not** counted as an error. `unexpected` counts other
non-success codes such as 404, 403 or 422: usually a seed or config problem,
not load. `ms` has p50/p95/p99/max.

**Cloudflare error pages count as failures.** Status 503 or 1xxx errors in the
Worker logs (`wrangler tail`) mean you hit CPU or subrequest limits, which is
exactly what this test is for.

## 4. Things to expect and check

- **`login` is the CPU test.** Each login runs PBKDF2 (100,000 iterations). On
  the Workers Free plan the CPU limit is about 10 ms per request, which can fail
  sign-ins outright; paid plans allow much more. If `login` shows 5xx at low
  concurrency, this is why, and it is a plan limit, not a bug.
- **Database size changes everything.** Seed a realistic number of rows into
  the big tables (audit logs, usage events, jobs, email outbox) before judging
  read latency. A test on an empty database flatters you.
- **Writes are serialized per database.** `write-hot` shows the ceiling. If it
  is too low, the usual fixes are batching writes, removing per-request audit or
  cleanup writes, or moving noisy data to its own database.
- **Known per-request writes worth knowing about:** every login runs a cleanup
  `DELETE` on the auth-attempts table, and every audited action inserts an audit
  row. These are cheap but they are writes.
- **The AI credit ledger race** (`reserveCredits`, a conditional insert) is not a
  scenario here, because it needs a real model call and spends money. Test it
  separately: grant an organization N credits, fire more than N parallel AI
  requests with a throwaway test provider, and confirm the balance never goes
  negative and exactly N succeed.
- **Control-plane backup under load:** run `ops-ping` while `write-own` runs,
  after reducing the backup interval on staging, to see whether the export
  disturbs live traffic.

## 5. Clean up

```
node scripts/loadtest-seed.mjs --cleanup > cleanup.sql
wrangler d1 execute <STAGING-DB-NAME> --remote --file cleanup.sql
```

Audit-log rows written during the test remain (they are append-only).
Emails queued to `@loadtest.invalid` addresses will fail to send and can raise
the "emails that could not be delivered" alert; clear the outbox on staging
afterwards or turn staging alerts off for the run.

## 6. Pass criteria to agree on before you start

Write these down first, so the result is a decision rather than a debate. A
reasonable starting set: `portal-read` p95 under 500 ms and under 1% errors at
the concurrency you expect at your busiest minute, times three; `write-hot`
no 5xx at 25 concurrent writers; `login` no failures at 10 per second.

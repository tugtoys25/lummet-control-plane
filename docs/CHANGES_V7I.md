# v7I: observability, and less direct SQL

Tests: control plane 927 (v7H) -> 939, tenant 924 (unchanged), all passing. SQL ratchet 484 -> 466.

## A hole closed first
The top-level error handler swallowed every unhandled exception: a generic 500 and no trace anywhere (no log, no record).
A production failure would have been invisible. Now every failure is logged, recorded, alerted on, and has a reference the
customer can quote.

## What you get
- **Request id on every response.** `X-Request-Id` (a fresh UUID made by the Worker; an id sent by the client is ignored, so logs
  cannot be forged). The same id is stored in audit rows. A failed page says "quote this reference: <id>", a failed JSON call
  includes `requestId`. Every response also carries `Server-Timing: app;dur=<ms>`.
- **One structured JSON log line per failure** (`unhandled_exception` or `server_error`: request id, method, route, status,
  duration, error name, trimmed message, first stack frames) and per slow request (`slow_request`, default 2000 ms,
  `SLOW_REQUEST_MS`). `LOG_REQUESTS=all` logs every request (billed log volume, so off by default).
- **Never logged or stored:** query strings, headers, cookies, request/response bodies, user input. The route is the path with
  ids and tokens replaced by placeholders (`/api/organizations/:id/sites/:n/...`), so it can be grouped without leaking anything.
- **`request_errors` table (migration `0044`)**: one row per 5xx or unhandled exception, capped at 100 rows a minute so a flood
  stays one incident, purged after 14 days by the maintenance tick.
- **Staff > Server errors** (`/platform/saas/errors`): last 24 hours by route, and the 100 most recent, with request ids.
- **Alert `server_errors`**: 5 or more within 15 minutes (fewer is noise); it clears by itself. Count only, as every alert.

## Direct SQL moved into repositories (484 -> 466)
`api-keys.js`, `branding.js` and `change-requests.js` no longer contain SQL; it lives in `repositories/api-keys.js`,
`branding.js`, `change-requests.js` with the same statements and behavior (their existing tests pass unchanged). 466 calls in
46 files remain; the ratchet only allows that number to go down.

## Not in v7I (said plainly)
- No external error tracker (Sentry or similar). Logs go to Workers Logs; `request_errors` and the alert cover the "tell a human"
  minimum. A tracker can be added behind `observe()` without touching callers.
- No latency percentiles or dashboards. There are slow-request logs and the Server-Timing header, not aggregated metrics.
- Tenant Workers keep their own logging; this covers the control plane.
- Most direct SQL is still in place (466 calls).

## Using it
A customer sends you a reference: search the Worker logs for `request_id` = it, and open Staff > Server errors for the row.
Apply migration `0044`. No new required settings (`LOG_REQUESTS` and `SLOW_REQUEST_MS` are optional).

# Error tracking (Round 6.3C, release 2.6.0.8)

Optional. Off by default. Nothing is sent anywhere unless the owner turns it on.

## Settings
| Setting | Kind | Meaning |
|---|---|---|
| `ERROR_TRACKING` | var | `off` (default), `shadow`, `on`. Must be set explicitly in production (`check-config`). |
| `SENTRY_DSN` | **secret** (`wrangler secret put SENTRY_DSN`), never a var | Address of the tracker project. Any service that speaks the Sentry envelope protocol works. Must be a public HTTPS address with a public key; IP addresses, `localhost` and internal names are refused. |
| `ERROR_TRACKING_APPROVED` | var | Must be `yes` before production may run with `ERROR_TRACKING=on`. Record it only after the tracker is approved as a sub-processor (see below). |
| `ERROR_TRACKING_MAX_PER_MINUTE` | var, optional | Cap on events per minute. Default 30, `0` = unlimited. |
| `ERROR_TRACKING_RELEASE` | var, optional | Release label added to events (for example `2.6.0.8`). Omitted when unset. |

## Modes
- `off`: nothing is built, logged or sent.
- `shadow`: the event is built and scrubbed, and one summary line (`error_tracking_shadow`: event id, size, route, error type) is logged. Nothing leaves the Worker; no DSN is needed. Use it to look at what would be sent.
- `on`: one scrubbed event per error is POSTed to the tracker after the response has been sent (the caller never waits for it), with a 2-second timeout, no redirects and no retry. A failing tracker produces one log line with a reason code (`http_429`, `network`, ...) and never the DSN.

## What is reported
Unhandled exceptions in request handling and in the scheduled handler (which is still re-thrown, so Cloudflare keeps its own record). A response that is merely a 5xx without an exception is not reported.

## What an event contains, and what it never contains
Contains: error type; message and stack frames after scrubbing (function name, bare file name, line number); request id; method; route with ids and tokens replaced (`/api/organizations/:id/...`); status; environment; optional release.
Never contains: request URL or query string, headers, cookies, request or response bodies, user, IP address, server name, environment variables, breadcrumbs, or any free-form extra data. Every string passes through `worker/redact.js` (emails, IP addresses, JWTs, Bearer and Basic credentials, provider keys, secret-like `key=value` pairs, card numbers, long mixed tokens). The event id is 32 decimal digits.

**Limit:** the scrubber is a safety net over free text. Names, street addresses, free-form sentences and secret shapes that are not in its list pass through. Treat the tracker as a place that can receive small amounts of personal data, and decide accordingly.

## Limits
The same error on the same route is sent once a minute. The per-minute cap applies across all errors. Both counters live in the Worker isolate, so they bound a flood per isolate, not globally.

## Rollout
1. Set `ERROR_TRACKING=shadow`, deploy, read the `error_tracking_shadow` lines for a few days, and check the route and type fields look right.
2. [OPEN] Owner: choose the provider and region, create a project, and approve it as a sub-processor (update the sub-processors legal page through counsel).
3. `wrangler secret put SENTRY_DSN`, set `ERROR_TRACKING_APPROVED=yes`, then `ERROR_TRACKING=on`.
4. Rollback: set `ERROR_TRACKING=off`. No data migration, nothing to undo in the database.

## Evidence status
TESTED LOCALLY: DSN parsing, scrubbing, modes, limits, timeout, wiring (`test/error-tracking.test.js`, 21 tests). NOT VERIFIED: delivery to a real tracker, wire compatibility with the chosen provider, the provider's own retention and scrubbing settings. [OPEN] provider and DSN choice (the round prompt said `[INSERT]`).

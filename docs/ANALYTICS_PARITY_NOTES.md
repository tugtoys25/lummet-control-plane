# Control Plane Analytics Parity — Implementation Notes

Closes the six gaps confirmed in the earlier audit. All additive; nothing
removed from either repo.

**Verified on the merged result:**
| Suite | Result |
|---|---|
| `lummet-tenant` (`node --test --test-concurrency=1 test/**/*.test.js`) | **677/677 passing** |
| `lummet-control-plane` (`npm test`) | **271/271 passing** |

---

## 1. Tenant — Super API v15

**`worker/super/handlers-analytics.js`** (modified)
- `handleAnalyticsOverview` now adds a `name` field to every row (dimensionId is unchanged) via a new `resolveDimensionNames(db, dimensionType, ids)` — a fixed table/column map (`casinos.name`, `affiliate_partners.name`, `reviews.title`, …), batched at 90 ids per query (D1's 100-bound-parameter limit), never built from request input. A deleted/renamed dimension yields `name: null`, never an error.
- `handleAnalyticsGeo` (new) — wraps the existing `getGeoPerformance()`, the same function the tenant dashboard's own `/analytics/geo` already uses.
- `handleAnalyticsHealth` (new) — wraps `getCronHealth()`.
- `handleAnalyticsAggregate` / `handleAnalyticsEvaluateAlerts` / `handleAnalyticsRunDueReports` (new) — the tenant dashboard's "Run Aggregation Now" / evaluate-alerts / run-due-reports actions, each recording a `cron-health` row via `recordCronRun`.

**`worker/super/router.js`** — 5 new routes, all under the existing `analytics` capability flag:
```
GET  /en/api/super/analytics-geo
GET  /en/api/super/analytics-health
POST /en/api/super/analytics-aggregate
POST /en/api/super/analytics-evaluate-alerts
POST /en/api/super/analytics-run-due-reports
```

**`worker/super/capabilities.js`** — bumped to **v15**.

**`test/super-api-analytics-parity.test.js`** (new, 8 tests) — route registration, name resolution (including SQL-injection-shaped dimensionType/ids never reaching a query), a deleted dimension yielding `null`, GEO date-range validation, health job statuses, aggregate date validation + cron-health recording, evaluate-alerts.

## 2. Control Plane — Analytics page rewrite

**`worker/views/pages/analytics.js`** — rewritten. Every gap from the audit:

| Gap | Fix |
|---|---|
| Raw IDs instead of names | `dimensionLabel()` shows `row.name`, falling back to `#id` only when the dimension no longer exists |
| No totals cards | `renderTotalsCards()` — views/clicks/conversions/revenue/commission, refusing to sum money across mixed currencies (shows "mixed currencies" instead of a misleading total) |
| No GEO table | `renderGeoTable()`, calling the new `analytics-geo` endpoint |
| No alerts | Open alerts (`alerts?status=open`) embedded directly, plus a link to the existing Alerts page |
| Unformatted rates/money | `fmtPct()` (2-decimal %), `fmtMoney()` (2-decimal + currency suffix), `fmtNum()` (thousands separators) applied throughout |
| — | Also added: System Health section (surfaces *why* numbers look empty — a stale/disabled/never-run job), tracking-link health, and a permission-gated "Manual runs" panel (aggregate / evaluate alerts / run due reports) — the dashboard's own actions, now central |

Every section loads independently (`Promise.all`), so one tenant not yet redeployed with v15 degrades that one section to a clear message — `sectionErrorV15Aware()` overrides the generic "not found" message specifically for a 404 on a v15-only route, since that almost always means "not deployed yet," not "no data."

**`worker/index.js`** — new `POST /api/analytics/:kind` route (permission `tenant/analytics/create`, fully audited), dispatching to `submitAnalyticsRun()`.

**`test/analytics-page.test.js`** (new, 21 tests) — every formatting/rendering helper in isolation, mixed-currency safety, empty states, `submitAnalyticsRun` fail-closed and unknown-kind rejection, and two full-page assembly tests against a mocked tenant (one all-success, one with a 404'd section proving graceful degradation with no `undefined` leaking into the HTML).

## 3. Control Plane — Reports column picker + grouping

**`worker/views/pages/reports.js`** — the run panel now loads the tenant's real column manifest live (`GET report-column-options?report_type=`) when a report type is picked: a checkbox per column (unchecked = excluded; all-checked or none-checked = every column) and a "Group by" dropdown populated only from columns the manifest marks `groupable: true`. Both are sent through to the existing `runReport` call (`selectedColumns`, `groupBy`) — no new tenant-side logic, this wires up parameters `runReport` already accepted.

Added `fetchReportColumnOptions(env, admin, reportType)`.

**`worker/index.js`** — new `GET /api/reports/column-options` proxy route (permission `tenant/reports/read`).

**`test/reports-column-options.test.js`** (new, 1 test) — fail-closed with no active tenant.

## 4. Route audit — confirmed correct as reported

The earlier "false alarm" on `/en/api/super/ai/availability` was re-verified: it's a path-constant artifact in the audit script, not a real mismatch. No other route mismatches exist between the Control Plane and the tenant's Super API router.

---

## 5. Files touched

```
lummet-tenant/en/worker/super/handlers-analytics.js   (modified)
lummet-tenant/en/worker/super/router.js                 (modified)
lummet-tenant/en/worker/super/capabilities.js            (modified)
lummet-tenant/en/test/super-api-analytics-parity.test.js (new)

lummet-control-plane/worker/index.js                     (modified)
lummet-control-plane/worker/views/pages/analytics.js       (modified)
lummet-control-plane/worker/views/pages/reports.js           (modified)
lummet-control-plane/test/analytics-page.test.js               (new)
lummet-control-plane/test/reports-column-options.test.js         (new)
```

Nothing else in either repo was touched.

## 6. A note on tenant test flakiness

The tenant suite is run above with `--test-concurrency=1`. As found last
session, `node --test`'s default file-level concurrency can crash a whole
test file under Termux's memory pressure (not a code bug). If your
device's `package.json` test script doesn't already pin concurrency,
consider adding it there so this doesn't need remembering by hand.

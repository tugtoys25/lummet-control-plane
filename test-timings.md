# Per-file test timing and handle-leak report

Generated: 2026-10-26T10:19:51.725Z
Files selected: 2; tests: 1; passed: 1; failed tests: 0; skipped: 0; todo: 0; cancelled: 0; failing files/timeouts/forced exits: 1; per-file timeout: 20000ms
Force-exit allow-list: none

| Test file | Tests | Passed | Failed | Skipped | Duration | Result | Natural exit |
|---|---:|---:|---:|---:|---:|---|---|
| `test/migrate.test.js` | 0 | 0 | 0 | 0 | 40217 ms | FORCED_EXIT | HANGS; forced retry diagnostic only |
| `test/phase3-migrations.test.js` | 1 | 1 | 0 | 0 | 2452 ms | PASS | exits naturally |

## Files requiring `--test-force-exit`
- `test/migrate.test.js` — natural process exit failed within 20000 ms; fails the suite unless explicitly allow-listed with justification.

Total tests: 1; passed: 1; failed: 0; skipped: 0; todo: 0; forced_exit: 1; failed files: 1
Exit status: 1

# Repositories

SQL lives HERE, not in business-logic modules. A repository is a small set of
functions that take `env` and return plain objects; the business module decides
*what* should happen and the repository knows *how it is stored*. This is the
boundary that would let the control plane move to another database later.

Status (roadmap 2.6): the boundary and its enforcement exist; migration is
incremental. `docs/sql-baseline.json` records, per file, how many direct
`.prepare(` calls remain. `test/sql-boundary.test.js` fails if any file gains
SQL, if a new file under `worker/` (other than `repositories/`) contains any, or
if a converted file regresses. When you convert a file, lower its baseline with
`node scripts/sql-ratchet.mjs --update`.

Converted so far: coupons, SSO email domains, alert state and health counts.

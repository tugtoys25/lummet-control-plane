> **v7A note:** this document was written for the standalone public-site codebase, where the migrations were numbered 0006-0010. In v7A they are **0033_public_site_schema, 0034_seed_lummet_content, 0035_contact_demo_forms, 0036_signed_in_header, 0037_repair_select_options** and are applied by the normal runner (`node scripts/migrate.mjs`, which deploy.yml runs). Ignore any instruction here to copy files into another repo or to run the old manual migration workflow.

# Release: maintenance (control plane)

Built on `main` @ **2bd2d32** (the signed-in header release you pushed). Only `lummet-control-plane` changes; the tenant is untouched.

## What changed

1. **Dropdown repair (migration 0010).** The contact "What is this about?" and demo "Number of digital properties" lists need one option per line.
   If the live database lost the line breaks, visitors saw one long option. The migration rewrites those two lists, only when they have no line break,
   so an already-correct list or one you edited in the dashboard is never touched. Safe to re-run.
2. **CI runner pinned.** Both workflows use `ubuntu-24.04` instead of `ubuntu-latest` (which becomes Ubuntu 26 on 2026-10-19), and `actions/checkout` and
   `actions/setup-node` move from v4 to v5 (the Node 24 versions). `actions/upload-artifact@v4` is unchanged.
3. **Cleanup, no behavior change.** Comments in `worker/index.js` and `worker/public-site/router.js` that still said the dashboard lives at `/` now describe the real routes,
   and the unused `isAdmin` argument was removed from `handlePublicRoute` and its caller (tests updated).

## Numbers

Counted with `git diff --numstat` against 2bd2d32, excluding the three generated files
(`docs/RELEASE_MAINTENANCE.md`, `docs/integration/baseline.sha256`, `docs/integration/removed.txt`).

| | Files | Lines added | Lines deleted |
|---|---:|---:|---:|
| **Total** | **11** | **81** | **40** |
| New files | 1 | 9 | 0 |
| Modified (touched) files | 10 | 72 | 40 |
| Deleted files | 0 | 0 | 0 |

Most deleted lines are in `worker/index.js` and `worker/public-site/router.js` (outdated comments and the unused argument, replaced by corrected text) and in the two workflow files (the runner and action version lines).

**Tests: 373 passing** (371 before; 2 new for migration 0010: repairs flattened lists, safe to run twice, leaves an edited list and the seeded lists alone).

## Migrations

One: `migrations/0010_repair_select_options.sql` (2 UPDATE statements, guarded). The manual migrate workflow applies it too. SQL for the D1 console (no comments):

```sql
UPDATE lummet_form_fields SET options = 'Platform question' || CAST(X'0A' AS TEXT) || 'Partnership opportunity' || CAST(X'0A' AS TEXT) || 'Technology licensing' || CAST(X'0A' AS TEXT) || 'Other' WHERE form_key = 'contact' AND field_key = 'topic' AND options IS NOT NULL AND instr(options, CAST(X'0A' AS TEXT)) = 0;
UPDATE lummet_form_fields SET options = '1' || CAST(X'0A' AS TEXT) || '2 to 5' || CAST(X'0A' AS TEXT) || '6 to 10' || CAST(X'0A' AS TEXT) || 'More than 10' WHERE form_key = 'demo' AND field_key = 'properties' AND options IS NOT NULL AND instr(options, CAST(X'0A' AS TEXT)) = 0;
```

## New files (1)

| File | + | - |
|---|---:|---:|
| `migrations/0010_repair_select_options.sql` | 9 | 0 |

## Modified files (10)

| File | + | - |
|---|---:|---:|
| `.github/workflows/deploy.yml` | 3 | 3 |
| `.github/workflows/migrate-public-site.yml` | 7 | 4 |
| `DEPLOYMENT.md` | 3 | 0 |
| `README.md` | 6 | 0 |
| `test/inquiries-admin.test.js` | 2 | 2 |
| `test/public-site.test.js` | 2 | 2 |
| `test/session-status.test.js` | 32 | 0 |
| `test/support/public-env.js` | 2 | 2 |
| `worker/index.js` | 11 | 22 |
| `worker/public-site/router.js` | 4 | 5 |

## Deleted files

None.

## Install on the phone (Termux)

Pick ONE way.

```bash
cd ~/lummet/lummet-control-plane && git status --short
unzip -p ~/storage/downloads/lummet-control-plane-v7-maintenance-full.zip lummet-control-plane/docs/integration/integrate.sh > ~/integrate.sh
bash ~/integrate.sh check ~/storage/downloads/lummet-control-plane-v7-maintenance-full.zip ~/lummet/lummet-control-plane
bash ~/integrate.sh apply ~/storage/downloads/lummet-control-plane-v7-maintenance-full.zip ~/lummet/lummet-control-plane
```

or the patch:

```bash
cd ~/lummet/lummet-control-plane && git status --short
git apply --check ~/storage/downloads/lummet-control-plane-v7-maintenance.patch
git apply ~/storage/downloads/lummet-control-plane-v7-maintenance.patch
```

## Test, then commit

```bash
cd ~/lummet/lummet-control-plane && npm test 2>&1 | tail -12
git add -A && git status --short && git diff --cached --stat | tail -1
git commit -m "Maintenance: repair select options, pin CI runner, clean up stale comments"
git push origin main
```

Run the SQL above in the D1 console first, then push.

## Check it

```bash
sleep 90; gh run list --limit 1
curl -s https://YOUR-DOMAIN/contact | grep -c "<option"
curl -s https://YOUR-DOMAIN/demo | grep -c "<option"
```

Expect the deploy run to succeed, and the `/contact` and `/demo` option counts to include 4 each (plus any default blank option).

## Rollback

```bash
cd ~/lummet/lummet-control-plane && git revert --no-edit HEAD && git push origin main
```

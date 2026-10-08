> **v7A note:** this document was written for the standalone public-site codebase, where the migrations were numbered 0006-0010. In v7A they are **0033_public_site_schema, 0034_seed_lummet_content, 0035_contact_demo_forms, 0036_signed_in_header, 0037_repair_select_options** and are applied by the normal runner (`node scripts/migrate.mjs`, which deploy.yml runs). Ignore any instruction here to copy files into another repo or to run the old manual migration workflow.

# Release: "Sign in" becomes "Dashboard" for signed-in staff (control plane)

Built on `main` @ **ad22a1d** (the site-access release you pushed). Only `lummet-control-plane` changes; the tenant is untouched.

## What changed

- On the public site, when a staff member is signed in, the header's **Sign in** button becomes **Dashboard** and opens `/dashboard`.
  It changes in the desktop header and in the mobile menu. Visitors who are not signed in still see **Sign in**.
- Public pages stay cached and identical for everyone. A small script asks a new endpoint, `GET /session-status`, which returns only
  `{"signedIn": true|false}`, is never cached, and does not touch the database when there is no session cookie.
- The words come from the database (`signed_in_label` = Dashboard, `signed_in_href` = /dashboard) so nothing is hardcoded and you can edit them under Interface text.
- If the migration has not been run, or the check fails, the page simply keeps showing **Sign in**. Nothing breaks.
- Access control is unchanged: `/dashboard` still requires a real session.

## Numbers

Counted with `git diff --numstat` against ad22a1d, excluding the three generated files
(`docs/RELEASE_SIGNED_IN_HEADER.md`, `docs/integration/baseline.sha256`, `docs/integration/removed.txt`).

| | Files | Lines added | Lines deleted |
|---|---:|---:|---:|
| **Total** | **10** | **172** | **2** |
| New files | 3 | 124 | 0 |
| Modified (touched) files | 7 | 48 | 2 |
| Deleted files | 0 | 0 | 0 |

**Tests: 371 passing** (364 before; 7 new: `/session-status` for visitor, valid, bad and expired sessions, only the flag exposed, no database use without a cookie,
pages identical for everyone and carrying the label, label editable in the database, script has no strings of its own, migration safe to re-run and keeps an edited label).
Also checked in a real browser (Chromium) at 1280px and 390px: visitor sees Sign in; signed-in sees Dashboard in both places.

## Migrations

One: `migrations/0009_signed_in_header.sql` (2 rows into `lummet_ui_strings`, `INSERT OR IGNORE`, safe to re-run, never overwrites an edit).
The manual workflow `migrate-public-site.yml` now applies it too. SQL for the D1 console (no comments):

```sql
INSERT OR IGNORE INTO lummet_ui_strings (ui_key, value, group_key) VALUES ('signed_in_label', 'Dashboard', 'layout'), ('signed_in_href', '/dashboard', 'layout');
```

## New files (3)

| File | + | - |
|---|---:|---:|
| `migrations/0009_signed_in_header.sql` | 5 | 0 |
| `public/static/js/session.js` | 36 | 0 |
| `test/session-status.test.js` | 83 | 0 |

## Modified files (7)

| File | + | - |
|---|---:|---:|
| `.github/workflows/migrate-public-site.yml` | 4 | 1 |
| `DEPLOYMENT.md` | 3 | 0 |
| `README.md` | 7 | 0 |
| `docs/PUBLIC_SITE.md` | 9 | 0 |
| `public/templates/layout/base.html` | 1 | 0 |
| `public/templates/layout/header.html` | 1 | 1 |
| `worker/index.js` | 23 | 0 |

## Deleted files

None.

## Install on the phone (Termux)

Pick ONE way.

```bash
cd ~/lummet/lummet-control-plane && git status --short
unzip -p ~/storage/downloads/lummet-control-plane-v6-signed-in-header-full.zip lummet-control-plane/docs/integration/integrate.sh > ~/integrate.sh
bash ~/integrate.sh check ~/storage/downloads/lummet-control-plane-v6-signed-in-header-full.zip ~/lummet/lummet-control-plane
bash ~/integrate.sh apply ~/storage/downloads/lummet-control-plane-v6-signed-in-header-full.zip ~/lummet/lummet-control-plane
```

or the patch:

```bash
cd ~/lummet/lummet-control-plane && git status --short
git apply --check ~/storage/downloads/lummet-control-plane-v6-signed-in-header.patch
git apply ~/storage/downloads/lummet-control-plane-v6-signed-in-header.patch
```

## Test, then commit

```bash
cd ~/lummet/lummet-control-plane && npm test 2>&1 | tail -12
git add -A && git status --short && git diff --cached --stat | tail -1
git commit -m "Public header: Sign in becomes Dashboard for signed-in staff"
git push origin main
```

Run the SQL above in the D1 console first (or the manual migrate workflow), then push.

## Check it

```bash
sleep 60; curl -s https://YOUR-DOMAIN/session-status; echo
curl -sI https://YOUR-DOMAIN/ | head -1
```

Expect `{"signedIn":false}` and `200`. Then sign in, open the homepage, and the header shows **Dashboard** (also in the phone menu).

## Rollback

```bash
cd ~/lummet/lummet-control-plane && git revert --no-edit HEAD && git push origin main
```

The two interface strings are harmless to leave in the database.

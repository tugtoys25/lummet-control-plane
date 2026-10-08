> **v7A note:** this document was written for the standalone public-site codebase, where the migrations were numbered 0006-0010. In v7A they are **0033_public_site_schema, 0034_seed_lummet_content, 0035_contact_demo_forms, 0036_signed_in_header, 0037_repair_select_options** and are applied by the normal runner (`node scripts/migrate.mjs`, which deploy.yml runs). Ignore any instruction here to copy files into another repo or to run the old manual migration workflow.

# Release: signed-in staff can browse the public site (control plane)

Built on `main` @ **fa4af3f** (the dashboard redesign you pushed). Only `lummet-control-plane` changes; the tenant is untouched.

## What changed

- **`/` is now the public homepage for everyone**, including a signed-in admin. Before, a signed-in admin
  who opened `/` was shown the dashboard instead, so the homepage looked blocked. Every other public page
  (`/brands`, `/contact`, `/demo`, `/updates`, `/insights`, `/partners`, ...) already worked while signed in.
- **The staff dashboard moved to `/dashboard`.** Signing in, visiting `/login` while signed in, changing your
  password, the sidebar "Overview" link, the logo in the sidebar and the 403 page's "Back to dashboard" all go there.
  `/dashboard` still needs a session: without one you are sent to `/login`.
- **New "View site" button** in the dashboard top bar (opens the public site in a new tab).
- Nothing else about permissions changed. Other dashboard URLs (`/tenants`, `/content/...`, `/cms/...`, `/ai`) are the same.
- **Heads-up:** a bookmark to the dashboard at `/` now shows the public homepage. Re-bookmark `/dashboard`.

## Numbers

Counted with `git diff --numstat` against fa4af3f, excluding the three generated files
(`docs/RELEASE_SITE_ACCESS.md`, `docs/integration/baseline.sha256`, `docs/integration/removed.txt`).

| | Files | Lines added | Lines deleted |
|---|---:|---:|---:|
| **Total** | **9** | **91** | **16** |
| New files | 1 | 60 | 0 |
| Modified (touched) files | 8 | 31 | 16 |
| Deleted files | 0 | 0 | 0 |

**Tests: 364 passing** (360 before; 4 new end-to-end tests: public pages render for a signed-in admin, `/` is identical for visitor and admin,
`/dashboard` needs a session, `/login` and the "View site" link; 2 existing tests updated for the new address).

## Migrations

**None.** No database change, no new secret.

## New files (1)

| File | + | - |
|---|---:|---:|
| `test/signed-in-site-access.test.js` | 60 | 0 |

## Modified files (8)

| File | + | - |
|---|---:|---:|
| `README.md` | 6 | 0 |
| `docs/DASHBOARD_UI.md` | 6 | 0 |
| `test/admin-shell.test.js` | 2 | 2 |
| `test/public-site.test.js` | 3 | 2 |
| `worker/index.js` | 7 | 7 |
| `worker/public-site/router.js` | 3 | 2 |
| `worker/views/layout.js` | 3 | 2 |
| `worker/views/pages/account.js` | 1 | 1 |

## Deleted files

None.

## Install on the phone (Termux)

Pick ONE way.

```bash
cd ~/lummet/lummet-control-plane && git status --short            # must print nothing
unzip -p ~/storage/downloads/lummet-control-plane-v5-site-access-full.zip lummet-control-plane/docs/integration/integrate.sh > ~/integrate.sh
bash ~/integrate.sh check ~/storage/downloads/lummet-control-plane-v5-site-access-full.zip ~/lummet/lummet-control-plane
bash ~/integrate.sh apply ~/storage/downloads/lummet-control-plane-v5-site-access-full.zip ~/lummet/lummet-control-plane
```

or the patch:

```bash
cd ~/lummet/lummet-control-plane && git status --short            # must print nothing
git apply --check ~/storage/downloads/lummet-control-plane-v5-site-access.patch
git apply ~/storage/downloads/lummet-control-plane-v5-site-access.patch
```

## Test, commit, deploy

```bash
cd ~/lummet/lummet-control-plane && npm test 2>&1 | tail -12      # expect: pass 364, fail 0
git add -A
git status --short
git commit -m "Public homepage for signed-in staff; dashboard moves to /dashboard"
git push origin main
gh run list --workflow=deploy.yml -L 1
```

After the deploy:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://lummet.com/            # 200 (public homepage)
curl -s -o /dev/null -w "%{http_code}\n" https://lummet.com/dashboard   # 302 (to /login when signed out)
```

Then sign in: you should land on `/dashboard`, and opening `/` (or "View site") should show the public homepage while still signed in.

## Rollback

```bash
cd ~/lummet/lummet-control-plane && git revert --no-edit HEAD && git push origin main
```

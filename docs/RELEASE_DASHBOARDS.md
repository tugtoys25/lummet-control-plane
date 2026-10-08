# Release: redesigned dashboards (control plane)

Built on `main` @ **742f90b** ("Contact and demo pages, database-backed interface text, sticky footer"), which is what is on your phone now. Only the staff dashboard of the control plane changes; the public website is untouched.

## What changed for users

- **Menu button instead of a link bar.** Navigation is grouped into collapsible sections.
  On a desktop the sidebar is docked and the **Menu** button collapses or restores it (remembered);
  on a phone or tablet (900px and narrower) the same button opens a slide-out drawer that closes from
  the backdrop, the close button, the Escape key, or by choosing a link.
- **Find a page** box filters the menu across all groups.
- **Current page** is highlighted and its group opened, including create and edit pages.
- **Nothing was removed or moved to a new URL.** Every previous link is still there (a test compares the
  new menu with the old list of links). Permissions, routes and APIs are untouched; hiding a link stays a
  convenience, the server checks remain the real boundary.

See `docs/DASHBOARD_UI.md` for how the shell works and how to add a page to the menu.

## Numbers

Counted with `git diff --numstat` against the version you have now, excluding the three generated files
(`docs/RELEASE_DASHBOARDS.md`, `docs/integration/baseline.sha256`, `docs/integration/removed.txt`).

| | Files | Lines added | Lines deleted |
|---|---:|---:|---:|
| **Total** | **7** | **913** | **262** |
| New files | 3 | 692 | 0 |
| Modified (touched) files | 4 | 221 | 262 |
| Deleted files | 0 | 0 | 0 |

**Tests: 360 passing** (350 before, plus 10 new ones for the grouped navigation, permissions filtering, theme and escaping).

## Migrations

**None.** No database change, no new secret, no new setting. Nothing to run in the D1 console.

## New files (3)

| File | + | - |
|---|---:|---:|
| `docs/DASHBOARD_UI.md` | 41 | 0 |
| `test/admin-shell.test.js` | 181 | 0 |
| `worker/views/shell-assets.js` | 470 | 0 |

## Modified files (4)

| File | + | - |
|---|---:|---:|
| `README.md` | 9 | 0 |
| `docs/integration/integrate.sh` | 23 | 19 |
| `worker/views/layout.js` | 185 | 239 |
| `worker/views/pages/ai-chat.js` | 4 | 4 |

## Deleted files

None.

## Install on the phone (Termux)

Pick ONE of the two ways, not both.

### A. Script (checks first, refuses to overwrite your own edits)

```bash
cd ~/lummet/lummet-control-plane && git status --short            # must print nothing
unzip -p ~/storage/downloads/lummet-control-plane-v4-dashboards-full.zip lummet-control-plane/docs/integration/integrate.sh > ~/integrate.sh
bash ~/integrate.sh check ~/storage/downloads/lummet-control-plane-v4-dashboards-full.zip ~/lummet/lummet-control-plane
bash ~/integrate.sh apply ~/storage/downloads/lummet-control-plane-v4-dashboards-full.zip ~/lummet/lummet-control-plane
```

`check` changes nothing: it unpacks into `~/lummet/compare-upgrades/`, verifies that the files this change
modifies are still the versions it was built on, and lists every difference. `apply` copies the files.

### B. Patch

```bash
cd ~/lummet/lummet-control-plane && git status --short            # must print nothing
git apply --check ~/storage/downloads/lummet-control-plane-v4-dashboards.patch
git apply ~/storage/downloads/lummet-control-plane-v4-dashboards.patch
```

## Test, then commit

```bash
cd ~/lummet/lummet-control-plane && npm test 2>&1 | grep -E "^# (tests|pass|fail)"
```
Expected: `# tests 360`, `# pass 360`, `# fail 0`. The control plane tests also read files from `~/lummet/lummet-tenant`, so keep it next to this folder.

```bash
cd ~/lummet/lummet-control-plane
git add -A
git status --short
git diff --cached --stat | tail -1
git commit -m "Dashboard shell: grouped navigation, menu toggle, responsive layout"
git push origin main
```

## Deploy

Pushing to `main` runs the existing "Deploy Lummet Control Plane" workflow. There is no migration, so there is no ordering to respect.

```bash
gh run list --workflow=deploy.yml -L 1
curl -s -o /dev/null -w "%{http_code}\n" https://lummet.com/login      # expect 200
```

Then sign in to the dashboard and check: the Menu button, the groups, the theme button (top right), and a table page at phone width.

## Rollback

```bash
cd ~/lummet/lummet-control-plane
git revert --no-edit HEAD
git push origin main
```

There is no migration to undo.

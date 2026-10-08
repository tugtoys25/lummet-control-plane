> **v7A note:** this document was written for the standalone public-site codebase, where the migrations were numbered 0006-0010. In v7A they are **0033_public_site_schema, 0034_seed_lummet_content, 0035_contact_demo_forms, 0036_signed_in_header, 0037_repair_select_options** and are applied by the normal runner (`node scripts/migrate.mjs`, which deploy.yml runs). Ignore any instruction here to copy files into another repo or to run the old manual migration workflow.

# Release: contact page, demo page, sticky footer, interface text in the database

Built on `main` @ **184e6e4** ("Public site: database-driven pages ... migrations 0006-0007").
Only `lummet-control-plane` changes. `lummet-tenant` is untouched (re-verified against
the tenant in `friday1version`: all tests pass).

## What changed for users

- **New pages:** `/contact` and `/demo` (and `/forms/<key>` for any form you add), rendered
  through the shared `base.html` + `header.html` + `footer.html` layout. Copy and fields come from the database.
- **Submissions** are stored in `lummet_inquiries` and managed in the dashboard
  (Lummet Site -> Inquiries). Protection: honeypot field, same-origin check, per-visitor hourly
  limit (default 5, setting `inquiry_rate_limit_per_hour`), size limits, select values must match stored options.
- **Sticky footer:** `body` is a full-height flex column, `<main>` grows, so the footer sits at
  the bottom of the screen on short pages and after the content on long ones.
- **Nothing hardcoded:** ~75 labels/messages moved from templates and scripts into `lummet_ui_strings`
  (Lummet Site -> Interface text). A test fails if literal text reappears in a template or script.
- **Links heal themselves:** header button, hero button, homepage buttons and footer links now point
  to `/demo` and `/contact`, and any link whose destination has nothing published is hidden.
- **Fixes found while testing:** blank number fields in the dashboard (for example Sort order) no longer
  fail on `NOT NULL` columns, they use a declared default; one literal word (`"... logo"`) in a template.
- **Behaviour change:** the homepage contact section now links to the contact form, so it stays visible
  without an email address as long as the contact form is published (it used to require an email).
- **Hardening:** `/cms/inquiries/new` is refused after the permission check, so a user without access learns nothing.
- **Optional:** secret `INQUIRY_WEBHOOK_URL` (https) posts one short JSON message per new inquiry.

## Numbers (against 184e6e4)

Counted with `git diff --numstat`, excluding the three generated files
(`docs/RELEASE_CONTACT_DEMO.md`, `docs/integration/baseline.sha256`, `docs/integration/removed.txt`).

| | Files | Lines added | Lines deleted |
|---|---:|---:|---:|
| **Total** | **59** | **1843** | **185** |
| New files | 11 | 1268 | 0 |
| Modified (touched) files | 47 | 575 | 181 |
| Deleted files | 1 | 0 | 4 |

Tests: **350 passing** (was 299 without the tenant folder / 314 with it before this
work; this release adds 26 form / interface-text tests and 9 dashboard tests, and replaces one old test with two).

## Migrations

| # | File | Run | Re-runnable |
|---|---|---|---|
| 0008 | `migrations/0008_contact_demo_forms.sql` | **once, before the code is deployed** | yes |

0008 creates 4 tables (`lummet_ui_strings`, `lummet_forms`, `lummet_form_fields`, `lummet_inquiries`) and 3 indexes,
and seeds 75 interface strings, 2 forms (contact, demo), 11 fields and 2 navigation links.
It also repoints 6 old seeded values (`/#demo` and `/#contact` links, the hero button) to `/demo`
and `/contact`; each UPDATE only fires while the row still holds the old seeded value, so
admin edits are never overwritten. Migrations 0001-0007 are unchanged.

## New files (11)

| File | + | - |
|---|---:|---:|
| `docs/integration/d1-console-0008/0008_part1_no_comments.sql` | 60 | 0 |
| `docs/integration/d1-console-0008/0008_part2_no_comments.sql` | 76 | 0 |
| `docs/integration/d1-console-0008/0008_part3_no_comments.sql` | 30 | 0 |
| `docs/integration/d1-console-0008/OPTIONAL_privacy_paragraph.sql` | 4 | 0 |
| `migrations/0008_contact_demo_forms.sql` | 184 | 0 |
| `public/static/js/form.js` | 15 | 0 |
| `public/templates/pages/form.html` | 56 | 0 |
| `test/forms.test.js` | 369 | 0 |
| `test/inquiries-admin.test.js` | 149 | 0 |
| `worker/public-site/forms.js` | 290 | 0 |
| `worker/public-site/links.js` | 35 | 0 |

## Modified files (47)

| File | + | - |
|---|---:|---:|
| `.github/workflows/migrate-public-site.yml` | 5 | 2 |
| `DEPLOYMENT.md` | 6 | 0 |
| `README.md` | 14 | 1 |
| `docs/INTEGRATION_PUBLIC_SITE.md` | 24 | 14 |
| `docs/PUBLIC_SITE.md` | 53 | 1 |
| `docs/integration/integrate.sh` | 12 | 11 |
| `public/static/css/base.css` | 8 | 1 |
| `public/static/css/components.css` | 28 | 0 |
| `public/static/css/tokens.css` | 4 | 0 |
| `public/static/js/article.js` | 1 | 1 |
| `public/static/js/nav.js` | 1 | 1 |
| `public/templates/components/brand-card.html` | 1 | 1 |
| `public/templates/components/breadcrumbs.html` | 1 | 1 |
| `public/templates/components/insight-card.html` | 2 | 2 |
| `public/templates/components/pagination.html` | 3 | 3 |
| `public/templates/components/section-contact.html` | 2 | 1 |
| `public/templates/components/update-card.html` | 1 | 1 |
| `public/templates/layout/base.html` | 2 | 1 |
| `public/templates/layout/footer.html` | 2 | 2 |
| `public/templates/layout/header.html` | 5 | 5 |
| `public/templates/pages/404.html` | 3 | 3 |
| `public/templates/pages/author.html` | 2 | 2 |
| `public/templates/pages/brand.html` | 3 | 3 |
| `public/templates/pages/brands.html` | 4 | 4 |
| `public/templates/pages/insight.html` | 5 | 5 |
| `public/templates/pages/insights.html` | 3 | 3 |
| `public/templates/pages/page.html` | 1 | 1 |
| `public/templates/pages/partners.html` | 2 | 2 |
| `public/templates/pages/update.html` | 4 | 4 |
| `public/templates/pages/updates.html` | 3 | 3 |
| `test/public-site.test.js` | 11 | 2 |
| `test/support/public-env.js` | 11 | 0 |
| `worker/cms-resources.js` | 98 | 6 |
| `worker/cms.js` | 14 | 5 |
| `worker/index.js` | 5 | 0 |
| `worker/public-site/context.js` | 20 | 8 |
| `worker/public-site/data.js` | 52 | 1 |
| `worker/public-site/format.js` | 5 | 0 |
| `worker/public-site/hero-graph.js` | 7 | 5 |
| `worker/public-site/home.js` | 31 | 19 |
| `worker/public-site/models.js` | 5 | 6 |
| `worker/public-site/pages.js` | 39 | 37 |
| `worker/public-site/render.js` | 2 | 1 |
| `worker/public-site/router.js` | 50 | 8 |
| `worker/public-site/sitemap.js` | 5 | 2 |
| `worker/views/layout.js` | 4 | 0 |
| `worker/views/pages/cms.js` | 11 | 2 |

## Deleted files (1)

| File | + | - |
|---|---:|---:|
| `public/templates/components/empty-state.html` | 0 | 4 |

Why: `empty-state.html` was a partial whose text was hardcoded; each page now prints its own message from `lummet_ui_strings`.

## Deployment commands (Termux, repo at `~/lummet/lummet-control-plane`)

Files in `~/storage/downloads` (flat, no folder):
`lummet-control-plane-v3-contact-demo-full.zip` and `contact-demo-v3.patch`.
Use **one** apply method (A or B).

```bash
# 0. clean tree + Node 22+
cd ~/lummet/lummet-control-plane && git status --short     # must print nothing
node -v

# A. apply with the script (recommended): checks first, then copies
cd ~/lummet
mkdir -p compare-upgrades/_tools3
unzip -q -o ~/storage/downloads/lummet-control-plane-v3-contact-demo-full.zip \
  'lummet-control-plane/docs/integration/*' -d compare-upgrades/_tools3
S=compare-upgrades/_tools3/lummet-control-plane/docs/integration/integrate.sh
bash $S check
bash $S apply

# B. or apply the patch instead
cd ~/lummet/lummet-control-plane
git apply --check ~/storage/downloads/contact-demo-v3.patch && git apply ~/storage/downloads/contact-demo-v3.patch

# test
cd ~/lummet/lummet-control-plane && npm test      # fail 0; 350 pass with lummet-tenant beside it (335 without)
```

**Database first, then push.** Run the three no-comment files from
`docs/integration/d1-console-0008/` in the D1 console in order (`cat` them in Termux to copy),
or with wrangler:

```bash
wrangler d1 export lummet-control-plane-db --remote --output=$HOME/cp-backup-$(date +%F).sql
wrangler d1 execute lummet-control-plane-db --remote --file=migrations/0008_contact_demo_forms.sql
```

Check (expect 2, 11, 75 on a database that never had 0008):

```sql
SELECT (SELECT COUNT(*) FROM lummet_forms) AS forms,
       (SELECT COUNT(*) FROM lummet_form_fields) AS fields,
       (SELECT COUNT(*) FROM lummet_ui_strings) AS ui_strings;
```

If you already ran 0008 earlier from the console, skip it: re-running changes nothing.

```bash
# commit and deploy (push triggers wrangler deploy)
cd ~/lummet/lummet-control-plane
git add worker public migrations/0008_contact_demo_forms.sql docs test \
        .github/workflows/migrate-public-site.yml README.md DEPLOYMENT.md
git add -u
git status --short | grep -v '^[AMD]  '        # must print nothing
git diff --cached --stat | tail -1
git commit -m "Contact and demo pages, database-backed interface text, sticky footer (migration 0008)"
git push origin main

# verify
for p in / /contact /demo /brands /sitemap.xml; do printf '%s ' $p; curl -s -o /dev/null -w '%{http_code}\n' https://lummet.com$p; done
```

Then send a test message on `/contact` and look for it in Lummet Site -> Inquiries.
Optional notification: `wrangler secret put INQUIRY_WEBHOOK_URL` (https Slack/Discord/JSON webhook).
Optional privacy text: review then run `docs/integration/d1-console-0008/OPTIONAL_privacy_paragraph.sql`.

The GitHub workflow `migrate-public-site.yml` (manual) now also applies 0008 if you prefer it
over the console. It has not been run yet; check its first run.

## Rollback

```bash
git revert HEAD && git push origin main
```

0008 only adds tables and rewrites six link values; the previous code ignores the new tables.
Repointed links can be edited back under Lummet Site -> Navigation links. To restore data, import the backup.

## Known limits

- The app does not send email. New inquiries are visible in the dashboard, and optionally in a webhook.
- The "Temporarily unavailable" page (shown only when the database cannot be read) is the one piece of text outside the database.
- Unknown top-level URLs such as `/nope` are handled by the existing dashboard code, not the public 404 template.
- The Privacy page does not yet mention the forms until you run the optional paragraph.
- Not run against real Cloudflare/D1 here: tested with SQLite, the real templates, a headless browser and the full suite.

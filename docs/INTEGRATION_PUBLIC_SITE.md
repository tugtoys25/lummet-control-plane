> **v7A note:** this document was written for the standalone public-site codebase, where the migrations were numbered 0006-0010. In v7A they are **0033_public_site_schema, 0034_seed_lummet_content, 0035_contact_demo_forms, 0036_signed_in_header, 0037_repair_select_options** and are applied by the normal runner (`node scripts/migrate.mjs`, which deploy.yml runs). Ignore any instruction here to copy files into another repo or to run the old manual migration workflow.

# Integrating the database-driven public site (Termux)

Built on top of `main` @ **44f85a3** ("Analytics parity: ...").
Only `lummet-control-plane` changes. `lummet-tenant` is untouched.

Files you download into `~/storage/downloads`:

| File | What it is |
|---|---|
| `lummet-control-plane-public-site-full.zip` | the complete control plane with the change applied (no `.git`) |
| `public-site.patch` | the same change as a `git apply` patch (optional, for a dry-run) |

> The zip and patch are **files** in `~/storage/downloads`, not a folder. There is no `lummet/` folder there to `cd` into.

> **Read this first: pick exactly ONE way to apply.**
> Section 1 only compares (read-only). Then **A (script), B (patch) and C (manual copy) are three
> alternatives that do the same thing.** Do one of them, never two. If you run a second one after the
> first has worked, it fails with "already exists in working directory" / "patch does not apply".
> That is expected and harmless: `git apply` is all-or-nothing, so a failed run changes nothing.

## 0. One-time setup in Termux

```bash
ls ~/storage/downloads | grep public-site      # if this fails, run: termux-setup-storage
pkg install -y unzip git diffutils coreutils
node -v                                        # need Node 22 or newer for npm test
# Only if node is missing: pkg install nodejs-lts
# (installing "nodejs" while "nodejs-lts" is present REPLACES your LTS with the current release)
```

## 1. Unzip into a staging folder and compare (read-only)

```bash
cd ~/lummet
mkdir -p compare-upgrades/public-site
unzip -q -o ~/storage/downloads/lummet-control-plane-public-site-full.zip -d compare-upgrades/public-site

# what differs between your repo and the new tree
diff -rq --exclude=.git --exclude=.wrangler --exclude=node_modules \
  lummet-control-plane compare-upgrades/public-site/lummet-control-plane

# line-level diff of one modified file
diff -u lummet-control-plane/worker/index.js compare-upgrades/public-site/lummet-control-plane/worker/index.js | head -80
```

Expected: 9 modified files, 70 files only in the new tree (they appear as a few whole directories), 2 files only in yours
(the obsolete ones). Full list at the bottom.

## 2A. Apply with the script (recommended)

Does the unzip, a check that your files are
still the versions this change was built on:

```bash
cd ~/lummet
mkdir -p compare-upgrades/_tools
unzip -q -o ~/storage/downloads/lummet-control-plane-public-site-full.zip \
  'lummet-control-plane/docs/integration/*' -d compare-upgrades/_tools
bash compare-upgrades/_tools/lummet-control-plane/docs/integration/integrate.sh check
bash compare-upgrades/_tools/lummet-control-plane/docs/integration/integrate.sh apply
```

## 2B. Apply with the patch (ALTERNATIVE to 2A and 2C: skip if you already applied)

```bash
cd ~/lummet/lummet-control-plane
git status --short                                   # should be empty
git apply --stat  ~/storage/downloads/public-site.patch
git apply --check ~/storage/downloads/public-site.patch && echo "applies cleanly"
git apply         ~/storage/downloads/public-site.patch
```

## 2C. Apply by manual copy (ALTERNATIVE to 2A and 2B: skip if you already applied)

```bash
cd ~/lummet
SRC=compare-upgrades/public-site/lummet-control-plane
DST=lummet-control-plane

# new directories (whole trees)
cp -a $SRC/public        $DST/
cp -a $SRC/worker/public-site $DST/worker/

# new single files
cp $SRC/migrations/0006_public_site_schema.sql  $DST/migrations/
cp $SRC/migrations/0007_seed_lummet_content.sql $DST/migrations/
cp $SRC/docs/PUBLIC_SITE.md $SRC/docs/INTEGRATION_PUBLIC_SITE.md $DST/docs/
cp -a $SRC/docs/integration $DST/docs/
cp $SRC/.github/workflows/migrate-public-site.yml $DST/.github/workflows/
cp $SRC/test/public-site.test.js $DST/test/
cp $SRC/test/support/public-env.js $DST/test/support/

# modified files
for f in DEPLOYMENT.md README.md wrangler.jsonc \
         test/support/d1-shim.js \
         worker/cms-resources.js worker/cms.js worker/index.js \
         worker/views/layout.js worker/views/pages/cms.js; do
  cp $SRC/$f $DST/$f
done

# obsolete files (hardcoded homepage + brand list)
cd $DST && git rm worker/public-brands.js worker/views/pages/home.js
```

## 3. Test locally

```bash
cd ~/lummet/lummet-control-plane
npm test          # expect fail 0. "pass 314" with lummet-tenant next to it (as in ~/lummet), 299 without
```

## 4. Database migrations: BEFORE you push

Pushing to `main` runs `wrangler deploy` (see `.github/workflows/deploy.yml`) but
**does not run migrations**. Until 0006 and 0007 are applied, the public pages
show a "Temporarily unavailable" page (signed-in admins and the dashboard are
unaffected). The migrations are additive, so the currently deployed code keeps
working if you run them first.

Option A: wrangler on your phone (works only if `npm i -g wrangler` succeeds in Termux):

```bash
cd ~/lummet/lummet-control-plane
wrangler d1 export lummet-control-plane-db --remote --output=$HOME/lummet-cp-backup-$(date +%F).sql
# 0006 uses ALTER TABLE: run it ONCE. This returns a row only if it is already applied:
wrangler d1 execute lummet-control-plane-db --remote \
  --command "SELECT name FROM pragma_table_info('lummet_brands') WHERE name='category'"
wrangler d1 execute lummet-control-plane-db --remote --file=migrations/0006_public_site_schema.sql
wrangler d1 execute lummet-control-plane-db --remote --file=migrations/0007_seed_lummet_content.sql
```

Option B: GitHub Actions (no wrangler on the phone). Commit and push first (section 5),
accept a short window where public pages show the unavailable message, then in GitHub:
**Actions -> "Migrate Lummet Control Plane DB (public site, manual)" -> Run workflow**.
It exports a backup artifact, skips 0006 if already applied, runs 0007, and prints
counts. It uses the same two secrets as the deploy workflow; the token must be
allowed to edit D1. This workflow could not be run here, so check its first run.

## 5. Git

```bash
cd ~/lummet/lummet-control-plane
git status --short
git add worker/public-site public migrations/0006_public_site_schema.sql migrations/0007_seed_lummet_content.sql \
        docs .github/workflows/migrate-public-site.yml \
        test/public-site.test.js test/support/public-env.js test/support/d1-shim.js \
        worker/cms-resources.js worker/cms.js worker/index.js worker/views/layout.js worker/views/pages/cms.js \
        wrangler.jsonc README.md DEPLOYMENT.md
git add -u                        # records the two deletions
git status --short                # review; do NOT add .wrangler
git commit -m "Public site: database-driven pages, shared base/header/footer layout, seeded content (migrations 0006-0007)"
git push origin main              # triggers the Worker deploy
```

## 6. Verify after deploy

```bash
curl -sI https://lummet.com/ | head -5
curl -s  https://lummet.com/sitemap.xml | head -20
curl -s  https://lummet.com/robots.txt
for p in / /brands /brands/level-casino /updates /insights /about /security /privacy; do
  printf '%s  ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "https://lummet.com$p"
done
curl -s -o /dev/null -w '/terms %{http_code} (404 until you publish it)\n' https://lummet.com/terms
```

Then in the dashboard: Lummet Site -> Pages -> Terms: paste your terms, set
status = published. Pages appear within about a minute (edge cache).

## 7. Rollback

```bash
cd ~/lummet/lummet-control-plane
git revert HEAD && git push origin main      # previous Worker code is redeployed
```

The migrations are additive and can stay: the previous code ignores the new
columns and tables. To restore data, import the backup taken in section 4.

## Change manifest

**Modified (9)**

- `DEPLOYMENT.md`
- `README.md`
- `test/support/d1-shim.js`
- `worker/cms-resources.js`
- `worker/cms.js`
- `worker/index.js`
- `worker/views/layout.js`
- `worker/views/pages/cms.js`
- `wrangler.jsonc`

**Deleted (2)**

- `worker/public-brands.js`
- `worker/views/pages/home.js`

**Added (70)**

- `.github/workflows/migrate-public-site.yml`
- `docs/INTEGRATION_PUBLIC_SITE.md`
- `docs/PUBLIC_SITE.md`
- `docs/integration/baseline.sha256`
- `docs/integration/integrate.sh`
- `migrations/0006_public_site_schema.sql`
- `migrations/0007_seed_lummet_content.sql`
- `public/static/css/base.css`
- `public/static/css/components.css`
- `public/static/css/pages.css`
- `public/static/css/tokens.css`
- `public/static/images/brands/level-casino.png`
- `public/static/images/favicon.svg`
- `public/static/js/article.js`
- `public/static/js/filter.js`
- `public/static/js/nav.js`
- `public/static/js/reveal.js`
- `public/static/js/theme.js`
- `public/templates/components/brand-card.html`
- `public/templates/components/breadcrumbs.html`
- `public/templates/components/empty-state.html`
- `public/templates/components/insight-card.html`
- `public/templates/components/pagination.html`
- `public/templates/components/partner-card.html`
- `public/templates/components/section-brands.html`
- `public/templates/components/section-checklist.html`
- `public/templates/components/section-contact.html`
- `public/templates/components/section-cta.html`
- `public/templates/components/section-faq.html`
- `public/templates/components/section-features.html`
- `public/templates/components/section-foot.html`
- `public/templates/components/section-head.html`
- `public/templates/components/section-insights.html`
- `public/templates/components/section-panel.html`
- `public/templates/components/section-partners.html`
- `public/templates/components/section-stats.html`
- `public/templates/components/section-steps.html`
- `public/templates/components/section-text.html`
- `public/templates/components/section-updates.html`
- `public/templates/components/update-card.html`
- `public/templates/layout/base.html`
- `public/templates/layout/footer.html`
- `public/templates/layout/header.html`
- `public/templates/pages/404.html`
- `public/templates/pages/author.html`
- `public/templates/pages/brand.html`
- `public/templates/pages/brands.html`
- `public/templates/pages/home.html`
- `public/templates/pages/insight.html`
- `public/templates/pages/insights.html`
- `public/templates/pages/page.html`
- `public/templates/pages/partners.html`
- `public/templates/pages/update.html`
- `public/templates/pages/updates.html`
- `test/public-site.test.js`
- `test/support/public-env.js`
- `worker/public-site/context.js`
- `worker/public-site/data.js`
- `worker/public-site/format.js`
- `worker/public-site/hero-graph.js`
- `worker/public-site/home.js`
- `worker/public-site/icons.js`
- `worker/public-site/models.js`
- `worker/public-site/pages.js`
- `worker/public-site/render.js`
- `worker/public-site/router.js`
- `worker/public-site/sanitize.js`
- `worker/public-site/seo.js`
- `worker/public-site/sitemap.js`
- `worker/public-site/template.js`

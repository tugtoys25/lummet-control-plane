# Newsroom Taxonomy + Research Sources/Claims — Integration Guide

This covers integrating the Newsroom Taxonomy and Research Sources/Claims
work (Super API endpoints + Control Plane screens, built across this
conversation) into your current stable codebase at `~/lummet`.

**Verified on the merged result before packaging:**
| Suite | Result |
|---|---|
| `lummet-tenant` (`node --test test/**/*.test.js`) | **666/666 passing** |
| `lummet-control-plane` (`npm test`) | **191/191 passing** |

Your codebase already had independent work done since the last upload —
none of it touched by this integration (verified by diff, listed in §5).
Nothing was overwritten; every file below is either brand new or a
targeted addition to a file none of your other recent work modified.

---

## 1. Unzip the delivered package into a staging folder

Never extract straight over your live repos — stage it first so you can
compare before touching anything.

```sh
mkdir -p ~/lummet-integration-staging
unzip -o ~/storage/downloads/lummet-integrated.zip -d ~/lummet-integration-staging
```

## 2. Compare the staged package against your current codebase

```sh
diff -rq ~/lummet-integration-staging/lummet-tenant ~/lummet/lummet-tenant | grep -v '\.git\b\|\.wrangler'
diff -rq ~/lummet-integration-staging/lummet-control-plane ~/lummet/lummet-control-plane | grep -v '\.git\b\|\.wrangler'
```

You should see exactly this and nothing else (3 new test files + 5 changed
files per repo):

```
Only in .../lummet-tenant/en/test: super-api-newsroom-article-relations.test.js
Only in .../lummet-tenant/en/test: super-api-newsroom-taxonomy.test.js
Only in .../lummet-tenant/en/test: super-api-research-sources-claims.test.js
Files .../worker/database/newsroom-taxonomy.js differ
Files .../worker/super/capabilities.js differ
Only in .../lummet-tenant/en/worker/super: handlers-newsroom.js
Only in .../lummet-tenant/en/worker/super: handlers-research.js
Files .../worker/super/router.js differ

Only in .../lummet-control-plane/test: newsroom-tags.test.js
Only in .../lummet-control-plane/test: newsroom-taxonomy-resources.test.js
Only in .../lummet-control-plane/test: research-resources.test.js
Files .../worker/index.js differ
Files .../worker/resources.js differ
Files .../worker/views/layout.js differ
Files .../worker/views/pages/crud.js differ
Only in .../lummet-control-plane/worker/views/pages: newsroom-tags.js
```

If you see anything beyond this list, stop and diff that specific file
before proceeding — it means something in your working copy has moved
since this package was built.

## 3. Copy the exactly touched/new files

**Tenant:**
```sh
cp ~/lummet-integration-staging/lummet-tenant/en/worker/database/newsroom-taxonomy.js \
   ~/lummet/lummet-tenant/en/worker/database/newsroom-taxonomy.js

cp ~/lummet-integration-staging/lummet-tenant/en/worker/super/capabilities.js \
   ~/lummet/lummet-tenant/en/worker/super/capabilities.js

cp ~/lummet-integration-staging/lummet-tenant/en/worker/super/router.js \
   ~/lummet/lummet-tenant/en/worker/super/router.js

cp ~/lummet-integration-staging/lummet-tenant/en/worker/super/handlers-newsroom.js \
   ~/lummet/lummet-tenant/en/worker/super/handlers-newsroom.js

cp ~/lummet-integration-staging/lummet-tenant/en/worker/super/handlers-research.js \
   ~/lummet/lummet-tenant/en/worker/super/handlers-research.js

cp ~/lummet-integration-staging/lummet-tenant/en/test/super-api-newsroom-taxonomy.test.js \
   ~/lummet/lummet-tenant/en/test/super-api-newsroom-taxonomy.test.js

cp ~/lummet-integration-staging/lummet-tenant/en/test/super-api-newsroom-article-relations.test.js \
   ~/lummet/lummet-tenant/en/test/super-api-newsroom-article-relations.test.js

cp ~/lummet-integration-staging/lummet-tenant/en/test/super-api-research-sources-claims.test.js \
   ~/lummet/lummet-tenant/en/test/super-api-research-sources-claims.test.js
```

**Control Plane:**
```sh
cp ~/lummet-integration-staging/lummet-control-plane/worker/index.js \
   ~/lummet/lummet-control-plane/worker/index.js

cp ~/lummet-integration-staging/lummet-control-plane/worker/resources.js \
   ~/lummet/lummet-control-plane/worker/resources.js

cp ~/lummet-integration-staging/lummet-control-plane/worker/views/layout.js \
   ~/lummet/lummet-control-plane/worker/views/layout.js

cp ~/lummet-integration-staging/lummet-control-plane/worker/views/pages/crud.js \
   ~/lummet/lummet-control-plane/worker/views/pages/crud.js

cp ~/lummet-integration-staging/lummet-control-plane/worker/views/pages/newsroom-tags.js \
   ~/lummet/lummet-control-plane/worker/views/pages/newsroom-tags.js

cp ~/lummet-integration-staging/lummet-control-plane/test/newsroom-taxonomy-resources.test.js \
   ~/lummet/lummet-control-plane/test/newsroom-taxonomy-resources.test.js

cp ~/lummet-integration-staging/lummet-control-plane/test/newsroom-tags.test.js \
   ~/lummet/lummet-control-plane/test/newsroom-tags.test.js

cp ~/lummet-integration-staging/lummet-control-plane/test/research-resources.test.js \
   ~/lummet/lummet-control-plane/test/research-resources.test.js
```

**Documentation (this file):**
```sh
mkdir -p ~/lummet/lummet-control-plane/docs
cp ~/storage/downloads/NEWSROOM_RESEARCH_INTEGRATION.md \
   ~/lummet/lummet-control-plane/docs/NEWSROOM_RESEARCH_INTEGRATION.md
```

## 4. Run the tests to confirm nothing broke

```sh
cd ~/lummet/lummet-tenant/en
node --test test/**/*.test.js

cd ~/lummet/lummet-control-plane
npm test
```

Expect **666/666** (tenant) and **191/191** (control plane). If either
number is lower, stop before committing — something didn't copy cleanly.

## 5. git status, add, commit

No `wrangler deploy` here — that's a separate step once you're satisfied.

**Tenant:**
```sh
cd ~/lummet/lummet-tenant
git status

git add \
  en/worker/database/newsroom-taxonomy.js \
  en/worker/super/capabilities.js \
  en/worker/super/router.js \
  en/worker/super/handlers-newsroom.js \
  en/worker/super/handlers-research.js \
  en/test/super-api-newsroom-taxonomy.test.js \
  en/test/super-api-newsroom-article-relations.test.js \
  en/test/super-api-research-sources-claims.test.js

git status

git commit -m "Add Newsroom Taxonomy + Research Sources/Claims Super API (v11 -> v14)

- Newsroom: sections/topics/entities/series CRUD + article-level
  metadata and relations (section, type, labels, topics, entities,
  series, countries)
- Research: sources (global) + claims (per research item) with
  evidence attachments
- All additive: wraps existing worker/database/newsroom-taxonomy.js,
  research-sources.js, research-claims.js with zero changes to their
  business logic
- 40 new tests, 666/666 tenant suite passing"
```

**Control Plane:**
```sh
cd ~/lummet/lummet-control-plane
git status

git add \
  worker/index.js \
  worker/resources.js \
  worker/views/layout.js \
  worker/views/pages/crud.js \
  worker/views/pages/newsroom-tags.js \
  test/newsroom-taxonomy-resources.test.js \
  test/newsroom-tags.test.js \
  test/research-resources.test.js \
  docs/NEWSROOM_RESEARCH_INTEGRATION.md

git status

git commit -m "Add Newsroom Taxonomy + Research Sources CRUD screens, article tagging UI

- New nav entries: Newsroom Sections/Topics/Entities/Series, Research
  Sources (generic CRUD, same system as casinos/research items)
- New 'Manage newsroom tags' screen on the news article edit page for
  section/type/labels/topics/entities/series/countries
- Merged around independent AI-chat-feature changes in index.js and
  layout.js -- verified anchor lines before editing, nothing from
  that feature touched
- 12 new tests, 191/191 control plane suite passing"
```

---

## 6. What's already in your codebase, untouched by this integration

Verified by diff before building this package — none of the following was
modified:

- **Security hardening** (constant-time password comparison + RBAC/
  tenant-isolation/HMAC/audit test suite) — already committed, confirmed
  identical, not re-touched.
- **AI management chat feature** in the Control Plane (`worker/ai/`,
  `views/pages/ai-chat.js`, migration `0005`, its 10 tests, the `AI`
  binding in `wrangler.jsonc`) — completely separate code paths from
  everything in this package; `index.js` and `layout.js` were edited by
  finding the exact unchanged lines around this feature's own edits, not
  by overwriting.
- **Generic Content Engine hardening** on the tenant side (latest commit:
  "close public-gate leaks... complete CRUD... RBAC read-gate and
  item-level list scoping") — none of the files it touches
  (`api.js`, `controllers.js`, `content-resolver.js`, `comparisons.js`,
  `content-items.js`, `custom-types.js`, admin templates) overlap with
  anything in this package. It's still tenant-admin-UI only — no Super
  API route exists for it yet, so the Control Plane still can't reach it.
  That remains the next big gap if you want it closed the same way
  Newsroom and Research were.

## 7. Capability status after this integration

| Domain | Status |
|---|---|
| Settings | Full |
| Newsroom — taxonomy (sections/topics/entities/series) | **Full** — Control Plane CRUD |
| Newsroom — article tagging | **Full** — "Manage newsroom tags" screen |
| Newsroom — analytics/search/sitemap/redirects/corrections | Missing |
| Research — items | Full (pre-existing) |
| Research — sources | **Full** — new CRUD screen |
| Research — claims + evidence | **Backend only** — no screen yet |
| Research — relations/versions/review-queue/datasets | Missing |
| Generic Content Engine | Tenant-admin-UI hardened (independent work) — **still zero Super API surface**, so still unreachable from the Control Plane |
| Affiliate, Analytics, SEO, Media, Operations, RBAC, Audit | Full (audited earlier) |

## 8. Deployment (when you're ready — not run here per your request)

Deploy the tenant first (Control Plane calls the new v14 routes), then the
Control Plane. Verify with a Test Connection on a tenant afterward to
confirm the capability list includes the new `newsroom-*` and
`research-*` entries, then try the new screens end to end.

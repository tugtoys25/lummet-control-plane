# Control plane: instant homepage and fast tenant sites

Built on `1yy111msaasversion.zip`. **No migration.** Tenant code: unchanged in this release.

## What changed

- **Tenant sites the control plane provisions** (`worker/infra-cloudflare.js`): the upload used `run_worker_first: true` and no cache rules, so every css/js/image of every provisioned site still woke that site's Worker (the repo `wrangler.jsonc` fix does not reach them). It now sends `run_worker_first: ["/*","!/static/*"]` plus the cache rules as `_headers` text, and Smart Placement. Existing sites pick this up at their next deployment/rollout. Rollback: set `TENANT_STATIC_BYPASS=off` and/or `TENANT_SMART_PLACEMENT=off`.
- **Settings read no longer blocks a request** (`worker/platform-settings.js`): every 15 s the first request in each isolate waited for a database read before anything, even a page served from the edge cache. An expired copy (up to 2 min old) is now used at once while the refresh runs in the background. Routes that need fresh values (sign-in, sign-up, forms) still read first.
- **Early hints for the public pages** (`worker/public-site/render.js`): `Link: rel=preload` for the stylesheets and the two fonts, so the browser starts them before the HTML finishes.

Already fast, left alone: batched site-data read, template cache, stale-while-revalidate page cache, `/static/*` off the Worker, Smart Placement, D1 sessions.

## Tests
Control plane 2463 pass; 3 files fail identically on the untouched base (they need `PLACEHOLDERS.md` / `RELEASE_ID` from the full release package, one folder above the repo).

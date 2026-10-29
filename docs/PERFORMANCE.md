# Performance (release 2.6.0.19)

What changed and how to operate it.

- **Shell bundle** (`worker/perf/shell-bundle.js`): staff/portal CSS and JS are served from `/_s/<name>.<hash>.<ext>`, immutable. The hash follows the content, so editing `views/shell-assets.js` publishes new URLs automatically.
- **Public static files**: always referenced as `?v=<ASSET_VERSION>`. After changing anything in `public/static/css` or `public/static/js`, bump `worker/perf/asset-version.js` and run `npm run check:asset-version -- --write`.
- **Fewer database round trips**: one-query session lookups; chrome reads prefetched (`prefetchShellData`) while the page builds.
- **Read replicas (optional, recommended)**: enable read replication for `lummet-control-plane-db` in the Cloudflare dashboard (D1 > database > Settings). The Worker already uses the Sessions API; reads are then served near the visitor. A `lm_bm` cookie keeps each browser consistent with its own writes. `D1_READ_SESSIONS=off` disables the wrapper.
- **Smart Placement** is on in `wrangler.jsonc`. If far-away visitors see slower uncached public pages, remove it.
- **Rollback**: `assets.run_worker_first: true`, delete `placement`, set `D1_READ_SESSIONS=off`.
- Check results in the browser network tab: `Server-Timing: app;dur=` is the Worker time; `/_s/*` and `/static/*` should show as cached after the first load.

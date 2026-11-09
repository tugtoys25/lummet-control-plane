# 2.8.0: portal branding and media library

See CHANGELOG.md. Deploy steps:

1. `wrangler r2 bucket create lummet-platform-media` (and `lummet-platform-media-staging`, or run `node scripts/ensure-staging-resources.mjs`).
2. Deploy the Worker (the binding is in wrangler.jsonc). Apply migration 0096 (`wrangler d1 migrations apply`).
3. Platform settings > Branding: upload or pick images, give a reason, Save. Changes reach every edge location in about 15 seconds; public pages follow the page cache (about a minute).

Rollback: remove the values (or deploy the previous Worker); the tables are harmless and the old look returns when nothing is set.

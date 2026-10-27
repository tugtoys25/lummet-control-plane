# Hardcoding audit (release 2.6.0.17)

Method: static search of the package (STATIC REVIEW) for known customer brand hosts, personal emails, real resource ids and plan or price literals. It is a denylist scan of names this codebase has carried, not proof that nothing tenant-specific remains. Nothing here was run against a live system.

## Fixed in 2.6.0.17
| Finding | Action |
|---|---|
| `worker/public-brands.js` listed six customer sites (Level.casino, NeuroOdds.com, Cluster.casino, LegendOdds.com, BrilliantOdds.com, Freewin.xyz) | Deleted. Proven obsolete: nothing imports it (`listPublicBrands` has no caller), `README.md` already records its removal, and migration `0033_public_site_schema.sql` moved that content to the database |
| AI help text and the intent prompt used `freewin.xyz` and `level.casino` as examples (`worker/ai/commands.js`, `worker/ai/chat.js`, `worker/ai/intent.js`) | Replaced with `example.com`. No test asserted those strings |
| `lummet-tenant/wrangler.jsonc` carries a real D1 database id and KV namespace id | A placeholder template `lummet-tenant/wrangler.example.jsonc` was added. The original file is kept (it is the owner's own tenant deployment), see Open |
| No gate prevented the above returning | `scripts/hardcoding-check.mjs` and `test/hardcoding-check.test.js` fail on a brand host under `worker/`, on `public-brands.js` reappearing, and on a real-looking id in the tenant template |

## Accepted, with reason
| Item | Why accepted |
|---|---|
| `lummet-control-plane/wrangler.jsonc` owner values (routes, `PORTAL_BASE_URL`, `WEBAUTHN_RP_ID`, `PLATFORM_DOMAIN_SUFFIX`, `CONTACT_EMAIL`) | Deployment configuration for the owner's environment. `wrangler.example.jsonc` carries placeholders |
| `lummet.com` in staff CMS page copy (`worker/views/pages/cms.js`) | The platform's own product name and site, not a customer |
| `yourdomain.com` in `worker/email.js` comments | Documentation placeholder |
| `proton.me` in `worker/trial-abuse.js` | A free-mail domain list used to detect personal addresses |
| Prices and plan names in the seed catalog (`0018_seed_catalog.sql`) | Database records, editable; not logic |
| Brand hosts in about 15 test files | Sample fixture data. Renaming them is cosmetic |

## Still open (not changed in this release)
| Item | Location | Note |
|---|---|---|
| Default brand name `"Level.casino"` used when a site name is missing in the research PDF export | `lummet-tenant/en/js-src/research-pdf-export/04-export.js`, built copy `en/static/js/research-pdf-export.js` | A functional hardcode in the tenant engine. Needs the tenant build step and tenant tests; a separate slice |
| Comment headers and CSS banners naming Level.casino or Freewin | tenant `css-src/`, `static/css/`, `worker/lummet/router.js`, `worker/auth/security.js`, `worker/ai/retrieval/geo-guard.js` | Comments only; no behaviour |
| Package name `freewin-xyz-worker` | `lummet-tenant/en/package.json`, `package-lock.json` | Cosmetic, but a lockfile edit needs registry access |
| Customer brand names in tenant legacy migrations and `docs/history` | `lummet-tenant/en/migrations-legacy/`, `lummet-tenant/docs/history/` | Historical, must not be edited |
| Real D1 and KV ids in `lummet-tenant/wrangler.jsonc` | tenant root | Owner decision: stop tracking this file and keep only the template, or keep it as the owner's deployment file. `[OPEN]` |
| `lummet-control-plane/migrations/0034_seed_lummet_content.sql` | control plane | Seed copy for the platform's own site mentions customer brands; a data decision for the owner |
| Public templates, views and the tenant `public/` markup were not scanned for tenant-specific copy | | Not audited |

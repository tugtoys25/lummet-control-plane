# v7F: customer portal pages, notification centre, closed tenant admin bootstrap

Tests: control plane 872 (v7E) -> 888, tenant 920 -> 924, all passing. Pages were checked by rendering them through the
Worker and by running their scripts against a stub browser; not in a real browser, not against a live tenant.

## New customer pages (all under /app, signed-in customers only)
| Page | What it shows | Who can act |
|---|---|---|
| Analytics | per-site overview by casino/offer/link/partner/program/campaign/review/news/page, tracking-link health, daily revenue for a chosen currency | any member (needs `analytics.level` other than none) |
| Reports | the site's saved reports, Run now | run: analyst and above (needs `reports.enabled`) |
| Campaigns | the site's campaigns, create | create: editor and above (needs `affiliate.enabled`) |
| Alerts | open alerts raised by the site's own rules, Acknowledge | acknowledge: analyst and above (needs `alerts.enabled`) |
| Notifications | the organization's automation inbox (it had no screen), with an open-count badge in the nav | acknowledge/resolve: analyst and above |
| Search | sites, domains and team members of the active organization | any member |
| Content | links to each live site's own dashboard (`/en/dashboard`) and public site | - |

- The pages only call JSON routes that already existed and were already tested (`tenant-portal.js`, `search.js`); every
  check (membership, role, entitlement, site ownership) is still made by those routes. A plan without a feature gets an
  explanatory page and no nav entry; the route stays the access control.
- New: `GET /api/organizations/:id/notifications[?status=all]`, `POST .../notifications/:id/(acknowledge|resolve)`
  (analyst+, tenant-isolated by id AND organization, only moves forward, every attempt audited). SQL in
  `repositories/notifications.js`.
- All new markup follows the v7E policy (nonce, no inline handlers); tests assert it on every new page.

## Security fix on the tenant
`POST /api/v1/setup/admin` (create the first administrator) was open: on a newly provisioned site the first stranger
to call it became the administrator. It now behaves like an unknown path unless the tenant Worker has a `SETUP_TOKEN`
secret (16+ characters) and the caller sends it as `X-Setup-Token` (constant-time compare). Four tests.

## Fixed along the way
`lookupTXT` (DNS verification for domains and SSO domains) threw when the resolver could not be reached, which made a
customer's Verify click a 500. It now reports "no record yet" and can be retried.

## Known gap, now the top blocker for true self-serve: the first administrator of a new site
Provisioning does not create the customer's administrator on the new site, and with the endpoint closed there is no
open way to get one. Until a provisioning step exists, an operator does it once per site:
1. `wrangler secret put SETUP_TOKEN` on the site's Worker (a random 32+ character value).
2. `POST https://<site>/api/v1/setup/admin` with header `X-Setup-Token: <value>` and JSON `{ "email", "password" }`.
3. `wrangler secret delete SETUP_TOKEN`.
The customer then signs in at `/en/dashboard` (the Content page links there). A provisioning step that seeds the
administrator and sends a set-password link is the next thing to build (v7G).

## Not in v7F
Media and Integrations pages, a support surface, email delivery of notifications, and automatic creation of the site's
administrator (above).

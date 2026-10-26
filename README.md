# Lummet Control Plane

Standalone Cloudflare Worker + D1 database. This is a **separate
project from any tenant repo** — it never shares code or a database
with tenant deployments, and tenants never need to redeploy or
migrate anything for this to exist.

It talks to tenants only over HTTPS, via each tenant's
`/en/api/super/*` Super API (see the tenant repo's
`en/docs/super-api.md`). It never queries a tenant's D1 directly.

**For deployment steps, see `DEPLOYMENT.md`** in this folder — it
covers both halves (this control plane and the tenant-side Super
API) end-to-end, plus day-to-day operation and rollback.

## What's in Phase 2 + 3 + 4 + 5 + 6 + 7 + 8

- `migrations/0001_control_plane.sql` — tenant registry, encrypted
  credential storage, capability/health cache, and a completely
  separate Lummet admin identity system (`lummet_admins`,
  `lummet_sessions`) with its own audit log.
- `worker/crypto.js` — AES-GCM encrypt/decrypt for tenant HMAC
  secrets at rest, keyed by a Worker secret (`CREDENTIAL_KEK`) that
  never touches D1.
- `worker/signing.js` — builds the same HMAC-signed headers the
  tenant's Super API verifies (shared canonical-string scheme).
- `worker/data.js` — shared low-level D1 reads (tenant rows, active
  credential) used by both `registry.js` and `client.js`.
- `worker/client.js` — the single place this control plane ever
  makes an outbound HTTPS call to a tenant. Exposes
  `requestTenant(env, tenant, { method, path, body, timeoutMs })`,
  handles credential lookup/decryption + signing, and normalizes
  every failure into the error taxonomy from rule #24 (401/403/404/
  409/422/429/500/502/504), distinguishing a genuine timeout (504)
  from a network/connection failure (502).
- `worker/auth.js` — Lummet master-admin login/session (PBKDF2 +
  HttpOnly session cookie), bootstrap-first-admin flow, rate
  limiting.
- `worker/registry.js` — tenant CRUD, credential issuance/rotation,
  and connection testing. `testConnection()` routes through
  `client.js`'s `requestTenant()` rather than constructing its own
  `fetch()`.
- `worker/audit.js` — control-plane-side audit log writer.
- `worker/views/layout.js` — shared HTML shell (sidebar nav,
  topbar, CSS) — its own visual identity, deliberately distinct
  from the tenant admin UI (rule #11).
- `worker/views/pages/login.js` — login page, which automatically
  switches to a one-time "create the first admin" form when
  `lummet_admins` is empty.
- `worker/views/pages/dashboard.js` — overview page: tenant counts,
  health breakdown, recent audit activity.
- `worker/views/pages/tenants.js` — All Tenants, Add Tenant
  (shows the issued credential exactly once), Health, Deployments,
  and per-tenant detail (enable/disable/rotate/test/delete actions).
- `worker/views/pages/platform.js` — Audit Logs, Credentials, and
  Capabilities pages (all backed by local control-plane data), plus
  a static API reference page.
- `worker/views/pages/placeholder.js` — Content/System nav sections
  render with the correct navigation and labels now, but explain
  that managing tenant resources requires tenant switching (Phase 5)
  and the resource CRUD screens (Phase 6).
- `worker/index.js` — now serves both the JSON API (unchanged) and
  the HTML dashboard pages. Page routes redirect an unauthenticated
  visitor to `/login`; API routes still return a JSON 401.

The dashboard's navigation follows the exact structure from the
master plan's rule #11 (Dashboard / Tenants / Content / System /
Platform), but its look is its own — a dark, mission-control style
distinct from the tenant CMS admin, so an operator can never mistake
one for the other.

Not yet built (later phases): tenant-switching-aware CRUD screens
for Content/System (Phase 6), the health-check cron (Phase 7). Both
are documented further down — see those sections below.

### Phase 5 — Tenant switching

- The topbar on every dashboard page now shows an **active tenant**
  selector, populated from the registry. Switching tenants calls
  `POST /api/tenants/:id/switch` (or `DELETE /api/session/active-tenant`
  to clear it), which only ever updates `lummet_sessions.active_tenant_id`
  — the tenant's own session/auth state is never touched (rule #12).
- A tenant's detail page also offers a "Set as active tenant" button,
  and shows an "Active tenant" badge when it's the current selection.
- The Content/System placeholder pages now reflect which tenant (if
  any) is active, previewing what Phase 6's CRUD screens will operate
  against once they resolve requests through `client.js`'s
  `requestTenant()` against `admin.activeTenantId`.
- Every switch/clear action is recorded in `lummet_audit_logs`
  (`action: "switch_tenant"` / `"clear_active_tenant"`).

### Phase 6 — CRUD administration

- `worker/resources.js` — field/column configuration for every
  resource the tenant's Super API supports, taken directly from the
  tenant repo's actual `schema.sql` columns and the real Phase 1
  handler signatures (which key differ per resource: `casinos`,
  `reviews`, `news`, `pages`, `categories` on `:slug`; `countries` on
  `:code`; `authors`, `media`, `users` on numeric `:id`).
- `worker/views/pages/crud.js` — generic list/create/edit screens
  driven entirely by that config. Every read and write goes through
  `client.js`'s `requestTenant()` (via `getFromTenant`/`postToTenant`/
  `putToTenant`/`deleteFromTenant`) against `admin.activeTenantId` —
  no page ever constructs its own `fetch()`.
- `worker/views/pages/settings.js` — a dedicated screen for
  `settings`, since it's a key/value dictionary rather than a list of
  records; existing keys are editable in place and a new key can be
  added, all through the same safe-settings filter the tenant's
  Super API already enforces.
- **Capability-aware**: a list screen checks the tenant's cached
  `tenant_capabilities` (from a prior "Test connection") and shows a
  clear notice instead of a broken screen if that tenant's deployment
  reports the resource as unsupported (rule #16).
- **No active tenant**: every CRUD/settings screen shows a plain
  "select a tenant" notice rather than erroring if nothing is active.
- **Errors**: any non-2xx from the tenant is shown inline using the
  taxonomy from `client.js` (401/403/404/409/422/429/500/502/504),
  never a raw stack trace (rule #24).
- **Unsupported nav items stay honest**: `permissions` and
  `components` remain on the System nav (per the master plan's fixed
  nav structure) but still render the Phase 4 placeholder, since no
  Super API endpoint exists for them yet — they were never part of
  Phase 1's allowlist.
- **users** is role-only (no create/delete) and **media** is
  edit/delete-only (no create — there's no upload endpoint in the
  Super API yet), matching exactly what Phase 1's handlers actually
  expose.
- While wiring `authors` into the CRUD config, found and fixed a
  real bug in the tenant repo's Phase 1 `super/handlers.js`:
  `handleGetAuthor` was keying on `slug` while `handleUpdateAuthor`/
  `handleDeleteAuthor` key on numeric `id`, even though all three
  share the same `:id` URL segment from `router.js`. Fixed to use
  `authorsDB.getAuthorById()` consistently. See the tenant repo's
  updated `en/worker/super/handlers.js`.

### Phase 7 — Health monitoring cron

- `worker/cron.js` — `runHealthChecks(env)` walks every registered
  tenant (active and disabled) in small concurrent batches (default
  5 at a time) and calls `registry.js`'s `testConnection()` for
  each — the exact same code path a manual "Test connection" click
  uses, which itself routes through `client.js` (rule #23). A
  network failure, timeout, or disabled tenant is recorded with its
  correct status in `tenant_health` and is **never** treated as "the
  tenant was deleted" (rule #15) — only an explicit
  `DELETE /api/tenants/:id` removes a registry row.
- `wrangler.jsonc` — added a `triggers.crons` entry (`*/5 * * * *`
  by default; adjust to taste) that invokes the new `scheduled()`
  export in `worker/index.js`, which runs `runHealthChecks` inside
  `ctx.waitUntil()`.
- `POST /api/tenants/health-check-all` — an authenticated,
  on-demand version of the same sweep, for testing or for an admin
  who doesn't want to wait for the next tick. Logged to
  `lummet_audit_logs` (`action: "health_check_all"`) since it's an
  explicit admin action; the automatic cron ticks are not
  individually audit-logged — `tenant_health` is already the source
  of truth for reachability, and logging every scheduled tick for
  every tenant would mostly just be noise in the audit trail.
- The Health page (`/tenants/health`) gained a **Run all now**
  button that calls the on-demand endpoint and shows a summary
  before refreshing.
- Verified end-to-end against a fake D1 (no live tenant needed):
  a tenant with no configured credential correctly resolves to
  `Configuration Error`, and a disabled tenant resolves to
  `Disabled` without an outbound network call — both routed through
  the real `registry.js`/`client.js` code, not a reimplementation.

### Phase 8 — Audit logging (completeness)

Most of the audit trail already existed from earlier phases
(`lummet_audit_logs`, the Audit Logs page, and `logAudit()` calls on
every registry/CRUD/settings mutation). Phase 8 closes the
remaining gaps:

- **Admin login events are now audited.** Previously only
  registry/CRUD mutations were logged — a login, a failed login
  attempt, a bootstrap, or a logout never appeared in the trail.
  `POST /api/auth/{bootstrap,login,logout}` and the page-based
  `/login` form now all write to `lummet_audit_logs`
  (`action: "bootstrap" | "login" | "logout"`), including **failed**
  login attempts (the attempted email is recorded, never the
  password). This is on top of the existing `lummet_auth_attempts`
  rate-limiting table, which is unchanged.
- **Fixed a real bug found while wiring this up**: the page-based
  `/login` form handler called `parseForm(request)` (which consumes
  the request body as form data) and then also called
  `auth.login(request, env)`, which tried to read the same body
  again as JSON — a second read of an already-consumed `Request`
  body, which throws. Fixed by splitting `auth.js`'s `login()` into
  a thin request-parsing wrapper plus a reusable
  `authenticateAdmin(env, email, password, ipHash)` core; the page
  route now calls the core directly with the already-parsed form
  values instead of re-reading the request.
- **Retention**: `worker/cron.js` gained `pruneOldAuditLogs()`,
  which deletes `lummet_audit_logs` rows older than 180 days (only
  that table — never `tenant_health`, the registry, or any tenant's
  own data). It runs alongside the Phase 7 health-check sweep on
  the same Cron Trigger.
- **Filtering and pagination**: the Audit Logs page
  (`/platform/audit-logs`) now supports filtering by tenant, action,
  and success/failure, plus offset-based pagination (50 rows per
  page) instead of a fixed 200-row cap with no way to see older
  entries.
- Verified end-to-end against a fake D1: `bootstrapFirstAdmin` now
  returns the new admin's id via `INSERT ... RETURNING id` (a real
  D1-supported clause per Cloudflare's own docs), and the
  bootstrap → login → logout sequence was run against a mock
  `LUMMET_DB` to confirm `adminId` flows through correctly at every
  step.
- Confirmed no audit entry anywhere logs a password, a decrypted
  HMAC secret, or a KEK — `errorMessage` fields only ever contain
  error codes/reasons or an admin's own email.

This closes out all 8 phases of the master plan.

### Post-launch fix — orphaned tenants with no credential

Found in production: `createTenant()` wrote the `tenants` row
*before* generating the credential. If `CREDENTIAL_KEK` was missing
or invalid at that moment, credential generation threw — leaving a
tenant registered with **zero** rows in `tenant_api_credentials`.
Its detail page would show `Configuration Error` /
`no_active_credential` forever, with no way to fix it except
guessing to click "Rotate credential" (which had the identical bug:
it marked the old credential `rotated` *before* trying to issue the
new one, so a KEK failure mid-rotation could leave a tenant with
**zero active credentials**, not just its original one).

Fixed in both `createTenant()` and `rotateCredential()`: credential
material is now generated and validated *first* — if `CREDENTIAL_KEK`
is missing, the function fails immediately with a clear message
("check that CREDENTIAL_KEK is configured on this Worker") and
**no row is written at all** — no orphaned tenant, no zeroed-out
credential. The two writes (tenant + credential, or rotate-old +
insert-new) are also now sent as a single `D1.batch()` call rather
than two separate operations, so the database round-trip itself
can't split them either.

Verified with a functional test against a mocked D1: with no
`CREDENTIAL_KEK` set, `createTenant()` now leaves 0 tenant rows and
0 credential rows (previously: 1 orphaned tenant, 0 credentials);
with a KEK set, both rows are written together as before.

If you already have a tenant stuck in this state from before this
fix, click **Rotate credential** on its detail page (once
`CREDENTIAL_KEK` is confirmed set via `wrangler secret list`) — that
now safely issues a fresh, active credential for it.

### Phase 9 — Lummet's own CMS (homepage no longer hardcoded)

Everything on lummet.com itself — the homepage's copy, and pages,
authors, brand profiles, partners, updates, publications, and
advertisements — was previously either hardcoded HTML in `home.js`
or simply didn't exist as a manageable resource. Phase 9 adds a real
CMS for Lummet's own site, entirely separate from any tenant's
content:

- **New tables** (`migrations/0002_lummet_cms.sql`): `lummet_pages`,
  `lummet_authors`, `lummet_brands`, `lummet_partners`,
  `lummet_updates`, `lummet_publications`, `lummet_advertisements`,
  and `lummet_site_settings` (key/value, same shape as a tenant's own
  `settings` table).
- **`worker/cms-resources.js`** — the field/column contract for each
  resource (mirrors `resources.js`'s shape, but every one of these
  reads/writes this control plane's own D1 directly — there's no
  tenant HTTP call involved, unlike `resources.js`).
- **`worker/cms.js`** — the D1 CRUD layer: list/get/create/update/
  delete per resource, plus `getSiteSettings`/`setSiteSettings` for
  the homepage's editable copy, and `listPublished`/
  `getPublishedBySlug`/`listActiveAdsForPlacement` for what the
  public site actually reads (always filtered to
  published/active — a draft is never publicly reachable).
- **`worker/views/pages/cms.js`** — generic list/create/edit screens
  at `/cms/:resource`, reusing the same rich-text editor as the
  tenant CRUD screens (`renderRichTextField` from `crud.js`), plus a
  dedicated `/cms/settings` screen for the homepage's hero
  copy/CTAs/footer/contact email.
- **`home.js`'s homepage is now dynamic**: hero eyebrow/title/
  subtitle/CTA labels+links, footer text, and contact email all pull
  from `lummet_site_settings`, falling back to the original hardcoded
  copy if a field hasn't been set yet (so a fresh deploy, or one
  before migration 0002 has run, never renders broken/empty). Added
  a live **Updates** section and **Partners** section pulling
  published rows, and an ad-banner slot for the `homepage_banner`
  placement.
- **`/p/:slug`** — a new public route that renders a published
  `lummet_pages` row (e.g. an About page created from
  `/cms/pages/new`). Unpublished/draft pages 404.
- Nav gained a **"Lummet Site"** section: Pages, Authors, Brand
  profiles, Partners, Updates, Publications, Advertisements, and
  Homepage settings.

### Phase 10 — Lummet staff accounts & permissions

Before this phase, `lummet_admins` had exactly one usable role
(`master_admin`, set once at bootstrap) — there was no way to create
a second Lummet staff account at all, let alone scope what they could
do. Phase 10 adds real role-based access control for the control
plane itself:

- **New tables** (`migrations/0003_lummet_admin_rbac.sql`):
  `lummet_admins` gains `status` (active/disabled) and
  `must_change_password`; `lummet_admin_tenant_access` (which
  tenants a staff admin may switch to/act on at all);
  `lummet_admin_permissions` (per-admin resource/action grants,
  scoped by `area` — `tenant` for a tenant's own Content/System
  resources, or `cms` for Lummet's own CMS resources from Phase 9).
- **A super admin** (`role = "super_admin"`, or the legacy
  `"master_admin"` value from before this migration) bypasses every
  check — same pattern as a tenant's own `admin` role bypassing its
  permissions table. **Everyone else starts with zero access** —
  no tenants, no resources — until a super admin explicitly grants
  it. This is enforced by `worker/rbac.js` and checked at the top of
  every route handler that touches a tenant's content, Lummet's CMS,
  or the control plane's own registry/credentials — **not just by
  hiding the nav link**, since hiding a link never actually stops a
  direct request.
- **`/platform/admins`** (super-admin-only) — list staff accounts,
  create a new one (a random temporary password is generated and
  shown exactly once — there's no email-sending set up — and the new
  admin must change it on first login), toggle role/status, and a
  detail screen (`/platform/admins/:id`) with a tenant-access
  checklist and a full permission matrix (create/read/update/delete
  per resource, for both the `tenant` and `cms` areas).
- **Guardrails**: an admin can't change their own role, can't disable
  or delete themselves, and the last remaining super admin can't be
  demoted or deleted — there's always at least one account that can
  grant access to everyone else.
- **A disabled admin's existing sessions are cut immediately** (not
  just blocked at their next login attempt) — `getCurrentAdmin`
  deletes the session row the moment it sees `status = 'disabled'`.
- Nav now filters per-admin: `layout.js` loads the acting admin's
  full permission map once per request and only renders a link if
  they hold a `read` grant on that resource (super admins, and the
  "Dashboard" link, always render). The **Tenants** and **Platform**
  nav sections are super-admin-only outright, since they touch the
  control plane's own registry/credentials rather than a single
  tenant's content.
- Verified end-to-end against a real SQLite-backed mock D1 (not a
  reimplementation): bootstrap → create staff admin → confirm zero
  default access → grant tenant access + a `casinos.read` permission
  → confirm the grant is scoped to exactly that tenant/resource/
  action and doesn't leak to others → revoke → disable/re-enable
  login lockout → last-super-admin protections → CMS create/update/
  delete with slug-uniqueness and draft-vs-published visibility →
  homepage renders admin-edited copy with safe fallbacks → nav
  renders different links for a scoped staff admin vs. a super admin.
  41 assertions, all passing.

This closes out Phases 9 and 10 of the master plan.

### Phase 10.1 — Admin self-service password change

Phase 10 issued temporary passwords for new staff accounts but never
actually gave anyone a way to change them — a real gap, closed here:

- **`/account/password`** — any signed-in admin (staff or super) can
  change their own password: current password, new password (12+
  chars), confirmation. Uses the existing `changeOwnPassword` from
  Phase 10's `auth.js`.
- **Forced on first login**: any admin with `must_change_password = 1`
  (set at account creation) is redirected to `/account/password` for
  every HTML route until they set a real password — enforced
  server-side in `index.js`, not just a suggestion. API routes are
  left alone so nothing silently breaks mid-session.
- A **"Change password"** link is now in the topbar for every admin.

### Phase 9.1 — Site branding & homepage sections

Two things Phase 9 left out: the header/footer still had "Lummet"
and a hardcoded external logo image URL baked in with no way to
change them, and the homepage's section list was fixed — no way to
add more without editing code.

- **New site settings** (same `lummet_site_settings` key/value table,
  no migration needed): `site_name`, `logo_url`, `accent_color`,
  `accent_color_secondary`. Set from **Lummet Site → Homepage
  settings**. The header/footer logo now renders the uploaded image
  (or falls back to the default dot mark) and links home instead of
  to the image file itself — a real bug in the original hardcoded
  markup, fixed as part of this. Accent colors are validated against
  a narrow allow-list (hex / `rgb()`/`rgba()` / bare CSS keyword)
  before being interpolated into a `<style>` block, so an admin
  can't inject arbitrary CSS/HTML through the color fields.
- **`migrations/0004_lummet_homepage_sections.sql`** — a new
  `lummet_homepage_sections` table and matching **Lummet Site →
  Homepage sections** screen. Each section has a title, subtitle,
  rich-text body, optional image, a `layout` (`text_only` /
  `image_left` / `image_right`), an optional CTA button, and a sort
  order. Published sections render on the homepage after the
  built-in Updates/Partners sections, in `sort_order`. A standalone
  page's own body (`/cms/pages`) already supports arbitrary rich
  text/HTML for its own layout, so this is specifically for
  the homepage's fixed section list.
- Verified with 24 additional smoke-test assertions: forced
  password-change lockout and its failure modes (wrong current
  password, mismatched confirmation, too-short new password), custom
  branding actually appearing on the rendered homepage and `/p/:slug`
  pages, the CSS-injection guard on the color fields, and draft vs.
  published visibility for homepage sections.

## Deployment

See **DEPLOYMENT.md** in this same folder for the full, step-by-step
guide covering both the control plane and the tenant-side Super API
(including how they fit together, adding another tenant, day-to-day
operation, and rollback). This README covers what's built; that file
covers how to run it.

## Public website and dashboard shell (from wednesday11, phases 11 to 12.3)

> v7A notes: its migrations 0006-0010 are 0033-0037 here (applied by `node scripts/migrate.mjs`); the staff dashboard is at `/dashboard`;
> the customer portal is at `/app`. Detailed guides: `docs/PUBLIC_SITE.md`, `docs/DASHBOARD_UI.md`, `docs/CHANGES_V7A.md`.

### Phase 11 — Database-driven public website

The public site (`/`, `/brands`, `/updates`, `/insights`, `/partners`,
`/authors/:slug`, `/about`, `/security`, `/privacy`, `/terms`, `/p/:slug`,
`/sitemap.xml`, `/robots.txt`) is now rendered from D1 through a shared
`base.html` + `header.html` + `footer.html` layout, organised like the tenant
(`public/templates`, `public/static/{css,js,images}`, `worker/public-site/`).

- **Migrations:** `0033_public_site_schema.sql` (run once; adds brand
  `category`, per-page SEO columns, homepage section kinds, and the
  `lummet_features`, `lummet_nav_links`, `lummet_faqs` tables) and
  `0034_seed_lummet_content.sql` (real starting content, safe to re-run).
- **Removed:** `worker/views/pages/home.js` and `worker/public-brands.js`
  (hardcoded homepage and brand list).
- **Admin:** Lummet Site gains Features, FAQs and Navigation links; brands,
  pages, updates and publications gain SEO / social-image fields.
- **Docs:** [`docs/PUBLIC_SITE.md`](docs/PUBLIC_SITE.md) (architecture, rules,
  how to add content) and
  [`docs/INTEGRATION_PUBLIC_SITE.md`](docs/INTEGRATION_PUBLIC_SITE.md)
  (Termux integration, deployment and rollback commands).
- **Deploy order matters:** pushing to `main` deploys the Worker but does not
  run migrations, so apply the migrations to the remote D1 **before** pushing.

### Phase 11.1 — Contact and demo pages, interface text in the database

- `/contact` and `/demo` (and any `/forms/<key>`) are rendered from
  `lummet_forms` / `lummet_form_fields`; submissions are stored in
  `lummet_inquiries` and managed under Lummet Site -> Inquiries.
- Small interface text moved out of templates into `lummet_ui_strings`
  (Lummet Site -> Interface text). A test fails if literal text reappears in a
  template.
- Sticky footer: the footer is always at the bottom of the screen.
- Buttons and links hide themselves when their destination has nothing published.
- **Migration:** `0035_contact_demo_forms.sql` (safe to re-run).
- **Optional secret:** `INQUIRY_WEBHOOK_URL` for a new-inquiry notification.

### Phase 12 — Redesigned dashboard shell

- The staff dashboard has a new shell: a grouped, collapsible sidebar behind a
  menu button (docked on desktop, a slide-out drawer on phones), a top bar with
  the tenant switcher, theme toggle and account menu, and a light and a dark theme.
- Navigation is regrouped into 13 sections. Every link, URL and permission rule
  is unchanged; only the grouping and look are new. See `docs/DASHBOARD_UI.md`.
- No migration and no new secret.

### Phase 12.1 — Signed-in staff can browse the public site

- `/` is the public homepage for everyone, signed in or not. The staff dashboard moved to
  **`/dashboard`** (sign-in, password change and the 403 page now send you there).
- The dashboard top bar has a **View site** link. Bookmarks to the old dashboard address `/` now show the public homepage.


## Phase 12.2 — "Sign in" becomes "Dashboard" for signed-in staff

- The public header shows **Dashboard** (linking to `/dashboard`) instead of **Sign in** when a staff member is signed in, on desktop and in the mobile menu.
- Public pages stay edge-cached and identical for everyone. A small script (`public/static/js/session.js`) asks `GET /session-status`, which answers `{ "signedIn": true|false }`, is never cached, and does not touch the database when there is no session cookie.
- The label and target are interface text in the database (`signed_in_label`, `signed_in_href`), editable under Interface text.
- **Migration:** `0036_signed_in_header.sql` (safe to re-run). See `docs/RELEASE_SIGNED_IN_HEADER.md`.

## Phase 12.3 — maintenance release

- **Migration `0037_repair_select_options.sql`** (safe to re-run): restores one option per line for the contact "topic" and demo "properties" dropdowns if their line breaks were lost. Lists that already have line breaks, including ones edited in the dashboard, are left alone.
- **CI:** both workflows run on `ubuntu-24.04` (instead of `ubuntu-latest`, which moves to a newer Ubuntu on 2026-10-19) and use `actions/checkout@v5` and `actions/setup-node@v5`.
- **Cleanup:** outdated comments about the dashboard living at `/` were corrected in `worker/index.js`, and the unused `isAdmin` argument was removed from `handlePublicRoute`. No behavior change. See `docs/RELEASE_MAINTENANCE.md`.


## Durable jobs and webhook retries (v7D)

A maintenance sweep (every tick of `POST /api/ops/alert-check`; point a pinger at it every 5 minutes) restarts lost
background jobs, retries failed provisioning with backoff, dead-letters what keeps failing, and retries failed webhook
deliveries. Optional Cloudflare Queue support. See `docs/DURABLE_JOBS.md` and `docs/CHANGES_V7D.md`.

## Custom domains (v1)

Customers connect their own domain by changing its nameservers; the dashboard tracks progress until the site is live with
HTTPS. See `docs/CUSTOM_DOMAINS.md` (flow, API, limits, staging test), `docs/CONFIGURATION.md` (every setting) and
`docs/CHANGES_V1.md`. Check a setup with `node scripts/check-config.mjs [--online]`.


## v2.3.4 site access gate rollout

`BILLING_SUSPEND_SITES=off|shadow|enforce` defaults to `off` (`on` remains a compatibility alias for `enforce`). Keep it off until the tenant Super API state push has passed staging tests. Site state push retries use the durable `site_access_push_jobs` table; repeated failures raise `site_access_push_failed`. The tenant serve gate fails open when its signed state is absent, stale (>10 minutes), invalid, or unavailable; a five-minute scheduler refreshes denied states. `ENVIRONMENT=staging` is required for `X-Test-Now`; production ignores that header.

# Security review: Phase 9 and 10, control plane part

Method: reading the code of the routes and views listed below, plus the tests named in `RELEASE_CONFIGURABLE_PLATFORM.md`. Not a penetration test, no live system, no fuzzing. Findings marked **open** are not fixed.

## Surfaces and what holds them
| Surface | Who can call it | Checked by | Test |
|---|---|---|---|
| `GET /api/organizations/:orgId/site-setup/options` | member of that organization | organization guard; `productId` must match `^[A-Za-z0-9._:-]{1,120}$` (422 otherwise); lists this organization's site names only | `site-setup-phase10-customer.test.js` |
| `GET /api/organizations/:orgId/sites/:id/setup` | member | site must belong to the organization (else 404) | `site-setup-routes.test.js` |
| `POST .../sites/:id/setup/retry` | organization admin | `requireOrgRole(..., "admin")` and the same site check | `site-setup-routes.test.js` |
| `GET /api/platform/saas/site-setups` | staff super admin | the `/api/platform/saas/` guard; `status` checked against a fixed list (422); `limit` clamped 1 to 200 | `site-presets-staff-phase10.test.js`: no session, customer session and non-super staff refused |
| `POST /api/platform/saas/sites/:id/setup` | staff super admin | same guard; audited (`setup_apply`, `setup_retry`) | `site-setup-routes.test.js` |
| `GET /api/platform/saas/sites/:id/site-system` | staff super admin | same guard; exactly one tenant call, only on request | `phase10-b7-staff-routes.test.js` |
| `POST /api/platform/saas/rollouts` with `canarySiteId` | staff super admin | same guard; audited (`start_canary`) | `phase10-b7-staff-routes.test.js` |
| `POST /api/ci/tenant-release/rollouts` with `canarySiteId` | staff API token with scope `rollout:run` | token check, scope check, per-IP bad-token limit, audited with the token prefix | `phase10-b7-staff-routes.test.js` (a `release:publish` token gets 403) |
| `/platform/saas/site-presets`, `/platform/saas/deployments`, organization page | staff | staff session | `site-presets-staff-phase10.test.js`, `phase10-b7-staff-routes.test.js`, `csp.test.js` |

## Findings
1. **Tenant answers are not stored or shown.** The setup request keeps a status and a short code (for example `tenant_unavailable (HTTP 503)`). Tests check that a tenant body with a secret in it is not stored, and that `site-system` returns only `enabled`, `source` (`env`, `setting`, `default`, else `unknown`) and `envOverride` (only when exactly `true`). A tenant error or a throwing client gives a fixed code (`internal_error`), not the message. Fixed by design, tested.
2. **Isolation between organizations.** Customer routes compare the site's organization with the one in the URL and answer 404 otherwise; the options route lists only the caller's own sites; the Sites page test checks another organization's site and setup never appear. Tested for the options route and the page, and for the read and retry routes (`site-setup-routes.test.js`: members read, admins retry, another organization gets 404 for both).
3. **Output encoding and CSP.** Site names and short codes go through `escapeHtml`; the new pages use `onClick`/`onSubmit` data attributes and a nonced script, and the tests check that every handler is defined in a nonced script and that a hostile site name (`<img onerror>`, `<script>`) is escaped on the Site presets and Deployments pages. The canary site chooser is built from escaped option text; the canary note is limited to 200 characters. The Deployments page does not print the canary note in the part I read; if a later change prints it, it must be escaped (**watch**).
4. **Read only against tenants.** The control plane never flips a tenant's master switch; it only reads it. The tenant calls go through the existing signed client; this review did not re-read that client.
5. **Two drivers.** The tick and `alert-check` can pick the same request. A compare-and-swap on `updated_at` makes only one count the attempt and call the tenant. The tenant call is also idempotent. Tested with sequential and concurrent calls on the SQLite shim. **Open:** real D1 behaviour of `meta.changes` is assumed to match.
6. **Canary policy is a guard, not an access control.** `ROLLOUT_REQUIRE_CANARY` stops a rollout to every site by mistake (staff or CI). It does not stop a staff user from starting a rollout limited to chosen sites, by design. A canary is recognised by the `canary:` prefix in the rollout's notes, which a staff user can type by hand into a normal rollout's notes: that rollout would then count only if it completed with a succeeded or already-on-version item, so the effect is limited to staff who can already roll out. **Open (low):** a dedicated column would be stricter; it needs a migration and was left out on purpose.
7. **Denial of service by the sweep.** At most 5 requests per run, 6 tries each, with growing waits; a failing tenant costs one call per try. Tested. The cost of the staff list is bounded by `limit` 200.
8. **Draft preview with the switch off (tenant).** Decided and implemented: no draft is shown while the switch is off. The cookie is `HttpOnly; Secure; SameSite=Lax`, one hour. Tested for `resolvePreview`; not tested through the whole Worker.
9. **Rate limiting of the staff routes.** I found no per-route limit on the new staff GET routes beyond the staff session. **Open (low):** they are read only and behind login.
10. **Preset list copy.** The preset ids are mirrored in the control plane and checked against a fixed list before they are sent; an unknown id is refused. Each repository now pins the same list in its own test (`test/preset-ids-pinned.test.js`, tenant `en/test/preset-ids-pinned.test.js`), so a change on one side fails a test. **Open (low):** nothing runs both repositories together.

## Not reviewed
The tenant Super API handlers and their authentication, the signed client (`worker/client.js`), the deployment engine, Stripe and email paths, and everything outside Phase 9 and 10.

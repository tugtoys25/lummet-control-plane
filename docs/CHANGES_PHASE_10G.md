# Phase 10 partial G (control plane): changes on top of partial F

**NOT production ready.** Partial G finishes the "run first" step of PROMPT_NEXT and TODO 3 (A5 tests). TODO 4, 5 and 6 were not started; TODO 7 is for a human.

## Added
- `test/site-presets-staff-phase10.test.js` (7 tests), through the real `worker.fetch`:
  - `GET /api/platform/saas/site-setups`: 401 without a session; refused for a customer cookie; 403 for staff who are not super admins; super admin gets `overview`, rows and `presets`; `?status=` filters; unknown status is 422 `invalid_status`; `limit` is honoured and an oversized limit is clamped; the answer never carries the stored sections, the source tenant, `requestedBy`; POST, PUT and DELETE change nothing.
  - `/platform/saas/site-presets`: login redirect without a session, nothing for a customer, 403 for non-super staff, real page with a nonce and `script-src-attr 'none'` for a super admin; every inline script carries the response nonce; no inline `on*` attribute; every `data-on*` handler is defined in the page script; hostile request values are escaped; Retry buttons only for pending or failed requests that belong to a site.
  - Navigation: "Site presets" is in the Tenants group (super admin only), once, shown to super admins and hidden from non-super staff.
- `test/csp.test.js`: `/platform/saas/site-presets` added to the staff pages list of the "real pages" test.

## Changed
Nothing in `worker/`. Tests and docs only. No migration.

## Not changed
No tenant change (identical to C, D, E and F).

# v7E: Content-Security-Policy, DNS-aware outbound checks, atomic Super API nonce

Tests: control plane 841 (v7D) -> 872, tenant 917 -> 920, all passing. Not run in a real browser or against live
Cloudflare. See `docs/CSP.md`.

## Content-Security-Policy
- `worker/csp.js`: per-response nonce (secret-token swap), `script-src 'nonce-...'` and `script-src-attr 'none'`,
  template helpers `onClick/onSubmit/onChange/onInput`, a static delegated runtime, browser-side `lummetAttrs`.
- **All inline event handlers removed** (68 converted by script, the rest by hand: prompts, forms, `this.value`
  cases, four handlers built inside browser strings, including the media picker) and **every inline script nonced** (36 files).
  Tests scan the whole of `worker/` and fail on a handler attribute, an un-nonced script, or a template naming a
  function that is not defined; mutation checks confirmed they catch regressions.
- Ships in **report-only** (`CSP_MODE`), with `POST /api/csp-report` logging violations. Flip to `enforce` after staging.
  The production configuration check now asks for `CSP_MODE=enforce`.
- A media-picker thumbnail URL is now attribute-escaped (it was concatenated raw).

## DNS rebinding
- `checkOutboundUrlResolved()` resolves A/AAAA over DoH and refuses a host if any address is private, loopback,
  link-local, metadata, multicast, documentation or NAT64-embedded-private. Used for webhook URLs (saved and every
  delivery attempt) and SSO token/jwks endpoints. 60 s cache, failed lookups not cached; a failed lookup during delivery
  is retried later, not killed. On by default in production (`OUTBOUND_DNS_CHECK=off` to disable).
- Remaining gap, stated plainly: the fetch resolves the name again. See SECURITY_REVIEW_2_1.md.

## Tenant Super API
- Nonce check is one atomic `INSERT ... ON CONFLICT DO NOTHING` (was SELECT then INSERT). New tests include 8
  simultaneous identical requests.

## Not in v7E
- Style policy (inline styles remain allowed). Tenant site pages. The SSO "link an existing password account" flow
  (a product decision with account-takeover risk). Per-key rate limiting on `/api/v1`.

## Upgrade notes
No migration. Set `CSP_MODE` (report-only first), keep `OUTBOUND_DNS_CHECK` unset, and watch the Worker logs for
`csp_violation` before enforcing.

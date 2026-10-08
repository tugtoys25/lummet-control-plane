# Security review (roadmap 2.1): findings

A targeted read-through of the areas the roadmap named. It is NOT a full
penetration test, and nothing here was run against live infrastructure.

## Fixed in this pass

| # | Finding | Severity | Fix |
|---|---------|----------|-----|
| 1 | `POST /api/organizations/:id/sites/:siteId/deployments` accepted `scriptContent`, `version` and `migrations` from the customer's request body. Any org admin could deploy arbitrary code into the shared tenant Worker (and run arbitrary SQL migrations). | **Critical** | Script, version and migrations now come only from the published tenant release. Request-body values are ignored. |
| 2 | The rollback route accepted a customer-supplied `scriptContent` that overrode the stored release. Same impact as #1. | **Critical** | Rollback uses only the stored release for the target version; if none exists it returns `409 release_unavailable`. |
| 3 | Webhook URLs were only checked for `https`. Localhost, private ranges, `169.254.169.254` (cloud metadata), IPv6 loopback/private, embedded credentials and odd ports were all accepted. | High | New `worker/url-safety.js` blocks them at creation and again at delivery. |
| 4 | Webhook delivery followed redirects and had no timeout, so a public URL could redirect the fetch to an internal address, or hold the Worker open. | High | `redirect: "manual"` (a redirect now records a failed delivery) and a 10 second timeout. |
| 5 | `/api/v1/*` (API keys) had no rate limiting, so bad keys could be guessed without limit. | Medium | 20 failed attempts per IP per 15 minutes, then `429`. Only failures are counted, so valid integrations see no extra database writes. |

### Second pass: SSO, CSRF, headers

| # | Finding | Severity | Fix |
|---|---------|----------|-----|
| 6 | **SSO account takeover.** On SSO login the server matched the email from the ID token to ANY existing account and signed in as it. The identity provider is configured by the organization's own admin, so an admin could host an IdP, assert `victim@anywhere.com`, and get a session as that user across all of the victim's organizations. | **Critical** | SSO now only signs in accounts that SSO itself created for the SAME organization (`customer_users.sso_organization_id`, migration 0028). An email that belongs to anyone else is refused (`account_exists_not_managed_by_sso`), including users who are merely members of the attacker's organization. An IdP saying the email is not verified is refused. |
| 7 | SSO endpoints (token, key set, issuer, authorization) were unvalidated customer URLs fetched server-side, and the token request carries the client secret. SSRF and secret-redirect risk. | High | Same URL safety check as webhooks at save time and again at use; redirects are not followed; 10 second timeout. |
| 8 | A "forgot password" on an SSO-managed account could hand its password to whoever reads the email while the organization's IdP could still sign in to it. | Medium | Reset is refused for SSO-managed accounts, with the same response as an unknown address. |
| 9 | **No CSRF protection beyond SameSite cookies.** Customer sites live on sibling subdomains of the platform domain, which browsers treat as "same site", so a malicious customer site could drive a visiting admin's or customer's browser to send state-changing requests. | High | Any non-GET request that carries cookies must come from this exact origin (`Origin` / `Sec-Fetch-Site`), else `403 cross_site_request_blocked`. Cookie-less callers (Stripe, API keys, the alert pinger) are unaffected. |
| 10 | No security headers: the console could be framed (clickjacking) and token links (verify email, reset password, invitations) leaked via `Referer`. | Medium | Every response now sends `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `nosniff`, HSTS and a restrictive Permissions-Policy. |

An existing test had encoded the vulnerable SSO behaviour ("existing user logging in via SSO gets membership added"). It now asserts the refusal.

## Checked and found sound

- **Cross-organization access (IDOR)** on domains, deployments, backups and automations: every route resolves the resource through the caller's organization before acting.
- **DNS verification** (`dns-doh.js`): the hostname is URL-encoded, validated on add, and sent only to a fixed Cloudflare endpoint, so it is not an SSRF vector.
- **Super API**: 5-minute timestamp window and single-use nonces are intact.
- **Customer login, signup, forgot-password** and **staff login** are rate limited.

## Open: not fixed, needs a decision or more work

1. ~~**Staff accounts have no second factor.**~~ **Done** (see `docs/STAFF_2FA.md`): TOTP with backup codes, replay guard, challenge limits, optional `STAFF_2FA_REQUIRED=true`. It is off by default; enrol every admin, then turn it on.
2. ~~**DNS rebinding on webhooks.**~~ **Mostly closed in v7E** (`checkOutboundUrlResolved` in `url-safety.js`): webhook URLs and SSO token/key-set endpoints are resolved over DoH and refused if ANY address is private, loopback, link-local, metadata, multicast, documentation or NAT64-embedded-private, when the URL is saved AND on every delivery attempt. On by default in production (`OUTBOUND_DNS_CHECK=off` disables it). Remaining, honestly: Workers resolve the name again when they fetch, so a resolver that answers differently the second time still passes this check; what closes that is that Workers cannot reach private networks, redirects are refused, and the check repeats per attempt.
3. **Webhook delivery was one attempt, with no retry queue.** Reliability, not security. (v7D: retried with backoff and dead-lettered, see DURABLE_JOBS.md.)
4. ~~**Super API nonce check is read-then-insert.**~~ **Fixed in v7E**: `super_api_nonces` already has `PRIMARY KEY (credential_id, nonce)`; the check is now one `INSERT ... ON CONFLICT DO NOTHING`, so simultaneous replays get a clean rejection instead of an unhandled constraint error (`lummet-tenant/en/test/super-api-nonce.test.js`).
5. **No per-key rate limit on valid `/api/v1` use**, and the staff API has no general request limit. Low risk today; revisit with real traffic.
6. ~~**SSO email squatting.**~~ **Fixed** (migration 0029, `worker/sso-domains.js`): an organization may only assert addresses in domains it proved it owns with a DNS TXT record `_lummet-sso.<domain>`, and one verified domain can belong to only one organization. Remaining: existing users cannot link a normal account to SSO (a different address or re-provisioning is needed), and subdomains must be added explicitly.
7. ~~**Content-Security-Policy has no script-src.**~~ **Done in v7E** (`worker/csp.js`, `docs/CSP.md`): nonce-based `script-src`, `script-src-attr 'none'`, no inline handlers anywhere in `worker/`. Ships in report-only mode; flip `CSP_MODE=enforce` after staging shows no violations. Not covered: `style-src` (inline styles remain allowed) and the tenant sites in `lummet-tenant`, which have their own pages.
8. **Not reviewed in depth:** the AI gateway beyond input-length limits (8,000 characters per field) and credit reservation, tenant-side code in `lummet-tenant`, and WebAuthn.
9. **Link-token pages** (verify email, reset password) are GET pages that act through a following POST, which is the safe pattern; not otherwise tested for token reuse timing beyond existing tests.

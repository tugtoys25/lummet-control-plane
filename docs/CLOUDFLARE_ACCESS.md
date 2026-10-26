# Cloudflare Access for platform routes (Round 6.3B, release 2.6.0.7)

Cloudflare Access is an extra login in front of `/platform/*` (staff console pages) and `/api/platform/*` (staff console API). It is **in addition to** staff sessions, staff 2FA and RBAC, which are unchanged. When the flag is on, the Worker also checks the signed Access JWT itself, so a request that reaches the Worker without passing Access (for example on a `workers.dev` hostname) is refused.

Evidence labels: the Worker code and tests are **TESTED LOCALLY**. The Access application, the identity provider, MFA at the IdP and all live behavior are **NOT VERIFIED** until the owner attaches staging evidence. Nothing in this repository changes Cloudflare.

## What the Worker does

`PLATFORM_ACCESS_JWT_MODE` (Worker variable):

| Value | Behaviour |
|---|---|
| `off` (default, also unset or blank) | Nothing is checked and Cloudflare is never contacted. Behaviour is exactly as before. |
| `shadow` | Every platform request is verified; a failure logs `cloudflare_access_jwt_check` with the path, mode and a reason code, and the request continues. Use it to prove the Access setup before enforcing. |
| `enforce` | A missing, invalid, expired or unverifiable JWT is refused: `403 platform_access_required`. If `CF_ACCESS_ISSUER`/`CF_ACCESS_AUD` are missing or invalid, or the Cloudflare key set cannot be fetched, the answer is `503 platform_access_unavailable` (fail closed; nothing is let through). |
| anything else | Refused with `503 platform_access_unavailable`, in every environment. A typo such as `enforced` must not silently switch the control off. |

Verification (`worker/cloudflare-access-jwt.js`): only the `Cf-Access-Jwt-Assertion` header is read (never `Authorization`, which staff API tokens use); RS256 only; key chosen by `kid` from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (cached 5 minutes; an unknown `kid` allows one refresh per 30 seconds); signature checked before any claim is trusted; `iss` must equal `CF_ACCESS_ISSUER` exactly; `aud` (string or array) must contain `CF_ACCESS_AUD`; `exp` is required; `nbf` and `iat` are checked with 30 seconds of clock skew. The JWT, claims, email and subject are never logged or returned.

Reason codes in the log: `configuration`, `missing`, `malformed`, `algorithm`, `jwks_unavailable`, `key_not_found`, `signature`, `issuer`, `audience`, `expired`, `not_yet_valid`, `issued_in_future`.

## Worker settings

| Setting | Meaning |
|---|---|
| `PLATFORM_ACCESS_JWT_MODE` | `off`, `shadow` or `enforce`. Production must set it explicitly (config-check). |
| `CF_ACCESS_ISSUER` | Team domain, `https://<team>.cloudflareaccess.com`. Required (config-check) once the mode is not `off`. |
| `CF_ACCESS_AUD` | The Access application's AUD tag. Required once the mode is not `off`. |

## What is NOT behind Access (on purpose)

Access cannot be completed by machines or by people who are not signed in yet, so these stay outside the Access application and are listed in `neverProtect` in the policy file: `/api/health`, `/api/csp-report`, `/api/billing/webhook/stripe`, `/api/ci/` (CI release publishing uses a staff API token), `/api/ops/` (the alert pinger), `/api/v1/` (customer API keys) and `/api/auth/` (staff sign-in and second factor). They keep their own protections (WAF rate limits from 6.3A, tokens, signatures, 2FA). `scripts/cloudflare-access-config.mjs` refuses a policy file whose protected paths overlap them.

Manual use of `publish-tenant-release.mjs` with `LUMMET_STAFF_COOKIE` goes through `/api/platform/saas/...` and therefore also needs an Access session once Access is on; the CI path (`LUMMET_STAFF_TOKEN`, `/api/ci/tenant-release/...`) is unaffected.

## Config as code

`config/cloudflare-access-policy.v1.json` is the reviewed template: application name, protected paths, deny by default, one allow policy that requires MFA at the identity provider, and the owner values as `[OPEN]` placeholders. Check and render it (offline, no network, no mutation):

```
node scripts/cloudflare-access-config.mjs            # validate, list [OPEN] placeholders, print the plan
node scripts/cloudflare-access-config.mjs --strict   # exit 1 while any [OPEN] placeholder remains
node scripts/cloudflare-access-config.mjs --out access-plan.json
```

There is deliberately no `--apply`: the exact Cloudflare Access API payload could not be verified against a live account, so the owner creates the application and policy in the Cloudflare Zero Trust dashboard (or their own tooling) from the printed plan.

## Owner runbook (live changes, owner-run)

1. Close the `[OPEN]` items in `docs/PLACEHOLDERS.md` (Round 6.3B): team domain, control-plane hostname, identity provider, staff group, session duration.
2. In Zero Trust, add the identity provider and require MFA there. Create a self-hosted application for the control-plane hostname with two destinations, `/platform/*` and `/api/platform/*`, and one **Allow** policy for the staff group. Leave everything else denied. Do not add `/api/ci/`, the Stripe webhook, `/api/health`, `/api/csp-report`, `/api/ops/`, `/api/v1/` or `/api/auth/`.
3. Copy the application's AUD tag and the team domain into `CF_ACCESS_AUD` and `CF_ACCESS_ISSUER` for **staging** and set `PLATFORM_ACCESS_JWT_MODE=shadow`.
4. Sign in to the staff console through Access and use several pages. In the Worker logs, confirm there is no `cloudflare_access_jwt_check` line for those requests. Request a platform URL without Access (for example the `workers.dev` hostname) and confirm a line with a reason code appears.
5. Set `PLATFORM_ACCESS_JWT_MODE=enforce` on staging. Confirm: signed in through Access works; a request without the header gets 403; staff 2FA still prompts. Attach the evidence (screenshots or log lines, without tokens).
6. Repeat 3 to 5 on production, `shadow` first. Keep a second staff member signed in while switching to `enforce`.
7. Disable the `workers.dev` route for the production Worker (`workers_dev = false`), so the only way in is through the Access-protected hostname.

## Rollback

Set `PLATFORM_ACCESS_JWT_MODE=off` (or `shadow`) and redeploy the variable change; behaviour returns to the previous state immediately, no data or schema is involved. If the Cloudflare key endpoint is down while enforcing, platform routes answer 503 until it recovers; switch to `shadow` to restore staff access while keeping the Access application in place, and record the decision.

## Staff lock-out recovery

Because enforce fails closed, keep a documented break-glass route: a staff member with Cloudflare dashboard access can set the variable to `off`. The staff 2FA recovery path is unchanged (`docs/STAFF_2FA.md`).

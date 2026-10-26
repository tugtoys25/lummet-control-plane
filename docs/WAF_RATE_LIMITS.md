# Cloudflare WAF rate limits (v2.6.0.6, Round 6.3A)

Edge rate limiting for sign-in, billing, contact and invitation endpoints. The rules are versioned config
(`config/cloudflare-waf-rate-limits.v1.json`) applied by an owner-run script. Nothing here changes Cloudflare until you run `--apply`.

## What is covered
| Rule key | Endpoints (method) |
|---|---|
| `auth-staff` | `POST /api/auth/login`, `/api/auth/login/mfa` |
| `auth-customer` | `POST /api/customer/` login, signup, password/forgot, password/reset, mfa/complete, email/verify, webauthn/login/options, webauthn/login/verify |
| `invitations` | `POST /api/invitations/<token>/accept`, `POST /api/organizations/<id>/invitations` |
| `billing` | `POST` and `PUT` on `/api/organizations/<id>/billing/*` (checkout, portal, change-plan, cancel, pause, coupon) |
| `contact` | `POST /contact`, `/contact-sales`, `/forms/<key>` |

Never rate-limited, enforced by the config validator: the Stripe webhook (`/api/billing/webhook/stripe`) and `/api/csp-report`.
The Worker keeps its own application-level limits; the WAF rules are an additional outer layer.

## Owner inputs ([OPEN], BLOCKED until supplied)
1. `CF_WAF_ZONE_ID` — the 32-character zone id (the zone for the control-plane hostname).
2. Plan limits for that zone's Cloudflare plan: `CF_WAF_MAX_RULES`, `CF_WAF_ALLOWED_PERIODS` (comma list of seconds, for example a value copied from the Cloudflare dashboard) and `CF_WAF_MAX_TIMEOUT`. They are not guessed here; `--apply` refuses without them and checks every rule against them.
3. Thresholds. Defaults in the JSON file are placeholders. Override per rule with `WAF_RATE_LIMIT_THRESHOLDS='{"auth-customer":{"requests":8,"period":60,"timeout":600}}'`, then set `WAF_THRESHOLDS_CONFIRMED=yes`.
4. Whether the plan supports the expression functions used (`starts_with`, `ends_with`, `contains`). Cloudflare rejects a rule it does not allow and the script reports the error.

## Runbook (owner-run)
1. Dry run (no network, no changes): `node scripts/cloudflare-waf-rate-limit-config.mjs` prints the rules and any blockers.
2. Staging first. Export `CF_API_TOKEN` (permission: Zone > Zone WAF > Edit, limited to the zone), `CF_WAF_ZONE_ID`, `CF_WAF_ENVIRONMENT=staging`, the plan limits and thresholds.
3. Read-only diff: `node scripts/cloudflare-waf-rate-limit-config.mjs --mode staging --diff`.
4. Apply: `node scripts/cloudflare-waf-rate-limit-config.mjs --mode staging --apply --out evidence.json`.
5. Production adds `CF_WAF_ENVIRONMENT=production`, `CF_WAF_CHANGES_APPROVED=true` and `--allow-production`.
6. Only rules whose ref starts with `lummet-v1-` are created, updated or removed. Other rules in the zone are preserved.
7. Roll back: `... --apply --rollback` removes only the managed rules.
8. After applying, test sign-in from a normal browser and watch Security > Events for legitimate users being blocked.

## Retry-After
Cloudflare's own block sets `Retry-After` from the rule's mitigation timeout. For the Worker's own 429 responses set
`RATE_LIMIT_RETRY_AFTER=on` (default `off`): the Worker adds `Retry-After` of 900 seconds for sign-in/API attempt windows,
60 for AI calls and 3600 for public forms. These are the window lengths (upper bounds), because the Worker's limiters do not record
when the oldest attempt expires. An existing `Retry-After` is never overwritten.

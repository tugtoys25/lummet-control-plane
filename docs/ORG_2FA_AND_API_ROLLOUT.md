# Rolling out the 2.6.1.6 settings

**Before deploying 2.6.1.6: apply migration 0077** (`ALTER TABLE customer_sessions ADD COLUMN auth_method TEXT`). Every new session now
writes that column whatever the settings are, so deploying the code first would make sign-in fail until the migration is applied.
Existing sessions are untouched (the column is NULL for them).

All three settings default to today's behaviour. Turn them on one at a time, staging first. Every setting can be set back at any time.

## API_ENTITLEMENT (api.enabled)
1. `shadow`: nothing is refused; the Worker logs `api_entitlement_would_refuse` with the organization id for each key creation or key
   use that `enforce` would refuse. Read those logs for a week and decide what to tell those customers.
2. `enforce`: creating a key on a plan without `api.enabled` returns 403 `api_not_enabled`, and an existing key of such a plan stops
   working (403 on `/api/v1/*`). An organization that is read-only for non-payment keeps its keys reading.
Rollback: `off`. Nothing is deleted; keys work again at once.

## ORG_2FA_PASSKEY_COUNTS
`on`: a passkey sign-in with user verification satisfies an organization's 2FA requirement, and passkey registration and sign-in ask
for user verification. People who signed in with a password stay restricted until they use their passkey (or an authenticator).
Existing sessions have no recorded method and count as password sessions, so nobody gains access by this switch.

## ORG_2FA_SCOPE
`active_org`: an organization's 2FA requirement restricts that organization only. Check with a test account that belongs to one
organization with the requirement and one without: the first returns 403 `org_2fa_required` on its routes, the second works, and
`POST /api/organizations/:id/switch` into the second works from a restricted session. Rollback: `any_org`.
Decision still yours: whether a member who is restricted in one organization should be able to use their other organizations at all.
`active_org` says yes; `any_org` (today) says no.

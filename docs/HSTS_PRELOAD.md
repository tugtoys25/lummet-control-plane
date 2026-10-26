# HSTS and preload (Round 6.3C)

**Default (`HSTS_PRELOAD=off`)**: every response carries `Strict-Transport-Security: max-age=31536000; includeSubDomains`, exactly as before this round.

**`HSTS_PRELOAD=on`**: `max-age=63072000; includeSubDomains; preload`. The header is set by the Worker on every response type (pages, JSON, redirects, errors, the CSP report endpoint, public site, static files). A stronger value already set by a route is kept, never a weaker one.

## Why preload is hard to undo
Submitting a domain to the browser preload list is the owner's act, outside this code. Once browsers ship the list, removal takes months, and `includeSubDomains` then forces HTTPS on **every** subdomain of the registrable domain, including customer-site hostnames under `PLATFORM_DOMAIN_SUFFIX`. Any subdomain that cannot serve valid HTTPS becomes unreachable. Because of this, config-check requires `HSTS_PRELOAD_APPROVED=yes` before production may run with `HSTS_PRELOAD=on`. [OPEN] owner approval.

## Procedure
1. Staging first: set `HSTS_PRELOAD=on`, run `node scripts/hsts-preload-check.mjs --url https://<staging-host>/` and attach the output.
2. Owner confirms: valid certificate for the apex and all subdomains, all subdomains served over HTTPS, header on the apex, http-to-https redirect on the same host.
3. Production: set `HSTS_PRELOAD=on` and `HSTS_PRELOAD_APPROVED=yes`, redeploy, run the check against the apex.
4. Submit at hstspreload.org yourself, re-reading their current requirements (the script encodes max-age of at least one year, includeSubDomains, preload as understood when written).
Rollback of the header: set `HSTS_PRELOAD=off`. This stops sending `preload` but does NOT remove a domain that is already on the list.

## Evidence labels
Header behaviour: TESTED LOCALLY (tests in `test/hsts-preload.test.js`). Live host eligibility, certificate coverage, subdomain HTTPS, preload-list submission: NOT VERIFIED until an owner attaches the script output.

# Runbook: Cloudflare incident

Almost everything runs on Cloudflare: the control-plane Worker, D1, R2 (backups, templates), queues, the tenant Workers,
custom hostnames for customer domains, and (when switched on) Access and WAF rules. Work out whether Cloudflare is failing
or whether **our own change** to Cloudflare configuration is failing. The second is more common and is ours to roll back.

## Trigger

- The Cloudflare status page reports an incident for Workers, D1, R2, Queues, DNS, SSL for SaaS or Access.
- Sign-in, the staff console, customer sites or custom domains fail for many people at once.
- `synthetic_signin`, `synthetic_canary_site` or `synthetic_domain_attach` is failing ([synthetic monitors](../SYNTHETIC_MONITORS.md)),
  or `failed_domains`, `unhealthy_tenants`, `failed_sites` or `server_errors` fires.
- Legitimate users are blocked right after a WAF, Access or CSP change (ours).

## First 15 minutes

1. Open the incident record ([template](../RUNBOOKS.md#incident-record)). Note UTC start and which surface fails: control-plane
   portal, staff console (`/platform/*`), customer sites, custom domains, or backups.
2. Did we change Cloudflare configuration or deploy in the last hour? If yes, treat it as our change and roll that back first:
   - WAF rate-limit rules: `node scripts/cloudflare-waf-rate-limit-config.mjs --mode <staging|production> --apply --rollback`
     removes only the managed rules (production needs the extra approvals listed in [WAF rate limits](../WAF_RATE_LIMITS.md));
     only rules whose ref starts with `lummet-v1-` are touched.
   - Cloudflare Access in front of platform routes: staff lock-out means `PLATFORM_ACCESS_JWT_MODE` set to `off` (or `shadow`)
     by someone with Cloudflare dashboard access and a redeploy of that variable ([Cloudflare Access](../CLOUDFLARE_ACCESS.md),
     "Staff lock-out recovery"). While enforcing, platform routes answer 503 if Cloudflare's key endpoint is unreachable: that is by design.
   - CSP: stay in report-only; do not flip to enforce during an incident ([CSP](../CSP.md)).
   - A Worker deploy: roll the Worker back to the previous version.
3. Customer sites: they run as separate tenant Workers and the control plane is not in their request path. A suspended or
   closed site shows the neutral page; a site the control plane cannot reach **fails open** by design, so a control-plane
   outage should not take customer sites down. If sites are down, it is the tenant Worker, DNS or the custom hostname.
4. Look for a pattern in the failing hostnames: all of them (account or zone), only custom domains (SSL for SaaS or fallback
   origin), or only one customer (their DNS: not an incident).
5. If D1 is the failing part, switch to the [D1 incident](d1-incident.md) runbook; if the only symptom is delayed events,
   see [webhook backlog](webhook-backlog.md).

## Do not

- Do not delete or recreate custom hostnames, zones, DNS records or Access applications to "reset" them. Re-creation changes
  certificates, validation and ownership state, and it can take customer domains offline for longer than the incident.
- Do not apply WAF or Access configuration changes to production during the incident except to roll back a change of ours.
- Do not deploy or migrate to work around a Cloudflare outage; deploys can fail half-way during one.
- Do not flip `CSP_MODE`, `BILLING_ENFORCE`, `BILLING_SUSPEND_SITES` or the Access mode to enforce while Cloudflare is unstable.
- Do not put API tokens in tickets. Say which token (name) and which permission was used.

## Recovery and verification

1. Cloudflare-side incident: wait for their all-clear, then verify end to end rather than trusting the status page:
   sign in as a customer, sign in as staff, open one customer site and one custom domain, check the alerts page, run
   "Run check now", and confirm the sweep ran (`cron_not_running` clear).
2. Our change: after the rollback, repeat the same checks, and keep the rollback evidence (rule refs removed, variable value
   before and after, time).
3. Custom domains stuck after the incident: use the staff domain tools to re-check status; the hostnames that `failed_domains`
   lists need the existing retry path, one at a time ([custom domains](../CUSTOM_DOMAINS.md)).
4. Queued work resumes by itself (durable jobs, the sweep); look at `dead_jobs` and `stuck_jobs`, and retry dead-lettered jobs
   with `POST /api/platform/saas/jobs/:id/retry` ([durable jobs](../DURABLE_JOBS.md)).
5. Backups: if R2 was affected, check `backup_stale` and run SaaS > DB backups > "Back up now" and Verify once healthy.
6. Done when the checks pass from a network that is not the office, the alerts have resolved, and the monitors (if on) are green again.

## Record the incident

Cloudflare incident reference (if any), the surfaces affected and for how long, any configuration of ours changed or rolled back
(file, version, time), counts of sites and domains affected, jobs retried, and what you verified at the end.

## Who and how (placeholders)

**[OPEN]** Who holds the Cloudflare dashboard break-glass access, the Cloudflare plan and its support level, the zone ids and
the paging order are owner facts and are not in this repository (`docs/PLACEHOLDERS.md`, Round 6.5B and Round 6.3A/6.3B items).

## Evidence status

STATIC REVIEW. NOT VERIFIED: no Cloudflare incident, rollback of WAF rules, or Access lock-out recovery has been exercised live.
The fail-open behaviour of the site access channel is stated by the blueprint and the code comments; it was not observed live.

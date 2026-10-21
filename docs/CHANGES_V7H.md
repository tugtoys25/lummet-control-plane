# v7H: automations that react to a site's tracking links, and disabling links from the portal

Tests: control plane 913 (v7G) -> 927, tenant 924 (unchanged), all passing. Nothing run against a live site.

## What is new
**1. A new automation trigger and action.**
- Trigger `tracking_link.unhealthy` ("A tracking link becomes unhealthy"). Event data a rule can test: `healthStatus`
  (`warning`, `broken`, `restricted`, `timeout`), `siteId`, `siteName`, `trackingLinkId`, `name`. The automations page has
  an optional "only for tracking links that are ..." choice that adds the `healthStatus` condition.
- Action `disable_tracking_link` ("Disable that tracking link (reversible)"). Sets that one link's status to `disabled` on the
  site (the same switch as in the site's own dashboard; it is never deleted). Combine it with `notify_owners` / `create_alert`
  in a rule to be told as well.

**2. The sweep that raises the event.** A link going unhealthy happens inside a customer's site, so the maintenance tick
(`/api/ops/alert-check`, the same one that retries jobs and webhooks, or a Cron Trigger) asks live sites for their
tracking-link health and raises the event per unhealthy link:
- only sites whose organization has an ACTIVE rule for this trigger are asked, at most 10 per tick, least recently asked first
  (`automation_sweep_state`, migration `0043`), so a site with no rule costs nothing;
- the event id includes the day: a link that stays unhealthy re-runs its rule at most once a day (the disable action normally
  ends it sooner). A rule that has hit its hourly cap retries that link the next day;
- one broken or unreachable site never stops the sweep.

**3. Disable links from the portal.** On Analytics, the Tracking links card shows a Disable button per unhealthy link and
"Disable all listed (n)" (editors and above, plan with affiliate tools). Behind it: `POST /api/organizations/:id/sites/:siteId/
tracking-links/disable {ids}` (at most 50, editor+, audited with counts only).

## One service behind both (`worker/tenant-links.js`)
The portal button and the automation action use the same code, so they obey the same rules: a live site of THAT organization
(a site id from a request or an event is never trusted), `affiliate.enabled` in the plan, the only change ever made is
`status: "disabled"`, one signed Super API request per link, each answered on its own. The automation action also writes an
audit row (`actor_type system`, `initiated_by automation`).

## Found while testing
The sweep first imported the tenant portal module instead of its `tenantPortal` instance, so the default health lookup would have
failed silently in production. Unit tests that injected their own lookup passed; the test that runs the real maintenance tick
caught it.

## Not in v7H (said plainly)
- Approval workflows for content or offers. Those objects live in each site's own database, so approvals belong in the
  tenant; the control plane's approvals still cover site deletion only.
- More AI tools. The AI tasks are prompt templates over what the caller supplies; tools that read a site's data (find missing
  SEO metadata, analyse affiliate performance) are not built.
- Bulk operations other than disabling tracking links (publish, archive, assign...).
- Offers: the tenant can disable offers over the same API, but no automation action does it yet.

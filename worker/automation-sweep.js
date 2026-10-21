// =====================================================
// AUTOMATION EVENTS THAT COME FROM A SITE (v7H)
//
// Platform events (payment failed, site deployed...) are raised by the control plane itself. "A tracking link went
// unhealthy" happens inside a customer's site, so the periodic maintenance tick asks sites that matter whether any link
// is unhealthy and raises tracking_link.unhealthy for each one.
//
// Only sites whose organization has an active rule for that trigger are asked, a few per tick, least recently asked
// first. An event id carries the day, so a link that stays unhealthy re-runs the rule at most once a day (the disable
// action normally ends it sooner); a rule that hits its hourly cap retries the link the next day.
// =====================================================
import * as sweepRepo from "./repositories/automation-sweep.js";
import { tenantPortal } from "./tenant-portal.js";
import * as automations from "./automations.js";
import { UNHEALTHY_STATUSES } from "./tenant-links.js";

export const EVENT = "tracking_link.unhealthy";
export const MAX_SITES_PER_TICK = 10;

export async function sweepTrackingLinkEvents(env, { maxSites = MAX_SITES_PER_TICK, now = new Date(), getHealth = (e, site) => tenantPortal.getTrackingHealth(e, site) } = {}) {
  const day = now.toISOString().slice(0, 10);
  const summary = { sites: 0, events: 0, skipped: 0 };
  for (const site of await sweepRepo.listSitesDue(env, EVENT, maxSites)) {
    summary.sites++;
    try {
      const health = await getHealth(env, { ...site });
      if (health && health.ok && health.data) {
        const links = Array.isArray(health.data.unhealthy_links) ? health.data.unhealthy_links : [];
        for (const link of links) {
          if (!UNHEALTHY_STATUSES.includes(link.status) || !Number.isInteger(Number(link.id))) { summary.skipped++; continue; }
          const data = { siteId: site.id, siteName: site.name, trackingLinkId: Number(link.id), name: String(link.name || "").slice(0, 120), healthStatus: link.status };
          await automations.runAutomations(env, site.organization_id, EVENT, data, `tl:${site.id}:${link.id}:${link.status}:${day}`);
          summary.events++;
        }
      }
    } catch (_) { /* one broken site never stops the sweep */ }
    await sweepRepo.markSwept(env, site.id).catch(() => {});
  }
  return summary;
}

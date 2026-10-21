// =====================================================
// CUSTOM DOMAINS BY NAMESERVER DELEGATION (v1)
//
// The flow, end to end (docs/CUSTOM_DOMAINS.md has the customer-facing version):
//
//   1. addZone        customer enters example.com in the dashboard. Lummet creates a Cloudflare zone for it in the
//                     platform account and stores the two nameservers Cloudflare assigned. Two hostnames are
//                     registered for the site: example.com and www.example.com (status awaiting_nameservers).
//   2. (customer)     sets those two nameservers at their registrar / DNS manager.
//   3. checkZone      run by the customer's "Check now" button AND by the maintenance sweep until done:
//                       - asks public DNS (DoH) whether the registrar already lists our nameservers  -> progress only
//                       - asks Cloudflare to re-check delegation (rate limited)                      -> may speed it up
//                       - reads the zone status from Cloudflare; ACTIVE is the only thing that moves the domain on
//                         (a zone cannot become active without real delegation, so this is also the ownership proof)
//   4. zone active    hostnames -> dns_verified. Each hostname's old A/AAAA/CNAME records are removed (they would
//                     block the attachment) and the hostname is attached to the site's Worker (Workers Custom
//                     Domains: Cloudflare adds the DNS record and issues the certificate).  -> ssl_pending
//   5. live           a real HTTPS request to the hostname must succeed before it is called active (never assumed).
//                     The first active hostname becomes the site's primary domain, the site is redeployed so the
//                     Worker learns its new URL, the owners are emailed and the domain.verified webhook fires.
//
// Safety rules in this file:
//   * Every status change reflects something checked (Cloudflare's zone status, a real HTTPS request).
//   * A customer can never create a zone for the platform's own domains, and can never "adopt" a zone that exists in
//     the platform account but is not one of ours (an active, unclaimed zone is refused).
//   * A claim that never completes expires (default 7 days) and the name is released, so nobody can squat on a
//     domain they do not own.
//   * Removing a delegated, still-active domain is refused until the caller acknowledges that the domain will stop
//     resolving unless the nameservers are changed back first.
//
// Written against dns-provider.js's and infra-provider.js's contracts only: production binds dns-doh.js and
// infra-cloudflare.js, tests bind fakes. No SQL in this file (worker/repositories/domain-zones.js has it).
// =====================================================

import * as dohResolver from "./dns-doh.js";
import * as cloudflareProvider from "./infra-cloudflare.js";
import * as repo from "./repositories/domain-zones.js";
import * as webhooks from "./webhooks.js";
import * as entitlements from "./entitlements.js";
import { queueEmail, portalLink } from "./email.js";
import { computeResourceNames } from "./provisioning.js";

const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?!-)[a-zA-Z0-9-]{1,63}(?<!-)(\.(?!-)[a-zA-Z0-9-]{1,63}(?<!-))+$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const HOUR = 3600 * 1000;
const MINUTE = 60 * 1000;

export const RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT"];

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
export const settings = (env) => ({
  pendingDays: num(env?.DOMAIN_NS_PENDING_DAYS, 7),
  activationCheckMinutes: num(env?.DOMAIN_ACTIVATION_CHECK_MINUTES, 60),
  reminderHours: num(env?.DOMAIN_NS_REMINDER_HOURS, 24),
  attachGiveUpHours: num(env?.DOMAIN_ATTACH_GIVE_UP_HOURS, 24),
  manualCheckSeconds: num(env?.DOMAIN_MANUAL_CHECK_SECONDS, 20)
});

// -----------------------------------------------------
// Pure helpers (exported for tests)
// -----------------------------------------------------

/** Names a customer may never claim: the platform's own domains and anything above or below them. */
export function reservedDomains(env) {
  const out = new Set(["workers.dev", "pages.dev", "localhost", "cloudflare.com"]);
  const add = (v) => { if (v) out.add(String(v).toLowerCase().replace(/^\*?\.?/, "")); };
  add(env?.PLATFORM_DOMAIN_SUFFIX || "sites.lummet.app");
  try { if (env?.PORTAL_BASE_URL) add(new URL(env.PORTAL_BASE_URL).hostname); } catch (_) { /* not a URL */ }
  return [...out];
}

/**
 * "https://WWW.Example.com/path" -> { ok: true, zoneName: "example.com" }. A leading www. is dropped because the
 * zone is the root domain; anything else with several labels is passed through and Cloudflare decides whether it
 * is a registrable root (it refuses real subdomains on non-Enterprise accounts).
 */
export function normalizeDomainInput(input, env = {}) {
  let host = String(input || "").trim().toLowerCase();
  if (!host || /\s/.test(host)) return { ok: false, error: "invalid_domain" };
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/\.$/, "");
  try { host = new URL(`http://${host}`).hostname; } catch (_) { return { ok: false, error: "invalid_domain" }; }   // also punycodes IDNs
  host = host.replace(/^www\./, "");
  if (!HOSTNAME_PATTERN.test(host) || IPV4.test(host)) return { ok: false, error: "invalid_domain" };
  const tld = host.split(".").pop();
  if (!/^([a-z]{2,63}|xn--[a-z0-9-]+)$/.test(tld)) return { ok: false, error: "invalid_domain" };
  for (const r of reservedDomains(env)) {
    if (host === r || host.endsWith(`.${r}`) || r.endsWith(`.${host}`)) return { ok: false, error: "domain_reserved" };
  }
  return { ok: true, zoneName: host };
}

export const hostnamesFor = (zoneName) => [zoneName, `www.${zoneName}`];

// ---- single subdomains (v1.1) ----

/** Second-level public suffixes whose "apex" has three labels (example.co.uk). Not a full public suffix list. */
const TWO_LEVEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "co.in", "co.za", "co.il", "co.kr", "co.id",
  "com.br", "com.mx", "com.ar", "com.co", "com.tr", "com.cn", "com.hk", "com.sg", "com.my", "com.ph", "com.tw", "com.ua", "com.pl", "com.ng", "com.eg"
]);

/** True for example.com and example.co.uk: names that are the registrable root, not a subdomain of one. */
export function isLikelyApex(host) {
  const labels = String(host).split(".");
  if (labels.length <= 2) return true;
  return labels.length === 3 && TWO_LEVEL_SUFFIXES.has(labels.slice(1).join("."));
}

/** "https://Shop.Example.com/x" -> { ok, hostname: "shop.example.com" }. Keeps www (it IS a subdomain here). */
export function normalizeSubdomainInput(input, env = {}) {
  let host = String(input || "").trim().toLowerCase();
  if (!host || /\s/.test(host)) return { ok: false, error: "invalid_domain" };
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/\.$/, "");
  try { host = new URL(`http://${host}`).hostname; } catch (_) { return { ok: false, error: "invalid_domain" }; }
  if (!HOSTNAME_PATTERN.test(host) || IPV4.test(host)) return { ok: false, error: "invalid_domain" };
  const tld = host.split(".").pop();
  if (!/^([a-z]{2,63}|xn--[a-z0-9-]+)$/.test(tld)) return { ok: false, error: "invalid_domain" };
  for (const r of reservedDomains(env)) {
    if (host === r || host.endsWith(`.${r}`) || r.endsWith(`.${host}`)) return { ok: false, error: "domain_reserved" };
  }
  if (isLikelyApex(host)) return { ok: false, error: "apex_needs_nameservers" };
  return { ok: true, hostname: host };
}

/** What a customer's CNAME must point at: a proxied record on the platform zone that is also its SaaS fallback origin. */
export function cnameTargetFor(env) {
  return String(env?.PLATFORM_CNAME_TARGET || `customers.${env?.PLATFORM_DOMAIN_SUFFIX || "sites.lummet.app"}`).toLowerCase().replace(/\.$/, "");
}

/** Same phase names as describeProgress so the page and polling treat both kinds alike. */
export function describeSubdomainProgress(domain) {
  const st = domain.status;
  const phase = st === "active" ? "live" : st === "failed" ? "failed" : st === "ssl_pending" ? "issuing_certificates" : st === "dns_verified" ? "attaching" : "awaiting_dns";
  const verified = ["dns_verified", "ssl_pending", "active"].includes(st);
  const dead = st === "failed";
  const step = (key, label, state, detail) => ({ key, label, state, detail: detail || null });
  const steps = [
    step("added", "Subdomain added", "done"),
    step("records", "Add the DNS records at your DNS provider", verified ? "done" : dead ? "failed" : "current",
      verified ? "Ownership verified." : domain.cname_seen_at ? "We can see your CNAME. Waiting for the TXT ownership record." : null),
    step("certificate", "HTTPS certificate is issued", st === "active" ? "done" : dead ? "failed" : verified ? "current" : "todo",
      verified && st !== "active" ? "Connecting your site and issuing the certificate." : null),
    step("live", "Site is live on your subdomain", st === "active" ? "done" : dead ? "failed" : "todo")
  ];
  return { phase, steps, liveCount: st === "active" ? 1 : 0, totalCount: 1 };
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const lower = (list) => (list || []).map((x) => String(x).toLowerCase().replace(/\.$/, ""));

/** True when public DNS lists every nameserver Cloudflare assigned (and no others). */
export function delegationMatches(assigned, detected) {
  const a = lower(assigned), d = lower(detected);
  return a.length > 0 && d.length > 0 && sameSet([...new Set(a)], [...new Set(d)]);
}

/** Wait before the next automatic look, by how long the zone has been waiting. */
export function nextCheckDelayMs(createdAtMs, nowMs) {
  const age = Math.max(0, nowMs - createdAtMs);
  if (age < 1 * HOUR) return 3 * MINUTE;
  if (age < 6 * HOUR) return 10 * MINUTE;
  if (age < 24 * HOUR) return 30 * MINUTE;
  if (age < 72 * HOUR) return 2 * HOUR;
  return 6 * HOUR;
}

/** 'YYYY-MM-DD HH:MM:SS' (SQLite, UTC) or ISO -> ms. */
export function parseTime(s) {
  if (!s) return NaN;
  const t = String(s);
  return Date.parse(/[TZ]/.test(t) ? t : t.replace(" ", "T") + "Z");
}

/**
 * The four steps the dashboard shows. state: done | current | todo | failed. `phase` is the one-word summary.
 */
export function describeProgress(zone, hostnames) {
  const live = hostnames.filter((h) => h.status === "active");
  const failed = hostnames.filter((h) => h.status === "failed");
  const allLive = hostnames.length > 0 && live.length === hostnames.length;
  const active = zone.status === "active";
  const dead = zone.status === "failed" || zone.status === "expired";
  const detected = !!zone.nameservers_detected_at;

  let phase;
  if (zone.status === "expired") phase = "expired";
  else if (zone.status === "failed") phase = "failed";
  else if (allLive) phase = "live";
  else if (active && hostnames.some((h) => h.status === "ssl_pending")) phase = "issuing_certificates";
  else if (active) phase = "attaching";
  else if (detected) phase = "nameservers_detected";
  else phase = "awaiting_nameservers";

  const step = (key, label, state, detail) => ({ key, label, state, detail: detail || null });
  const steps = [
    step("added", "Domain added", "done"),
    step("nameservers", "Change nameservers at your registrar", active || detected ? "done" : dead ? "failed" : "current",
      active || detected ? "Your registrar now lists the Lummet nameservers." : null),
    step("confirmed", "Cloudflare confirms the domain", active ? "done" : dead ? "failed" : detected ? "current" : "todo",
      active ? null : detected ? "Nameservers seen. Cloudflare usually confirms within minutes to a few hours." : null),
    step("live", "Site is live on your domain", allLive ? "done" : dead || (active && failed.length === hostnames.length && hostnames.length) ? "failed" : active ? "current" : "todo",
      allLive ? null : active ? "Connecting your site and issuing the HTTPS certificate." : null)
  ];
  return { phase, steps, liveCount: live.length, totalCount: hostnames.length };
}

// -----------------------------------------------------
// Record validation (customer-managed DNS records)
// -----------------------------------------------------

/** "@" / "mail" / "mail.example.com" -> fully qualified name inside the zone, or null if it points outside it. */
export function qualifyRecordName(name, zoneName) {
  const n = String(name || "").trim().toLowerCase().replace(/\.$/, "");
  if (!n || n === "@") return zoneName;
  if (n === zoneName || n.endsWith(`.${zoneName}`)) return n;
  if (n.includes(".") && /\.[a-z]{2,}$/.test(n)) return null;          // looks like a name in some other domain
  const full = `${n}.${zoneName}`;
  return HOSTNAME_PATTERN.test(full) || /^(_[a-z0-9-]+\.)+/.test(full) ? full : null;   // _dmarc, _domainkey ...
}

export function validateRecord(input, zoneName) {
  const type = String(input?.type || "").toUpperCase();
  if (!RECORD_TYPES.includes(type)) return { ok: false, error: "unsupported_record_type" };
  const name = qualifyRecordName(input.name, zoneName);
  if (!name) return { ok: false, error: "record_outside_domain" };
  let content = String(input.content ?? "").trim();
  if (!content || content.length > 2000) return { ok: false, error: "invalid_record_content" };
  const record = { type, name, content, ttl: 1, proxied: false };
  if (type === "A") {
    const parts = content.split(".").map(Number);
    if (!IPV4.test(content) || parts.some((p) => p > 255)) return { ok: false, error: "invalid_record_content" };
  } else if (type === "AAAA") {
    if (!/^[0-9a-fA-F:.]+$/.test(content) || !content.includes(":")) return { ok: false, error: "invalid_record_content" };
  } else if (type === "CNAME" || type === "MX") {
    content = content.toLowerCase().replace(/\.$/, "");
    if (!HOSTNAME_PATTERN.test(content)) return { ok: false, error: "invalid_record_content" };
    record.content = content;
    if (type === "CNAME" && name === zoneName) return { ok: false, error: "cname_at_root_not_allowed" };
  }
  if (type === "MX") {
    const p = Number(input.priority);
    if (!Number.isInteger(p) || p < 0 || p > 65535) return { ok: false, error: "invalid_record_priority" };
    record.priority = p;
  }
  return { ok: true, record };
}

function mapProviderError(err) {
  const m = String(err?.message || "");
  if (/root domain|subdomain/i.test(m)) return { status: 422, error: "not_a_root_domain" };
  if (/already exists|another account|not available|taken|registered/i.test(m)) return { status: 409, error: "domain_unavailable" };
  if (/invalid|not a valid|malformed/i.test(m)) return { status: 422, error: "invalid_domain" };
  return { status: 502, error: "provider_error" };
}

// -----------------------------------------------------
// The service
// -----------------------------------------------------

export function createZoneDomainService({ dns, infra }) {
  async function notifyOwners(env, site, { subject, message, dedupeKey }) {
    if (!site) return;
    try {
      for (const email of await repo.ownerEmails(env, site.organization_id)) {
        await queueEmail(env, {
          to: email, template: "notification", organizationId: site.organization_id, dedupeKey: `${dedupeKey}:${email}`,
          vars: { subject, message, link: portalLink(env, "/app/domains") }
        });
      }
    } catch (_) { /* a notification problem must never stop the domain flow */ }
  }

  async function view(env, zoneId, { events = true } = {}) {
    const zone = await repo.getZone(env, zoneId);
    if (!zone) return null;
    const hostnames = await repo.listHostnames(env, zoneId);
    return {
      zone, hostnames, progress: describeProgress(zone, hostnames),
      events: events ? await repo.listEvents(env, zoneId, 20) : []
    };
  }

  async function fail(env, zone, reason, kind = "failed") {
    await repo.updateZone(env, zone.id, { status: "failed", failure_reason: reason, next_check_at: null });
    await repo.addEvent(env, zone.id, kind, reason);
    for (const h of await repo.listHostnames(env, zone.id)) {
      if (h.status === "active") continue;
      await repo.updateHostname(env, h.id, { status: "failed", failure_reason: reason });
      await repo.addHostnameEvent(env, { domainId: h.id, fromStatus: h.status, toStatus: "failed", reason });
    }
  }

  /** Releases a claim that never completed: the name becomes free for its real owner. */
  async function expire(env, zone, site) {
    if (zone.provider_zone_id) { try { await infra.deleteZone(env, zone.provider_zone_id); } catch (_) { /* already gone, or retried by staff */ } }
    for (const h of await repo.listHostnames(env, zone.id)) {
      await repo.updateHostname(env, h.id, { status: "removed", removed_at: new Date().toISOString(), is_primary: 0, failure_reason: "nameservers_not_changed_in_time" });
      await repo.addHostnameEvent(env, { domainId: h.id, fromStatus: h.status, toStatus: "removed", reason: "nameservers not changed in time" });
    }
    await repo.updateZone(env, zone.id, { status: "expired", failure_reason: "nameservers_not_changed_in_time", next_check_at: null });
    await repo.addEvent(env, zone.id, "expired", "The nameservers were not changed in time; the claim was released.");
    await notifyOwners(env, site, {
      subject: `Your domain ${zone.zone_name} was not connected`,
      message: `We did not see the nameserver change for ${zone.zone_name}, so the request was cancelled and nothing was changed on your domain. You can start again any time from the Domains page.`,
      dedupeKey: `domain-expired:${zone.id}`
    });
  }

  // ---------------------------------------------------- add

  async function addZone(env, { siteId, domain, actorUserId = null, organizationId = null, now = Date.now() }) {
    const norm = normalizeDomainInput(domain, env);
    if (!norm.ok) return { ok: false, status: 422, error: norm.error };
    const { zoneName } = norm;

    const site = await repo.getSite(env, siteId);
    if (!site || (organizationId && site.organization_id !== organizationId)) return { ok: false, status: 404, error: "not_found" };
    if (!["provisioned", "active"].includes(site.status)) return { ok: false, status: 409, error: "site_not_ready" };

    const ent = await entitlements.resolveForOrganization(env, site.organization_id);
    const limit = ent?.["domains.custom.max"]?.value;
    if (typeof limit === "number" && (await repo.countCustomDomains(env, site.organization_id)) >= limit) {
      return { ok: false, status: 403, error: "domain_limit_reached", limit };
    }

    if (await repo.findLiveByName(env, zoneName)) return { ok: false, status: 409, error: "domain_already_connected" };
    const hostnames = hostnamesFor(zoneName);
    for (const h of hostnames) if (await repo.hostnameInUse(env, h)) return { ok: false, status: 409, error: "hostname_already_in_use" };

    let created;
    try { created = await infra.createZone(env, { name: zoneName }); }
    catch (err) { const m = mapProviderError(err); return { ok: false, status: m.status, error: m.error }; }

    // Never adopt a zone that is not ours to hand out: the platform zone itself, one already claimed, or an
    // active zone nobody here claimed (it exists in the platform account for some other reason).
    if ((env.CF_ZONE_ID && created.zoneId === env.CF_ZONE_ID) || (await repo.findByProviderZoneId(env, created.zoneId)) || created.status === "active") {
      return { ok: false, status: 409, error: "domain_unavailable" };
    }
    if (!created.nameServers.length) {
      try { await infra.deleteZone(env, created.zoneId); } catch (_) { /* best effort */ }
      return { ok: false, status: 502, error: "provider_error" };
    }

    const zoneId = crypto.randomUUID();
    const s = settings(env);
    try {
      await repo.insertZone(env, {
        id: zoneId, siteId, zoneName, providerZoneId: created.zoneId, nameServers: created.nameServers,
        expiresAt: new Date(now + s.pendingDays * 24 * HOUR).toISOString(), createdBy: actorUserId,
        nextCheckAt: new Date(now + 3 * MINUTE).toISOString()
      });
      for (const hostname of hostnames) {
        const id = crypto.randomUUID();
        await repo.insertZoneHostname(env, { id, siteId, hostname, zoneId, token: id.replace(/-/g, "") });
        await repo.addHostnameEvent(env, { domainId: id, fromStatus: null, toStatus: "awaiting_nameservers", reason: "domain added by nameserver delegation", actorType: "customer_user", actorId: actorUserId });
      }
    } catch (err) {
      try { await infra.deleteZone(env, created.zoneId); } catch (_) { /* best effort; staff can see it in Cloudflare */ }
      if (/UNIQUE/i.test(String(err?.message))) return { ok: false, status: 409, error: "domain_already_connected" };
      throw err;
    }
    await repo.addEvent(env, zoneId, "created", `nameservers: ${created.nameServers.join(", ")}`, { actorType: "customer_user", actorId: actorUserId });
    // Ask Cloudflare to look for the domain's existing records so the customer can review them BEFORE switching.
    try { await infra.triggerDnsScan(env, created.zoneId); } catch (_) { /* optional */ }

    return { ok: true, zoneId, ...(await view(env, zoneId)) };
  }

  // ---------------------------------------------------- check / advance

  async function attachHostnames(env, zone, site, { redeploy, now }) {
    const names = computeResourceNames(site, env);
    let attachedAny = false;
    for (const h of await repo.listHostnames(env, zone.id)) {
      if (h.status !== "dns_verified") continue;
      try {
        // Records for the OLD website at this exact name would make Cloudflare refuse the attachment.
        const existing = await infra.listDnsRecords(env, zone.provider_zone_id);
        for (const r of existing.filter((x) => x.name === h.hostname && ["A", "AAAA", "CNAME"].includes(x.type))) {
          await infra.deleteDnsRecord(env, zone.provider_zone_id, r.id);
          await repo.addEvent(env, zone.id, "record_removed", `${r.type} ${r.name} (replaced by your Lummet site)`);
        }
        const attached = await infra.attachWorkerDomain(env, { hostname: h.hostname, workerName: names.workerName, zoneId: zone.provider_zone_id, zoneName: zone.zone_name });
        await repo.updateHostname(env, h.id, { status: "ssl_pending", ssl_status: "pending", custom_domain_id: attached.customDomainId, failure_reason: null });
        await repo.addHostnameEvent(env, { domainId: h.id, fromStatus: "dns_verified", toStatus: "ssl_pending", reason: "attached to the site" });
        await repo.addEvent(env, zone.id, "attached", h.hostname);
        attachedAny = true;
      } catch (err) {
        const reason = `attach_failed: ${String(err?.message || err).slice(0, 140)}`;
        await repo.updateHostname(env, h.id, { failure_reason: reason });
        const activatedAt = parseTime(zone.activated_at);
        if (Number.isFinite(activatedAt) && now - activatedAt > settings(env).attachGiveUpHours * HOUR) {
          await repo.updateHostname(env, h.id, { status: "failed" });
          await repo.addHostnameEvent(env, { domainId: h.id, fromStatus: "dns_verified", toStatus: "failed", reason });
        }
      }
    }
    return attachedAny;
  }

  async function verifyLive(env, zone, site, { redeploy, now }) {
    let becameLive = false;
    for (const h of await repo.listHostnames(env, zone.id)) {
      if (h.status !== "ssl_pending") continue;
      // The only proof that counts: a real HTTPS request to the hostname succeeds (certificate + routing + site).
      const result = await infra.checkHealth(env, { url: `https://${h.hostname}/` });
      if (result.ok) {
        await repo.updateHostname(env, h.id, { status: "active", ssl_status: "active", ssl_verified_at: new Date(now).toISOString(), failure_reason: null });
        await repo.addHostnameEvent(env, { domainId: h.id, fromStatus: "ssl_pending", toStatus: "active", reason: "HTTPS check passed" });
        await repo.addEvent(env, zone.id, "live", h.hostname);
        becameLive = true;
        try { await webhooks.dispatchEvent(env, site.organization_id, "domain.verified", { domainId: h.id, hostname: h.hostname, siteId: site.id }); } catch (_) { /* webhook retries own their failures */ }
      } else {
        const activatedAt = parseTime(zone.activated_at);
        if (Number.isFinite(activatedAt) && now - activatedAt > settings(env).attachGiveUpHours * HOUR) {
          await repo.updateHostname(env, h.id, { status: "failed", ssl_status: "failed", failure_reason: "certificate_or_routing_not_ready" });
          await repo.addHostnameEvent(env, { domainId: h.id, fromStatus: "ssl_pending", toStatus: "failed", reason: "HTTPS check kept failing for 24 hours" });
        }
      }
    }
    if (becameLive) await goLive(env, zone, site, { redeploy });
    return becameLive;
  }

  /** First live hostname becomes the site's primary domain; the site is redeployed so its Worker learns the URL. */
  async function goLive(env, zone, site, { redeploy }) {
    const hosts = await repo.listHostnames(env, zone.id);
    const live = hosts.filter((h) => h.status === "active");
    if (!live.length) return;
    let primaryChanged = false;
    if (!(await repo.hasPrimaryCustomDomain(env, site.id))) {
      const pick = live.find((h) => h.hostname === zone.zone_name) || live[0];
      await repo.setSitePrimaryDomain(env, site.id, pick.hostname);
      primaryChanged = true;
    }
    if (primaryChanged && typeof redeploy === "function") {
      try { await redeploy(site.id); } catch (_) { /* the domain is live either way; the next deploy picks the URL up */ }
    }
    if (live.length === hosts.length) {
      await notifyOwners(env, site, {
        subject: `${zone.zone_name} is live`,
        message: `Your site is now live on ${live.map((h) => h.hostname).join(" and ")}.`,
        dedupeKey: `domain-live:${zone.id}`
      });
    }
  }

  /**
   * Looks at one zone and moves it forward as far as the facts allow. Safe to call any time, by anyone, repeatedly.
   * `manual` = a customer clicked "Check now" (throttled, and allowed to ask Cloudflare for an immediate re-check).
   */
  async function checkZone(env, zoneId, { manual = false, redeploy, now = Date.now(), organizationId = null } = {}) {
    let zone = await repo.getZone(env, zoneId);
    if (!zone || zone.status === "removed") return { ok: false, status: 404, error: "not_found" };
    const site = await repo.getSite(env, zone.site_id);
    if (!site || (organizationId && site.organization_id !== organizationId)) return { ok: false, status: 404, error: "not_found" };
    if (zone.status === "failed" || zone.status === "expired") return { ok: true, throttled: false, ...(await view(env, zoneId)) };

    const s = settings(env);
    const last = parseTime(zone.last_checked_at);
    if (manual && Number.isFinite(last) && now - last < s.manualCheckSeconds * 1000) {
      return { ok: true, throttled: true, ...(await view(env, zoneId)) };
    }

    const createdMs = parseTime(zone.created_at) || now;
    const patch = { last_checked_at: new Date(now).toISOString(), check_count: zone.check_count + 1 };
    let providerError = null;

    // ---- 1. what does Cloudflare say about the zone?
    let cf = null;
    try { cf = await infra.getZone(env, zone.provider_zone_id); } catch (err) { providerError = String(err?.message || err).slice(0, 140); }

    if (cf && cf.status === "gone") {
      await fail(env, zone, "zone_removed_at_provider");
      await notifyOwners(env, site, { subject: `Connecting ${zone.zone_name} stopped`, message: `The domain setup for ${zone.zone_name} was removed on the DNS provider's side. Please add the domain again from the Domains page.`, dedupeKey: `domain-gone:${zone.id}` });
      return { ok: true, ...(await view(env, zoneId)) };
    }
    if (cf && cf.nameServers.length && !sameSet(lower(cf.nameServers), lower(zone.name_servers))) {
      patch.name_servers = cf.nameServers;                                // the assignment changed; show the current one
      zone = { ...zone, name_servers: cf.nameServers };
    }

    // ---- 2. still waiting for delegation
    if (zone.status === "pending") {
      const seen = await dns.lookupNS(zone.zone_name);
      if (seen.ok) {
        patch.detected_name_servers = seen.nameServers;
        const matches = delegationMatches(zone.name_servers, seen.nameServers);
        if (matches && !zone.nameservers_detected_at) {
          patch.nameservers_detected_at = new Date(now).toISOString();
          await repo.addEvent(env, zone.id, "nameservers_detected", seen.nameServers.join(", "));
        } else if (!matches && zone.nameservers_detected_at) {
          patch.nameservers_detected_at = null;
          await repo.addEvent(env, zone.id, "nameservers_changed_away", seen.nameServers.join(", "));
        }
        // Ask Cloudflare to re-check as soon as the registrar shows our nameservers (rate limited on their side).
        const lastAsk = parseTime(zone.last_activation_check_at);
        const dueAsk = !Number.isFinite(lastAsk) || now - lastAsk >= s.activationCheckMinutes * MINUTE;
        if ((matches || manual) && dueAsk && cf && cf.status === "pending") {
          try { await infra.requestActivationCheck(env, zone.provider_zone_id); patch.last_activation_check_at = new Date(now).toISOString(); }
          catch (_) { patch.last_activation_check_at = new Date(now).toISOString(); /* rate limited: Cloudflare re-checks on its own */ }
        }
      }

      if (cf && cf.status === "active") {
        patch.status = "active";
        patch.activated_at = new Date(now).toISOString();
        patch.failure_reason = null;
        patch.next_check_at = new Date(now + 1 * MINUTE).toISOString();
        await repo.updateZone(env, zone.id, patch);
        await repo.addEvent(env, zone.id, "activated", "Cloudflare confirmed the nameservers.");
        for (const h of await repo.listHostnames(env, zone.id)) {
          if (h.status !== "awaiting_nameservers") continue;
          await repo.updateHostname(env, h.id, { status: "dns_verified", dns_verified_at: new Date(now).toISOString() });
          await repo.addHostnameEvent(env, { domainId: h.id, fromStatus: "awaiting_nameservers", toStatus: "dns_verified", reason: "nameservers confirmed by Cloudflare" });
        }
        zone = await repo.getZone(env, zone.id);
        await notifyOwners(env, site, { subject: `Nameservers confirmed for ${zone.zone_name}`, message: `Cloudflare confirmed the nameserver change for ${zone.zone_name}. We are connecting your site now; this usually takes a few minutes.`, dedupeKey: `domain-active:${zone.id}` });
      } else {
        // reminders and expiry
        const expiresMs = parseTime(zone.expires_at);
        if (Number.isFinite(expiresMs) && now >= expiresMs) {
          await repo.updateZone(env, zone.id, patch);
          await expire(env, zone, site);
          return { ok: true, ...(await view(env, zoneId)) };
        }
        if (!zone.nameservers_detected_at && !patch.nameservers_detected_at && !zone.reminder_sent_at && now - createdMs >= s.reminderHours * HOUR) {
          patch.reminder_sent_at = new Date(now).toISOString();
          await repo.addEvent(env, zone.id, "reminder", "reminder email sent");
          await notifyOwners(env, site, {
            subject: `Finish connecting ${zone.zone_name}`,
            message: `To connect ${zone.zone_name}, set these two nameservers at your registrar or DNS provider: ${zone.name_servers.join(" and ")}. Until you do, your site stays on its Lummet address. The request is cancelled automatically after ${s.pendingDays} days.`,
            dedupeKey: `domain-reminder:${zone.id}`
          });
        }
        patch.next_check_at = new Date(now + nextCheckDelayMs(createdMs, now)).toISOString();
        if (providerError) patch.failure_reason = null;
        await repo.updateZone(env, zone.id, patch);
        return { ok: true, ...(providerError ? { providerError: true } : {}), ...(await view(env, zoneId)) };
      }
    } else {
      await repo.updateZone(env, zone.id, patch);
      zone = await repo.getZone(env, zone.id);
    }

    // ---- 3. zone is active: connect hostnames and prove they serve
    if (zone.status === "active") {
      await attachHostnames(env, zone, site, { redeploy, now });
      await verifyLive(env, zone, site, { redeploy, now });
      const hosts = await repo.listHostnames(env, zone.id);
      const open = hosts.some((h) => ["dns_verified", "ssl_pending"].includes(h.status));
      if (!open && hosts.length && hosts.every((h) => h.status === "active")) {
        await repo.updateZone(env, zone.id, { next_check_at: null });
      } else if (!open && hosts.length && hosts.every((h) => h.status === "failed")) {
        await fail(env, zone, "could_not_connect_hostnames");
      } else {
        await repo.updateZone(env, zone.id, { next_check_at: new Date(now + 2 * MINUTE).toISOString() });
      }
    }
    return { ok: true, ...(await view(env, zoneId)) };
  }

  /** Maintenance tick: advance every due zone (bounded, so one tick stays well inside a Worker's budget). */
  async function sweep(env, { now = Date.now(), limit = 10, redeploy } = {}) {
    const due = await repo.listDueForSweep(env, { nowIso: new Date(now).toISOString(), limit });
    const results = [];
    for (const zone of due) {
      try {
        const r = await checkZone(env, zone.id, { now, redeploy });
        results.push({ zoneId: zone.id, phase: r.progress?.phase || null });
      } catch (err) {
        // One broken zone must never stop the others; try again on the next tick.
        await repo.updateZone(env, zone.id, { next_check_at: new Date(now + 10 * MINUTE).toISOString() }).catch(() => {});
        results.push({ zoneId: zone.id, error: "unexpected_exception" });
      }
    }
    for (const d of await repo.listDueCname(env, { nowIso: new Date(now).toISOString(), limit })) {
      try {
        const r = await checkSubdomain(env, d.id, { now, redeploy });
        results.push({ domainId: d.id, phase: r.progress?.phase || null });
      } catch (err) {
        await repo.updateHostname(env, d.id, { next_check_at: new Date(now + 10 * MINUTE).toISOString() }).catch(() => {});
        results.push({ domainId: d.id, error: "unexpected_exception" });
      }
    }
    return { checked: results.length, results };
  }

  // ---------------------------------------------------- single subdomains (v1.1)

  async function subdomainView(env, domainId, { events = true } = {}) {
    const domain = await repo.getDomain(env, domainId);
    if (!domain) return null;
    return {
      domain, instructions: domain.dns_instructions, progress: describeSubdomainProgress(domain),
      events: events ? await repo.listDomainEvents(env, domainId, 20) : []
    };
  }

  async function failDomain(env, d, site, reason) {
    await repo.updateHostname(env, d.id, { status: "failed", ssl_status: "failed", failure_reason: reason, next_check_at: null });
    await repo.addHostnameEvent(env, { domainId: d.id, fromStatus: d.status, toStatus: "failed", reason });
    await notifyOwners(env, site, {
      subject: `Connecting ${d.hostname} stopped`,
      message: `We could not finish connecting ${d.hostname} (${reason.replace(/_/g, " ")}). Check that the DNS records on the Domains page are in place, then remove it and add it again.`,
      dedupeKey: `domain-failed:${d.id}`
    });
  }

  /** A subdomain that never got its records is released, so nobody can squat on a name they do not control. */
  async function expireDomain(env, d, site) {
    await repo.updateHostname(env, d.id, { status: "removed", removed_at: new Date().toISOString(), is_primary: 0, failure_reason: "dns_records_not_added_in_time", next_check_at: null });
    await repo.addHostnameEvent(env, { domainId: d.id, fromStatus: d.status, toStatus: "removed", reason: "DNS records not added in time" });
    await notifyOwners(env, site, {
      subject: `Your subdomain ${d.hostname} was not connected`,
      message: `We did not see the DNS records for ${d.hostname}, so the request was cancelled and nothing was changed. You can start again any time from the Domains page.`,
      dedupeKey: `domain-expired:${d.id}`
    });
  }

  /** The first live address becomes the site's primary domain; the site is redeployed so its Worker learns the URL. */
  async function goLiveHost(env, site, d, { redeploy }) {
    try { await webhooks.dispatchEvent(env, site.organization_id, "domain.verified", { domainId: d.id, hostname: d.hostname, siteId: site.id }); } catch (_) { /* retried by the webhook sweep */ }
    if (!(await repo.hasPrimaryCustomDomain(env, site.id))) {
      await repo.setSitePrimaryDomain(env, site.id, d.hostname);
      if (typeof redeploy === "function") { try { await redeploy(site.id); } catch (_) { /* the domain is live either way */ } }
    }
    await notifyOwners(env, site, { subject: `${d.hostname} is live`, message: `Your site is now live on ${d.hostname}.`, dedupeKey: `domain-live:${d.id}` });
  }

  /**
   * Connects ONE subdomain. Two ways, chosen for the customer:
   *   - its parent domain is already delegated to Lummet for this same site -> it becomes another hostname of that
   *     zone (mode "zone"; the zone's own flow attaches it, and there are no extra DNS steps);
   *   - otherwise the customer keeps their DNS and adds a CNAME + TXT record (mode "cname"; works with any DNS
   *     provider, including the customer's own Cloudflare account).
   */
  async function addSubdomain(env, { siteId, hostname, actorUserId = null, organizationId = null, redeploy, now = Date.now() }) {
    const norm = normalizeSubdomainInput(hostname, env);
    if (!norm.ok) return { ok: false, status: 422, error: norm.error };
    const host = norm.hostname;

    const site = await repo.getSite(env, siteId);
    if (!site || (organizationId && site.organization_id !== organizationId)) return { ok: false, status: 404, error: "not_found" };
    if (!["provisioned", "active"].includes(site.status)) return { ok: false, status: 409, error: "site_not_ready" };
    if (await repo.hostnameInUse(env, host)) return { ok: false, status: 409, error: "hostname_already_in_use" };

    // ---- A. the parent domain is already delegated to Lummet
    const parent = await repo.findZoneContaining(env, host);
    if (parent) {
      const parentSite = await repo.getSite(env, parent.site_id);
      if (!parentSite || parentSite.organization_id !== site.organization_id) return { ok: false, status: 409, error: "domain_belongs_to_another_account" };
      if (parent.site_id !== siteId) return { ok: false, status: 409, error: "zone_belongs_to_another_site" };
      const id = crypto.randomUUID();
      const status = parent.status === "active" ? "dns_verified" : "awaiting_nameservers";
      try { await repo.insertZoneHostname(env, { id, siteId, hostname: host, zoneId: parent.id, token: id.replace(/-/g, ""), status }); }
      catch (err) { if (/UNIQUE/i.test(String(err?.message))) return { ok: false, status: 409, error: "hostname_already_in_use" }; throw err; }
      await repo.addHostnameEvent(env, { domainId: id, fromStatus: null, toStatus: status, reason: `added to ${parent.zone_name}`, actorType: "customer_user", actorId: actorUserId });
      await repo.addEvent(env, parent.id, "hostname_added", host, { actorType: "customer_user", actorId: actorUserId });
      if (parent.status === "active") await checkZone(env, parent.id, { redeploy, now });
      return { ok: true, mode: "zone", domainId: id, zoneId: parent.id, ...(await view(env, parent.id)) };
    }

    // ---- B. the customer keeps their DNS: CNAME + TXT
    if (String(env.SUBDOMAIN_CNAME_FLOW || "").toLowerCase() === "off") return { ok: false, status: 503, error: "subdomain_flow_disabled" };
    const ent = await entitlements.resolveForOrganization(env, site.organization_id);
    const limit = ent?.["domains.custom.max"]?.value;
    if (typeof limit === "number" && (await repo.countCustomDomains(env, site.organization_id)) >= limit) {
      return { ok: false, status: 403, error: "domain_limit_reached", limit };
    }
    // Refuse up front, with a clear reason, when custom hostnames cannot be served yet (operator setup missing).
    let fallback = null;
    try { fallback = await infra.getFallbackOrigin(env); } catch (_) { /* treated as not configured */ }
    if (!fallback || fallback.status !== "active") return { ok: false, status: 503, error: "custom_hostnames_not_configured" };

    const id = crypto.randomUUID();
    const token = crypto.randomUUID().replace(/-/g, "");
    const target = cnameTargetFor(env);
    const instructions = [
      { type: "CNAME", name: host, value: target, note: "Points the subdomain at Lummet. If your DNS is on Cloudflare, set it to DNS only (grey cloud)." },
      { type: "TXT", name: `_lummet-verify.${host}`, value: `lummet-site-verification=${token}`, note: "Proves you control this domain." }
    ];
    const s = settings(env);
    try {
      await repo.insertCnameHostname(env, {
        id, siteId, hostname: host, token, instructions,
        expiresAt: new Date(now + s.pendingDays * 24 * HOUR).toISOString(), nextCheckAt: new Date(now + 3 * MINUTE).toISOString()
      });
    } catch (err) { if (/UNIQUE/i.test(String(err?.message))) return { ok: false, status: 409, error: "hostname_already_in_use" }; throw err; }
    await repo.addHostnameEvent(env, { domainId: id, fromStatus: null, toStatus: "pending", reason: "subdomain added (CNAME + TXT)", actorType: "customer_user", actorId: actorUserId });
    return { ok: true, mode: "cname", domainId: id, ...(await subdomainView(env, id)) };
  }

  /** Moves a CNAME-method subdomain forward as far as the facts allow. Safe to call any time, repeatedly. */
  async function checkSubdomain(env, domainId, { manual = false, redeploy, now = Date.now(), organizationId = null } = {}) {
    let d = await repo.getDomain(env, domainId);
    if (!d || d.method !== "cname" || d.status === "removed") return { ok: false, status: 404, error: "not_found" };
    const site = await repo.getSite(env, d.site_id);
    if (!site || (organizationId && site.organization_id !== organizationId)) return { ok: false, status: 404, error: "not_found" };
    if (d.status === "failed" || d.status === "active") return { ok: true, ...(await subdomainView(env, domainId)) };

    const s = settings(env);
    const last = parseTime(d.last_checked_at);
    if (manual && Number.isFinite(last) && now - last < s.manualCheckSeconds * 1000) return { ok: true, throttled: true, ...(await subdomainView(env, domainId)) };

    const createdMs = parseTime(d.created_at) || now;
    const patch = { last_checked_at: new Date(now).toISOString(), check_count: (d.check_count || 0) + 1 };
    const target = (d.dns_instructions.find((i) => i.type === "CNAME") || {}).value;

    // ---- 1. waiting for the customer's DNS records
    if (d.status === "pending") {
      const txt = await dns.lookupTXT(`_lummet-verify.${d.hostname}`);
      if (txt.includes(`lummet-site-verification=${d.verification_token}`)) {
        await repo.updateHostname(env, d.id, { ...patch, status: "dns_verified", dns_verified_at: new Date(now).toISOString(), next_check_at: new Date(now + 30 * 1000).toISOString() });
        await repo.addHostnameEvent(env, { domainId: d.id, fromStatus: "pending", toStatus: "dns_verified", reason: "TXT record matched" });
        d = await repo.getDomain(env, d.id);
      } else {
        const c = await dns.lookupCNAME(d.hostname);
        if (c.ok) {
          const seen = !!target && c.targets.includes(String(target).toLowerCase());
          if (seen && !d.cname_seen_at) patch.cname_seen_at = new Date(now).toISOString();
          else if (!seen && d.cname_seen_at) patch.cname_seen_at = null;
        }
        const expiresMs = parseTime(d.expires_at);
        if (Number.isFinite(expiresMs) && now >= expiresMs) { await repo.updateHostname(env, d.id, patch); await expireDomain(env, d, site); return { ok: true, ...(await subdomainView(env, domainId)) }; }
        if (!d.reminder_sent_at && now - createdMs >= s.reminderHours * HOUR) {
          patch.reminder_sent_at = new Date(now).toISOString();
          await notifyOwners(env, site, {
            subject: `Finish connecting ${d.hostname}`,
            message: `To connect ${d.hostname}, add the CNAME and TXT records shown on the Domains page at your DNS provider. The request is cancelled automatically after ${s.pendingDays} days.`,
            dedupeKey: `domain-reminder:${d.id}`
          });
        }
        patch.next_check_at = new Date(now + nextCheckDelayMs(createdMs, now)).toISOString();
        await repo.updateHostname(env, d.id, patch);
        return { ok: true, ...(await subdomainView(env, domainId)) };
      }
    }

    // ---- 2. ownership proven: register the hostname and route it to the site's Worker
    if (d.status === "dns_verified") {
      const verifiedMs = parseTime(d.dns_verified_at) || now;
      try {
        let resourceId = d.ssl_resource_id;
        let extra = [];
        if (!resourceId) {
          const created = await infra.createCustomHostname(env, { hostname: d.hostname });
          resourceId = created.resourceId; extra = created.records || [];
          await repo.updateHostname(env, d.id, { ssl_resource_id: resourceId });   // remembered at once so a retry never registers it twice
        }
        let routeId = d.route_id;
        if (!routeId) {
          const route = await infra.ensureWorkerRoute(env, { pattern: `${d.hostname}/*`, workerName: computeResourceNames(site, env).workerName });
          routeId = route.routeId;
        }
        const merged = [...d.dns_instructions, ...extra.filter((r) => !d.dns_instructions.some((i) => i.type === r.type && i.name === r.name && i.value === r.value))];
        await repo.updateHostname(env, d.id, { ...patch, status: "ssl_pending", ssl_status: "pending", route_id: routeId, dns_instructions: JSON.stringify(merged), failure_reason: null, next_check_at: new Date(now + 2 * MINUTE).toISOString() });
        await repo.addHostnameEvent(env, { domainId: d.id, fromStatus: "dns_verified", toStatus: "ssl_pending", reason: "registered and routed to the site" });
        return { ok: true, ...(await subdomainView(env, domainId)) };
      } catch (err) {
        const reason = `attach_failed: ${String(err?.message || err).slice(0, 140)}`;
        if (now - verifiedMs > s.attachGiveUpHours * HOUR) { await repo.updateHostname(env, d.id, patch); await failDomain(env, d, site, "could_not_connect"); }
        else await repo.updateHostname(env, d.id, { ...patch, failure_reason: reason, next_check_at: new Date(now + 5 * MINUTE).toISOString() });
        return { ok: true, ...(await subdomainView(env, domainId)) };
      }
    }

    // ---- 3. certificate issuing: active only after a real HTTPS request works
    if (d.status === "ssl_pending") {
      const verifiedMs = parseTime(d.dns_verified_at) || now;
      let detail = null;
      try { detail = await infra.getCustomHostnameDetail(env, d.ssl_resource_id); } catch (_) { /* transient: look again next time */ }
      if (detail && detail.status === "failed") { await repo.updateHostname(env, d.id, patch); await failDomain(env, d, site, "certificate_validation_failed"); return { ok: true, ...(await subdomainView(env, domainId)) }; }
      if (detail) {
        const fresh = (detail.records || []).filter((r) => !d.dns_instructions.some((i) => i.type === r.type && i.name === r.name && i.value === r.value));
        if (fresh.length) patch.dns_instructions = JSON.stringify([...d.dns_instructions, ...fresh]);
      }
      if (detail && detail.status === "active") {
        const probe = await infra.checkHealth(env, { url: `https://${d.hostname}/` });
        if (probe.ok) {
          await repo.updateHostname(env, d.id, { ...patch, status: "active", ssl_status: "active", ssl_verified_at: new Date(now).toISOString(), failure_reason: null, next_check_at: null });
          await repo.addHostnameEvent(env, { domainId: d.id, fromStatus: "ssl_pending", toStatus: "active", reason: "HTTPS check passed" });
          await goLiveHost(env, site, d, { redeploy });
          return { ok: true, ...(await subdomainView(env, domainId)) };
        }
      }
      if (now - verifiedMs > s.attachGiveUpHours * HOUR) { await repo.updateHostname(env, d.id, patch); await failDomain(env, d, site, "certificate_or_routing_not_ready"); return { ok: true, ...(await subdomainView(env, domainId)) }; }
      patch.next_check_at = new Date(now + (now - verifiedMs < 2 * HOUR ? 2 * MINUTE : nextCheckDelayMs(createdMs, now))).toISOString();
      await repo.updateHostname(env, d.id, patch);
    }
    return { ok: true, ...(await subdomainView(env, domainId)) };
  }

  /** Disconnects a CNAME-method subdomain: route and custom hostname go first, the row second. */
  async function removeSubdomain(env, d, { actorUserId = null } = {}) {
    const gone = /not found|does not exist/i;
    if (d.route_id) { try { await infra.deleteWorkerRoute(env, d.route_id); } catch (err) { if (!gone.test(String(err?.message))) return { ok: false, status: 502, error: "provider_error" }; } }
    if (d.ssl_resource_id) { try { await infra.deleteCustomHostname(env, d.ssl_resource_id); } catch (err) { if (!gone.test(String(err?.message))) return { ok: false, status: 502, error: "provider_error" }; } }
    await repo.updateHostname(env, d.id, { status: "removed", removed_at: new Date().toISOString(), is_primary: 0, route_id: null, ssl_resource_id: null, next_check_at: null });
    await repo.addHostnameEvent(env, { domainId: d.id, fromStatus: d.status, toStatus: "removed", actorType: "customer_user", actorId: actorUserId });
    const site = await repo.getSite(env, d.site_id);
    if (site && site.primary_domain === d.hostname) await repo.setSitePrimaryDomain(env, site.id, computeResourceNames(site, env).host);
    return { ok: true };
  }

  /** One entry point for "remove this address", whichever way it was connected. */
  async function removeAnyHostname(env, d, opts = {}) {
    if (d.method === "cname") return removeSubdomain(env, d, opts);
    return removeHostname(env, d, opts);
  }

  async function listSubdomainsForSite(env, siteId) {
    const out = [];
    for (const d of await repo.listCnameForSite(env, siteId)) out.push(await subdomainView(env, d.id, { events: false }));
    return out;
  }

  // ---------------------------------------------------- customer DNS records (so email and the rest keep working)

  async function recordsContext(env, zoneId, organizationId) {
    const zone = await repo.getZone(env, zoneId);
    if (!zone || ["removed", "expired"].includes(zone.status) || !zone.provider_zone_id) return { error: { ok: false, status: 404, error: "not_found" } };
    const site = await repo.getSite(env, zone.site_id);
    if (!site || (organizationId && site.organization_id !== organizationId)) return { error: { ok: false, status: 404, error: "not_found" } };
    return { zone, site };
  }

  async function listRecords(env, zoneId, { organizationId = null } = {}) {
    const ctx = await recordsContext(env, zoneId, organizationId);
    if (ctx.error) return ctx.error;
    try {
      const records = await infra.listDnsRecords(env, ctx.zone.provider_zone_id);
      let scanned = [];
      if (ctx.zone.status === "pending") { try { scanned = await infra.listScannedRecords(env, ctx.zone.provider_zone_id); } catch (_) { /* optional */ } }
      const managed = new Set((await repo.listHostnames(env, zoneId)).map((h) => h.hostname));
      return { ok: true, records: records.map((r) => ({ ...r, managed: managed.has(r.name) && ["A", "AAAA", "CNAME"].includes(r.type) })), scanned };
    } catch (_) { return { ok: false, status: 502, error: "provider_error" }; }
  }

  async function importScanned(env, zoneId, { organizationId = null, actorUserId = null } = {}) {
    const ctx = await recordsContext(env, zoneId, organizationId);
    if (ctx.error) return ctx.error;
    try {
      const managed = new Set((await repo.listHostnames(env, zoneId)).map((h) => h.hostname));
      const scanned = await infra.listScannedRecords(env, ctx.zone.provider_zone_id);
      // The website records at the hostnames Lummet will serve are deliberately NOT imported: they point at the old host.
      const ids = scanned.filter((r) => !(managed.has(r.name) && ["A", "AAAA", "CNAME"].includes(r.type))).map((r) => r.id);
      const r = await infra.acceptScannedRecords(env, ctx.zone.provider_zone_id, ids);
      await repo.addEvent(env, zoneId, "record_added", `imported ${r.accepted} found record(s)`, { actorType: "customer_user", actorId: actorUserId });
      return { ok: true, imported: r.accepted };
    } catch (_) { return { ok: false, status: 502, error: "provider_error" }; }
  }

  async function addRecord(env, zoneId, input, { organizationId = null, actorUserId = null } = {}) {
    const ctx = await recordsContext(env, zoneId, organizationId);
    if (ctx.error) return ctx.error;
    if (ctx.zone.status === "failed") return { ok: false, status: 409, error: "zone_not_active" };
    const v = validateRecord(input, ctx.zone.zone_name);
    if (!v.ok) return { ok: false, status: 422, error: v.error };
    const managed = (await repo.listHostnames(env, zoneId)).map((h) => h.hostname);
    if (managed.includes(v.record.name) && ["A", "AAAA", "CNAME"].includes(v.record.type)) return { ok: false, status: 409, error: "hostname_managed_by_lummet" };
    try {
      const created = await infra.createDnsRecord(env, ctx.zone.provider_zone_id, v.record);
      await repo.addEvent(env, zoneId, "record_added", `${v.record.type} ${v.record.name}`, { actorType: "customer_user", actorId: actorUserId });
      return { ok: true, record: created };
    } catch (err) {
      return /already exists|identical/i.test(String(err?.message)) ? { ok: false, status: 409, error: "record_exists" } : { ok: false, status: 502, error: "provider_error" };
    }
  }

  async function deleteRecord(env, zoneId, recordId, { organizationId = null, actorUserId = null } = {}) {
    const ctx = await recordsContext(env, zoneId, organizationId);
    if (ctx.error) return ctx.error;
    try {
      const records = await infra.listDnsRecords(env, ctx.zone.provider_zone_id);
      const rec = records.find((r) => r.id === recordId);
      if (!rec) return { ok: false, status: 404, error: "record_not_found" };
      const managed = (await repo.listHostnames(env, zoneId)).map((h) => h.hostname);
      if (managed.includes(rec.name) && ["A", "AAAA", "CNAME"].includes(rec.type)) return { ok: false, status: 409, error: "hostname_managed_by_lummet" };
      await infra.deleteDnsRecord(env, ctx.zone.provider_zone_id, recordId);
      await repo.addEvent(env, zoneId, "record_removed", `${rec.type} ${rec.name}`, { actorType: "customer_user", actorId: actorUserId });
      return { ok: true };
    } catch (_) { return { ok: false, status: 502, error: "provider_error" }; }
  }

  // ---------------------------------------------------- removal

  /**
   * Disconnects a hostname from the site (the zone and the customer's other hostnames stay).
   */
  async function removeHostname(env, domainRow, { actorUserId = null } = {}) {
    let detachError = null;
    if (domainRow.custom_domain_id) {
      try { await infra.detachWorkerDomain(env, domainRow.custom_domain_id); }
      catch (err) { if (!/not found|does not exist/i.test(String(err?.message))) detachError = String(err?.message || err).slice(0, 140); }
    }
    if (detachError) return { ok: false, status: 502, error: "provider_error" };
    await repo.updateHostname(env, domainRow.id, { status: "removed", removed_at: new Date().toISOString(), is_primary: 0, custom_domain_id: null });
    await repo.addHostnameEvent(env, { domainId: domainRow.id, fromStatus: domainRow.status, toStatus: "removed", actorType: "customer_user", actorId: actorUserId });
    const site = await repo.getSite(env, domainRow.site_id);
    if (site && site.primary_domain === domainRow.hostname) {
      // Fall back to the platform address; the next deployment refreshes the Worker's own URL.
      await repo.setSitePrimaryDomain(env, site.id, computeResourceNames(site, env).host);
    }
    return { ok: true };
  }

  /**
   * Removes a delegated domain completely: hostnames detached, the Cloudflare zone deleted. Deleting the zone of a
   * domain whose registrar still points at Cloudflare makes the WHOLE domain (website AND email) stop resolving, so
   * that is refused unless the caller explicitly acknowledges it.
   */
  async function removeZone(env, zoneId, { organizationId = null, actorUserId = null, acknowledgeOutage = false } = {}) {
    const zone = await repo.getZone(env, zoneId);
    if (!zone || zone.status === "removed") return { ok: false, status: 404, error: "not_found" };
    const site = await repo.getSite(env, zone.site_id);
    if (!site || (organizationId && site.organization_id !== organizationId)) return { ok: false, status: 404, error: "not_found" };

    if (zone.status === "active" && !acknowledgeOutage) {
      const seen = await dns.lookupNS(zone.zone_name);
      const stillDelegated = !seen.ok || delegationMatches(zone.name_servers, seen.nameServers);   // unknown counts as delegated
      if (stillDelegated) return { ok: false, status: 409, error: "nameservers_still_delegated" };
    }

    for (const h of await repo.listHostnames(env, zoneId)) {
      const r = await removeHostname(env, h, { actorUserId });
      if (!r.ok) return r;
    }
    if (zone.provider_zone_id) {
      try { await infra.deleteZone(env, zone.provider_zone_id); }
      catch (err) { if (!/not found|does not exist|invalid zone/i.test(String(err?.message))) return { ok: false, status: 502, error: "provider_error" }; }
    }
    await repo.updateZone(env, zoneId, { status: "removed", removed_at: new Date().toISOString(), next_check_at: null });
    await repo.addEvent(env, zoneId, "removed", null, { actorType: "customer_user", actorId: actorUserId });
    return { ok: true };
  }

  /** Cleanup used when a site or organization is erased: provider resources first, rows second. */
  async function cleanupForSite(env, siteId) {
    const failures = [];
    for (const d of await repo.listCustomDomainsForSite(env, siteId)) {
      try { await infra.detachWorkerDomain(env, d.custom_domain_id); }
      catch (err) { if (!/not found|does not exist/i.test(String(err?.message))) failures.push({ step: `custom_domain:${d.id}`, error: String(err?.message || err).slice(0, 160) }); continue; }
      await repo.updateHostname(env, d.id, { status: "removed", removed_at: new Date().toISOString(), custom_domain_id: null, is_primary: 0 });
    }
    for (const z of await repo.listCleanupForSite(env, siteId)) {
      try { if (z.provider_zone_id) await infra.deleteZone(env, z.provider_zone_id); }
      catch (err) { if (!/not found|does not exist|invalid zone/i.test(String(err?.message))) { failures.push({ step: `zone:${z.id}`, error: String(err?.message || err).slice(0, 160) }); continue; } }
      await repo.updateZone(env, z.id, { status: "removed", removed_at: new Date().toISOString(), next_check_at: null });
    }
    for (const r of await repo.listRoutesForSite(env, siteId)) {
      try { await infra.deleteWorkerRoute(env, r.route_id); }
      catch (err) { if (!/not found|does not exist/i.test(String(err?.message))) { failures.push({ step: `route:${r.id}`, error: String(err?.message || err).slice(0, 160) }); continue; } }
      await repo.updateHostname(env, r.id, { route_id: null });
    }
    return failures;
  }

  async function listForSite(env, siteId) {
    const out = [];
    for (const z of await repo.listForSite(env, siteId)) out.push(await view(env, z.id, { events: false }));
    return out;
  }

  return {
    addZone, checkZone, sweep, view, listForSite, listRecords, importScanned, addRecord, deleteRecord, removeHostname, removeZone, cleanupForSite,
    addSubdomain, checkSubdomain, subdomainView, listSubdomainsForSite, removeSubdomain, removeAnyHostname
  };
}

// Production singleton. Tests import createZoneDomainService with fakes; route-level tests swap the providers with
// __setZoneProvidersForTests() (same pattern as deployments.js). Passing nothing restores the real ones.
const ref = { infra: cloudflareProvider, dns: dohResolver };
const proxy = (key) => new Proxy({}, { get: (_t, k) => ref[key][k] });
export function __setZoneProvidersForTests({ infra, dns } = {}) {
  ref.infra = infra || cloudflareProvider;
  ref.dns = dns || dohResolver;
}
export const zoneDomains = createZoneDomainService({ infra: proxy("infra"), dns: proxy("dns") });

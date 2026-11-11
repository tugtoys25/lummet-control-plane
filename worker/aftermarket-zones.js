// =====================================================
// AFTERMARKET — NAMESERVER VERIFICATION BY CLOUDFLARE ZONE
//
// Same mechanism as custom domains at site creation (zone-domains.js), for a seller's domain on the for-sale marketplace:
//
//   1. startZone   the seller asks for nameservers. A zone for the domain is created in the platform Cloudflare account;
//                  Cloudflare assigns the domain its OWN two nameservers, stored on the row. (Cloudflare also scans the
//                  domain's current DNS records so they can be copied across.)
//   2. (seller)    sets those two nameservers at the registrar.
//   3. checkZone   run by the seller's "Check" button and by the maintenance sweep:
//                    - public DNS (DoH): does the registrar list them yet?                      -> progress only
//                    - Cloudflare re-check request (throttled)                                  -> may speed it up
//                    - zone status from Cloudflare: ACTIVE is the only thing that verifies the domain. A zone cannot become
//                      active without real delegation, so this is the ownership proof.
//   4. activate    the scanned records are accepted, old A/AAAA/CNAME records at the apex and www are removed, both names are
//                  attached to this Worker (Cloudflare adds the DNS record and certificate) and ONLY THEN the domain is
//                  listed with hosted = 1, so https://domain/ shows its for-sale page.
//
// Safety: a domain that already has a live customer zone, the platform's own domains, a zone Cloudflare reports as already active
// (not ours to hand out) and a platform-wide cap on open claims are all refused. A claim that is not finished expires and its zone
// is deleted; so is the zone of a domain that is later unlisted or sold.
//
// Written against infra-provider.js's and dns-provider.js's contracts; tests swap them with __setAftermarketProvidersForTests.
// All SQL lives in repositories/public-site.js (and repositories/domain-zones.js for the customer-zone check).
// =====================================================

import * as dohResolver from "./dns-doh.js";
import * as cloudflareProvider from "./infra-cloudflare.js";
import * as zoneRepo from "./repositories/domain-zones.js";
import * as repo from "./repositories/public-site.js";
import { reservedHostnames } from "./platform-domains.js";
import { normalizeDomainInput, delegationMatches, validateRecord } from "./zone-domains.js";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

const ref = { infra: cloudflareProvider, dns: dohResolver };
export function __setAftermarketProvidersForTests({ infra, dns } = {}) {
  ref.infra = infra || cloudflareProvider;
  ref.dns = dns || dohResolver;
}

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const lower = (a) => (a || []).map((x) => String(x).toLowerCase().replace(/\.$/, ""));
const iso = (ms) => new Date(ms).toISOString();
const parse = (s) => (s ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${String(s).replace(" ", "T")}Z`) : NaN);

/** The Worker the domain is attached to (this one). */
export function workerNameFor(env) {
  if (env.CONTROL_PLANE_WORKER_NAME) return String(env.CONTROL_PLANE_WORKER_NAME);
  return String(env.ENVIRONMENT || "").toLowerCase() === "staging" ? "lummet-control-plane-staging" : "lummet-control-plane";
}

/** Nameserver verification needs the platform Cloudflare credentials, exactly like custom domains. */
export const nsAvailable = (env) => Boolean(env.CF_API_TOKEN && env.CF_ACCOUNT_ID);

export const assignedNameServers = (row) => String(row?.ns_assigned || "").split(",").map((n) => n.trim()).filter(Boolean);

function mapProviderError(err) {
  const m = String(err?.message || "");
  if (/already exists|another account|not available|taken|registered/i.test(m)) return "ns_taken";
  return "ns_error";
}

// ----------------------------------------------------------------- start

/** Create the zone for a pending seller claim. Returns { ok: true } or { ok: false, error: "ns_off|ns_taken|ns_busy|ns_error" }. */
export async function startZone(env, row, { now = Date.now() } = {}) {
  if (!nsAvailable(env) && ref.infra === cloudflareProvider) return { ok: false, error: "ns_off" };
  if (row.cf_zone_id) return { ok: true, existing: true };
  const norm = normalizeDomainInput(row.domain, env, await reservedHostnames(env));
  if (!norm.ok) return { ok: false, error: "ns_taken" };

  if (await zoneRepo.findLiveByName(env, norm.zoneName)) return { ok: false, error: "ns_taken" };
  if ((await repo.countOpenAftermarketZones(env)) >= num(env.AFTERMARKET_MAX_OPEN_ZONES, 25)) return { ok: false, error: "ns_busy" };

  let created;
  try { created = await ref.infra.createZone(env, { name: norm.zoneName }); }
  catch (err) { return { ok: false, error: mapProviderError(err) }; }

  // Never adopt a zone that is not ours to hand out: the platform zone, one a customer already claimed, or an active zone.
  if ((env.CF_ZONE_ID && created.zoneId === env.CF_ZONE_ID) || (await zoneRepo.findByProviderZoneId(env, created.zoneId)) || created.status === "active") {
    return { ok: false, error: "ns_taken" };
  }
  if (!created.nameServers?.length) {
    try { await ref.infra.deleteZone(env, created.zoneId); } catch (_) { /* best effort */ }
    return { ok: false, error: "ns_error" };
  }
  try {
    await repo.patchAftermarketZone(env, row.id, {
      cf_zone_id: created.zoneId,
      ns_assigned: created.nameServers.join(","),
      ns_detected_at: null,
      zone_expires_at: iso(now + num(env.AFTERMARKET_PENDING_DAYS, 7) * DAY),
      next_check_at: iso(now + 3 * MINUTE)
    });
  } catch (err) {
    try { await ref.infra.deleteZone(env, created.zoneId); } catch (_) { /* staff can see it in Cloudflare */ }
    throw err;
  }
  try { await ref.infra.triggerDnsScan(env, created.zoneId); } catch (_) { /* optional */ }
  return { ok: true };
}

// ----------------------------------------------------------------- check

async function dropZone(env, row, { status = null } = {}) {
  if (row.cf_zone_id) { try { await ref.infra.deleteZone(env, row.cf_zone_id); } catch (_) { /* already gone, or staff clean up */ } }
  await repo.patchAftermarketZone(env, row.id, { cf_zone_id: null, ns_assigned: null, ns_detected_at: null, zone_expires_at: null, next_check_at: null, activation_asked_at: null, ...(status ? { status } : {}) });
}

async function activate(env, row) {
  const zoneId = row.cf_zone_id;
  // Keep the domain's other records (mail, TXT...): Cloudflare scanned them when the zone was created.
  try { await ref.infra.acceptScannedRecords(env, zoneId); } catch (_) { /* nothing to accept, or scan not ready */ }
  const hostnames = [row.domain, `www.${row.domain}`];
  const existing = await ref.infra.listDnsRecords(env, zoneId).catch(() => []);
  let apexOk = false;
  for (const hostname of hostnames) {
    try {
      // Records of the old website at this exact name would make Cloudflare refuse the attachment.
      for (const r of existing.filter((x) => x.name === hostname && ["A", "AAAA", "CNAME"].includes(x.type))) await ref.infra.deleteDnsRecord(env, zoneId, r.id);
      await ref.infra.attachWorkerDomain(env, { hostname, workerName: workerNameFor(env), zoneId, zoneName: row.domain });
      if (hostname === row.domain) apexOk = true;
    } catch (err) {
      console.error(`aftermarket attach failed for ${hostname}:`, String(err?.message || err).slice(0, 160));
    }
  }
  return apexOk;
}

/**
 * Advance one pending claim that has a zone. Returns { state }: "listed" | "seen" (registrar shows the nameservers, Cloudflare
 * still confirming) | "waiting" | "gone" (the zone vanished at Cloudflare; the seller starts again) | "error".
 */
export async function checkZone(env, row, { manual = false, now = Date.now() } = {}) {
  if (!row.cf_zone_id) return { state: "gone" };
  const patch = {};
  let cf = null;
  try { cf = await ref.infra.getZone(env, row.cf_zone_id); } catch (_) { /* provider hiccup: keep the claim, check again later */ }

  if (cf && cf.status === "gone") { await dropZone(env, row); return { state: "gone" }; }
  if (cf?.nameServers?.length && lower(cf.nameServers).sort().join() !== lower(assignedNameServers(row)).sort().join()) patch.ns_assigned = cf.nameServers.join(",");

  const assigned = cf?.nameServers?.length ? cf.nameServers : assignedNameServers(row);
  const seen = await ref.dns.lookupNS(row.domain);
  let matches = false;
  if (seen?.ok) {
    matches = delegationMatches(assigned, seen.nameServers);
    patch.ns_detected_at = matches ? row.ns_detected_at || iso(now) : null;
    const askedMs = parse(row.activation_asked_at);
    if ((matches || manual) && cf?.status === "pending" && (!Number.isFinite(askedMs) || now - askedMs >= 10 * MINUTE)) {
      try { await ref.infra.requestActivationCheck(env, row.cf_zone_id); } catch (_) { /* rate limited: Cloudflare re-checks on its own */ }
      patch.activation_asked_at = iso(now);
    }
  }

  if (cf?.status === "active") {
    if (await activate(env, row)) {
      await repo.markAftermarketVerified(env, row.id, "ns");
      await repo.patchAftermarketZone(env, row.id, { ...patch, next_check_at: null, zone_expires_at: null });
      return { state: "listed" };
    }
    await repo.patchAftermarketZone(env, row.id, { ...patch, next_check_at: iso(now + 5 * MINUTE) });   // attach failed: retry on the next tick
    return { state: "error" };
  }

  const expiresMs = parse(row.zone_expires_at);
  if (Number.isFinite(expiresMs) && now >= expiresMs) { await dropZone(env, row, { status: "unlisted" }); return { state: "gone" }; }
  patch.next_check_at = iso(now + 10 * MINUTE);
  await repo.patchAftermarketZone(env, row.id, patch);
  return { state: matches ? "seen" : "waiting" };
}

// ----------------------------------------------------------------- sweep

/** Maintenance tick: advance every due claim, and delete the zone of any domain that is no longer pending or listed. */
export async function sweep(env, { now = Date.now(), limit = 10 } = {}) {
  if (!nsAvailable(env) && ref.infra === cloudflareProvider) return { checked: 0, released: 0 };
  let checked = 0;
  let released = 0;
  for (const row of await repo.listAftermarketZonesDue(env, iso(now), limit)) {
    try { await checkZone(env, row, { now }); checked += 1; }
    catch (_) { await repo.patchAftermarketZone(env, row.id, { next_check_at: iso(now + 10 * MINUTE) }).catch(() => {}); }
  }
  for (const row of await repo.listAftermarketZonesToRelease(env, limit)) {
    try { await dropZone(env, row); released += 1; } catch (_) { /* try again next tick */ }
  }
  return { checked, released };
}

// ----------------------------------------------------------------- TXT proof (no Cloudflare needed)

/** Does `_lummet-verify.<domain>` carry this claim's token? Shared by the public verify page and the seller portal. */
export async function checkTxt(row) {
  if (!row?.verify_token) return false;
  const values = await ref.dns.lookupTXT(`_lummet-verify.${row.domain}`);
  return (values || []).some((v) => String(v).trim() === row.verify_token);
}

// ----------------------------------------------------------------- DNS records (seller portal, nameserver-verified domains)

const WEB_TYPES = ["A", "AAAA", "CNAME"];

/** DNS can be managed only while the domain's zone is ours and active: verified by nameservers and still listed. */
export const canManageDns = (row) => Boolean(row && row.cf_zone_id && row.verified_method === "ns" && row.status === "listed");

const managedNames = (row) => new Set([row.domain, `www.${row.domain}`]);

/** { ok, records: [{ id, type, name, content, ttl, proxied, managed }] }. `managed` = served by Lummet (the for-sale page), read-only. */
export async function listRecords(env, row) {
  if (!canManageDns(row)) return { ok: false, status: 409, error: "dns_not_available" };
  try {
    const records = await ref.infra.listDnsRecords(env, row.cf_zone_id);
    const managed = managedNames(row);
    return { ok: true, records: records.map((r) => ({ ...r, managed: managed.has(r.name) && WEB_TYPES.includes(r.type) })) };
  } catch (_) { return { ok: false, status: 502, error: "provider_error" }; }
}

export async function addRecord(env, row, input) {
  if (!canManageDns(row)) return { ok: false, status: 409, error: "dns_not_available" };
  const v = validateRecord(input, row.domain);
  if (!v.ok) return { ok: false, status: 422, error: v.error };
  if (managedNames(row).has(v.record.name) && WEB_TYPES.includes(v.record.type)) return { ok: false, status: 409, error: "hostname_managed_by_lummet" };
  try {
    const created = await ref.infra.createDnsRecord(env, row.cf_zone_id, v.record);
    return { ok: true, record: created };
  } catch (err) {
    return /already exists|identical/i.test(String(err?.message)) ? { ok: false, status: 409, error: "record_exists" } : { ok: false, status: 502, error: "provider_error" };
  }
}

export async function deleteRecord(env, row, recordId) {
  if (!canManageDns(row)) return { ok: false, status: 409, error: "dns_not_available" };
  try {
    const rec = (await ref.infra.listDnsRecords(env, row.cf_zone_id)).find((r) => r.id === recordId);
    if (!rec) return { ok: false, status: 404, error: "record_not_found" };
    if (managedNames(row).has(rec.name) && WEB_TYPES.includes(rec.type)) return { ok: false, status: 409, error: "hostname_managed_by_lummet" };
    await ref.infra.deleteDnsRecord(env, row.cf_zone_id, recordId);
    return { ok: true };
  } catch (_) { return { ok: false, status: 502, error: "provider_error" }; }
}

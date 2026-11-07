// Platform domains, staff side: add, verify, default, disable, remove. Written against infra-provider.js's contract only
// (production binds infra-cloudflare.js, tests bind the fake). SQL lives in repositories/platform-domains.js; this file
// holds the rules. Every method returns { ok: true, ... } or { ok: false, error, status }. Audit entries are written by
// the route that calls it (logAudit), the same way the other staff routes do.
//
// A domain becomes `active` (selectable) only after all five real checks pass. Nothing here creates a Cloudflare zone.
import * as repo from "./repositories/platform-domains.js";
import * as zonesRepo from "./repositories/domain-zones.js";
import { normalizeHostname, isValidHostname, ensureBootstrap } from "./platform-domains.js";
import { isLikelyApex } from "./zone-domains.js";
import * as customerAuth from "./customer-auth.js";

export const CHECK_STEPS = [
  { key: "zone", label: "Zone exists and is active in the platform account" },
  { key: "permissions", label: "API token may edit Workers routes and DNS on the zone" },
  { key: "wildcard", label: "Proxied wildcard DNS record" },
  { key: "certificate", label: "Certificate covers the wildcard" },
  { key: "routing", label: "Live routing test" }
];

const WILDCARD_RECORD = { type: "AAAA", content: "100::", ttl: 1, proxied: true };   // same as the lummet.app zone (DEPLOYMENT.md)
const VERIFY_LIMIT = 12;                                                             // verify runs per admin per 15 minutes

/** A message safe to show: no token-looking strings, no long ids, short. */
export function safeMessage(err) {
  return String(err?.message || err || "unknown error")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [hidden]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[hidden]")
    .slice(0, 200);
}

const fail = (error, status = 400, extra = {}) => ({ ok: false, error, status, ...extra });
const step = (key, state, detail, fix = "") => ({ key, label: CHECK_STEPS.find((s) => s.key === key).label, state, detail, fix });

export function createPlatformDomainAdmin({ infra, fetcher } = {}) {
  const doFetch = (...a) => (fetcher || fetch)(...a);

  async function validateHostname(env, input) {
    const hostname = normalizeHostname(input);
    if (!isValidHostname(hostname)) return fail("invalid_domain", 422, { detail: "Enter a plain domain such as example.com." });
    if (hostname === "workers.dev" || hostname === "pages.dev" || hostname.endsWith(".workers.dev") || hostname.endsWith(".pages.dev")) return fail("domain_reserved", 422, { detail: "workers.dev and pages.dev cannot be platform domains." });
    if (!isLikelyApex(hostname)) return fail("not_registrable", 422, { detail: "Use the registrable domain itself (example.com), not a subdomain: only the apex is covered by the free wildcard certificate." });
    try { if (env.PORTAL_BASE_URL && new URL(env.PORTAL_BASE_URL).hostname === hostname) return fail("domain_is_portal", 422, { detail: "That is the portal host." }); } catch (_) { /* not a URL */ }
    if (await repo.getByHostname(env, hostname)) return fail("domain_exists", 409, { detail: "That domain is already a platform domain." });
    const custom = (await zonesRepo.findLiveByName(env, hostname)) || (await zonesRepo.findZoneContaining(env, hostname));
    if (custom) return fail("domain_in_use_by_customer", 409, { detail: "A customer has connected that domain as a custom domain." });
    return { ok: true, hostname };
  }

  /** Adds a row in `pending`. It cannot be used until verify() passes every check. */
  async function addDomain(env, { hostname, label, actorId }) {
    await ensureBootstrap(env);
    const v = await validateHostname(env, hostname);
    if (!v.ok) return v;
    const id = crypto.randomUUID();
    const rows = await repo.list(env);
    const created = await repo.insert(env, { id, hostname: v.hostname, label: String(label || "").trim().slice(0, 80) || v.hostname, status: "pending", isDefault: false, sortOrder: rows.length, createdBy: actorId || null });
    if (!created) return fail("domain_exists", 409);
    return { ok: true, domain: await repo.get(env, id) };
  }

  /** The five checks, in order. Stops at the first failure; later steps are reported as skipped. */
  async function runChecks(env, domain, { createWildcard = false } = {}) {
    const steps = [];
    const stop = (s) => { steps.push(s); for (const rest of CHECK_STEPS.slice(steps.length)) steps.push(step(rest.key, "skipped", "Not run: fix the step above first.")); return steps; };
    const host = domain.hostname;
    let zoneId = domain.cf_zone_id;

    // 2 (spec step 2): zone lookup by name
    let zone;
    try { zone = await infra.findZoneByName(env, host); }
    catch (err) { return { steps: stop(step("zone", "fail", `Cloudflare lookup failed: ${safeMessage(err)}`, "Check CF_API_TOKEN and CF_ACCOUNT_ID, then re-run.")), passed: false }; }
    if (!zone) return { steps: stop(step("zone", "fail", `No zone named ${host} in the platform Cloudflare account.`, `Add ${host} to this Cloudflare account first (this screen never creates zones), then re-run.`)), passed: false };
    if (zone.status !== "active") return { steps: stop(step("zone", "fail", `The zone is ${zone.cfStatus}, not active.`, "Finish the nameserver change at the registrar until Cloudflare shows the zone as Active, then re-run.")), passed: false };
    zoneId = zone.zoneId;
    steps.push(step("zone", "ok", "Zone found and active."));

    // permissions: harmless reads
    try {
      const access = await infra.probeZoneAccess(env, zoneId);
      if (!access.ok) return { zoneId, steps: stop(step("permissions", "fail", `Missing permission: ${access.missing.join(", ")}.`, `Edit the API token: add Zone > ${access.missing.join(" and Zone > ")} for ${host}, then re-run.`)), passed: false };
    } catch (err) { return { zoneId, steps: stop(step("permissions", "fail", `Permission check failed: ${safeMessage(err)}`, "Re-run; if it repeats, check the token.")), passed: false }; }
    steps.push(step("permissions", "ok", "Workers routes and DNS are readable with this token."));

    // wildcard DNS
    let records;
    try { records = await infra.listDnsRecords(env, zoneId); }
    catch (err) { return { zoneId, steps: stop(step("wildcard", "fail", `Could not read DNS: ${safeMessage(err)}`, "Re-run.")), passed: false }; }
    const wildcardName = `*.${host}`;
    const wc = records.find((r) => r.name === wildcardName && ["A", "AAAA", "CNAME"].includes(r.type));
    if (wc && !wc.proxied) return { zoneId, steps: stop(step("wildcard", "fail", `${wildcardName} exists but is not proxied (grey cloud).`, "Turn the orange cloud on for that record in Cloudflare DNS, then re-run.")), passed: false };
    if (!wc) {
      if (!createWildcard) return { zoneId, needsConfirmation: "create_wildcard", steps: stop(step("wildcard", "warn", `No ${wildcardName} record.`, `Confirm to create a proxied AAAA record ${wildcardName} -> 100:: (the same as lummet.app), or add it yourself in Cloudflare DNS.`)), passed: false };
      try { await infra.createDnsRecord(env, zoneId, { name: wildcardName, ...WILDCARD_RECORD }); }
      catch (err) { return { zoneId, steps: stop(step("wildcard", "fail", `Could not create the record: ${safeMessage(err)}`, "Add the proxied wildcard record by hand in Cloudflare DNS, then re-run.")), passed: false }; }
      steps.push(step("wildcard", "ok", `Created proxied ${wildcardName}.`));
    } else steps.push(step("wildcard", "ok", `${wildcardName} is present and proxied.`));

    // certificate (Universal SSL covers *.apex one level deep, which is what <slug>.<domain> needs)
    try {
      const ssl = await infra.getUniversalSsl(env, zoneId);
      if (!ssl.enabled) return { zoneId, steps: stop(step("certificate", "fail", "Universal SSL is switched off for this zone.", "In Cloudflare: SSL/TLS > Edge Certificates > turn Universal SSL on, wait for it to issue, then re-run.")), passed: false };
    } catch (err) { return { zoneId, steps: stop(step("certificate", "fail", `Could not read the certificate setting: ${safeMessage(err)}`, "Re-run; if it repeats, check Cloudflare SSL/TLS > Edge Certificates.")), passed: false }; }
    steps.push(step("certificate", "ok", `Universal SSL covers *.${host}.`));

    // live routing test: a short-lived route to this Worker's own health endpoint, removed afterwards
    const worker = env.CF_SELF_WORKER_NAME || "lummet-control-plane";
    const testHost = `platform-check.${host}`;
    let routeId = null;
    try {
      ({ routeId } = await infra.ensureWorkerRoute(env, { pattern: `${testHost}/*`, workerName: worker, zoneId }));
      const res = await doFetch(`https://${testHost}/api/health`, { method: "GET", headers: { "Cache-Control": "no-cache" }, redirect: "manual" });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.ok !== true) throw new Error(`https://${testHost}/ answered HTTP ${res.status}`);
      steps.push(step("routing", "ok", `https://${testHost}/ reached the platform Worker.`));
    } catch (err) {
      const s = step("routing", "fail", `Routing test failed: ${safeMessage(err)}`, "Usually the wildcard record is missing or still proxying elsewhere, or the certificate has not issued yet. Wait a minute and re-run.");
      steps.push(s);
      return { zoneId, steps, passed: false, _routeId: routeId };
    } finally {
      if (routeId) { try { await infra.deleteWorkerRoute(env, routeId, { zoneId }); } catch (_) { /* a leftover test route is harmless and is reused next time */ } }
    }
    return { zoneId, steps, passed: true };
  }

  /** Runs the checks and records the result. pending/failed -> active only when all pass. */
  async function verify(env, id, { adminId, createWildcard = false } = {}) {
    const domain = await repo.get(env, id);
    if (!domain) return fail("not_found", 404);
    if (adminId && !(await customerAuth.isUnderLimit(env, `admin:${adminId}`, "platform_domain_verify", VERIFY_LIMIT))) return fail("rate_limited", 429);
    if (adminId) await customerAuth.recordFailure(env, `admin:${adminId}`, "platform_domain_verify");   // counts every run: it calls Cloudflare
    const wasActive = domain.status === "active";
    if (!wasActive) await repo.update(env, id, { status: "verifying" });
    const result = await runChecks(env, domain, { createWildcard });
    const stored = { at: new Date().toISOString(), passed: result.passed, steps: result.steps };
    await repo.saveCheck(env, id, stored);
    if (result.zoneId && result.zoneId !== domain.cf_zone_id) await repo.update(env, id, { cfZoneId: result.zoneId });
    let status;
    if (domain.status === "disabled") status = "disabled";                     // a disabled domain stays disabled whatever the checks say
    else if (result.passed) status = "active";
    else if (domain.is_default) status = "active";                              // never demote the default under live sites; the failure is shown
    else if (result.needsConfirmation) status = wasActive ? "active" : "pending";
    else status = "failed";
    if (status !== (wasActive ? domain.status : "verifying")) await repo.update(env, id, { status });
    return { ok: true, passed: result.passed, needsConfirmation: result.needsConfirmation || null, steps: result.steps, domain: await repo.get(env, id) };
  }

  async function setDefault(env, id) {
    const d = await repo.get(env, id);
    if (!d) return fail("not_found", 404);
    if (d.status !== "active") return fail("domain_not_active", 409, { detail: "Only an active domain can be the default." });
    if (d.is_default) return { ok: true, unchanged: true, domain: d };
    await repo.setDefault(env, id);
    return { ok: true, domain: await repo.get(env, id) };
  }

  async function setStatusDisabled(env, id, disabled) {
    const d = await repo.get(env, id);
    if (!d) return fail("not_found", 404);
    if (disabled) {
      if (d.is_default) return fail("cannot_disable_default", 409, { detail: "Set another domain as the default first." });
      if (d.status === "disabled") return { ok: true, unchanged: true, domain: d };
      await repo.update(env, id, { status: "disabled" });
    } else {
      if (d.status !== "disabled") return { ok: true, unchanged: true, domain: d };
      await repo.update(env, id, { status: "pending" });           // must pass the checks again before it is selectable
    }
    return { ok: true, domain: await repo.get(env, id) };
  }

  async function remove(env, id) {
    const d = await repo.get(env, id);
    if (!d) return fail("not_found", 404);
    if (d.is_default) return fail("cannot_remove_default", 409, { detail: "Set another domain as the default first." });
    const counts = await repo.siteCountsByStatus(env, id, { isDefault: false });
    const sites = Object.values(counts).reduce((a, b) => a + b, 0);
    if (sites > 0) return fail("domain_in_use", 409, { sites, detail: `${sites} site${sites === 1 ? "" : "s"} still use this domain. Move them first.` });
    await repo.remove(env, id);
    return { ok: true };
  }

  const ENTITLEMENT_KEY = /^[a-z][a-z0-9_.]{1,63}$/;
  /** label, customer choice, required entitlement. */
  async function update(env, id, fields) {
    const d = await repo.get(env, id);
    if (!d) return fail("not_found", 404);
    const patch = {};
    if ("label" in fields) {
      const label = String(fields.label || "").trim().slice(0, 80);
      if (!label) return fail("label_required", 422);
      patch.label = label;
    }
    if ("allowCustomerChoice" in fields) patch.allowCustomerChoice = fields.allowCustomerChoice === true;
    if ("entitlementKey" in fields) {
      const k = String(fields.entitlementKey || "").trim();
      if (k && !ENTITLEMENT_KEY.test(k)) return fail("invalid_entitlement_key", 422);
      patch.entitlementKey = k || null;
    }
    await repo.update(env, id, patch);
    return { ok: true, domain: await repo.get(env, id) };
  }

  async function reorder(env, orderedIds) {
    const known = new Set((await repo.list(env)).map((d) => d.id));
    if (!Array.isArray(orderedIds) || !orderedIds.length || orderedIds.some((i) => !known.has(i)) || new Set(orderedIds).size !== orderedIds.length) return fail("invalid_order", 422);
    await repo.setSortOrders(env, orderedIds);
    return { ok: true };
  }

  /** List with the per-domain site counts the dashboard shows. */
  async function listWithUsage(env) {
    await ensureBootstrap(env);
    const out = [];
    for (const d of await repo.list(env)) {
      const counts = await repo.siteCountsByStatus(env, d.id, { isDefault: d.is_default });
      out.push({ ...d, siteCounts: counts, siteTotal: Object.values(counts).reduce((a, b) => a + b, 0) });
    }
    return out;
  }

  return { validateHostname, addDomain, runChecks, verify, setDefault, disable: (env, id) => setStatusDisabled(env, id, true), enable: (env, id) => setStatusDisabled(env, id, false), remove, update, reorder, listWithUsage };
}

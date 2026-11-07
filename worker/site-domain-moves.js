// Move a site to another platform domain (staff only). Written against infra-provider.js's contract; `redeploy` is injected.
//
// Order is chosen so the site is reachable at every moment:
//   1. new_route      create the route for the NEW host in the target zone (old route untouched)
//   2. check_new_host the new host must answer before anything is switched
//   3. switch         ONE database batch: tenant host, sites row (+ primary_domain only if it was the platform host), route row
//   4. redeploy       the Worker learns its URL (skipped when primary_domain stays a custom domain)
//   5. redirect       the OLD route is repointed to the control plane Worker, which answers with a redirect to the new host
// Every finished step is recorded, so a failed move can be resumed (re-runs only what is left) or rolled back. A failure
// never removes the old route before the redirect takes over, so the site stays reachable at the old or the new host.
//
// A verified custom domain is never touched: primary_domain is only updated when it equals the old platform host (or is empty).
import * as repo from "./repositories/site-domain-moves.js";
import * as siteResources from "./repositories/site-resources.js";
import * as pd from "./platform-domains.js";
import * as domainsRepo from "./repositories/platform-domains.js";
import { safeMessage } from "./platform-domains-admin.js";

export const DEFAULT_REDIRECT_DAYS = 30;
const MAX_REDIRECT_DAYS = 365;
const fail = (error, status = 400, extra = {}) => ({ ok: false, error, status, ...extra });
const selfWorker = (env) => env.CF_SELF_WORKER_NAME || "lummet-control-plane";

export function clampRedirectDays(v, env) {
  const fallback = Number.isFinite(Number(env?.PLATFORM_DOMAIN_MOVE_REDIRECT_DAYS)) && env?.PLATFORM_DOMAIN_MOVE_REDIRECT_DAYS !== undefined ? Number(env.PLATFORM_DOMAIN_MOVE_REDIRECT_DAYS) : DEFAULT_REDIRECT_DAYS;
  const n = v === undefined || v === null || v === "" ? fallback : Number(v);
  return Number.isInteger(n) && n >= 0 && n <= MAX_REDIRECT_DAYS ? n : null;
}

export function createSiteDomainMoveService({ infra, redeploy }) {
  async function context(env, siteId) {
    const site = await repo.getSiteWithTenant(env, siteId);
    if (!site) return null;
    const current = await pd.getDomainForSite(env, site);
    const route = await siteResources.findActiveResource(env, siteId, "route");
    const worker = await siteResources.findActiveResource(env, siteId, "worker");
    return { site, current, route, worker };
  }

  /** What would happen, and what stops it. Pure reads. */
  async function preview(env, siteId, targetDomainId, { redirectDays } = {}) {
    const ctx = await context(env, siteId);
    if (!ctx) return fail("site_not_found", 404);
    const { site, current, route, worker } = ctx;
    const target = targetDomainId ? await domainsRepo.get(env, targetDomainId) : null;
    const days = clampRedirectDays(redirectDays, env);
    const blockers = [];
    if (days === null) blockers.push("Redirect days must be a whole number from 0 to 365.");
    if (site.status !== "active") blockers.push(`The site is ${site.status}; only an active site can be moved.`);
    if (!site.tenant_id) blockers.push("The site has no tenant yet (it has not finished provisioning).");
    if (!worker) blockers.push("The site has no deployed Worker yet.");
    if (!route) blockers.push("The site has no route recorded, so there is nothing to move.");
    if (!target) blockers.push("Choose a target domain.");
    else {
      if (target.status !== "active") blockers.push(`${target.hostname} is ${target.status}; it must be active.`);
      if (current.id && target.id === current.id) blockers.push("The site is already on that domain.");
    }
    if (await repo.findOpenMove(env, siteId)) blockers.push("An earlier move of this site is unfinished. Resume or roll it back first.");
    const oldHost = pd.hostFor(site, current);
    const newHost = target ? pd.hostFor(site, target) : null;
    const customPrimary = !!site.primary_domain && site.primary_domain !== oldHost;
    const effects = target ? [
      `The site's platform address changes from ${oldHost} to ${newHost}.`,
      customPrimary ? `Its primary domain (${site.primary_domain}) is a custom domain and is NOT changed.` : `Its primary domain becomes ${newHost}, and the site is redeployed so it learns its new URL.`,
      days === 0 ? `${oldHost} stops working immediately (no redirect).` : `${oldHost} redirects to ${newHost} for ${days} day${days === 1 ? "" : "s"}, then stops working.`,
      "Links, bookmarks and webhooks that use the old address keep working through the redirect only while it lasts."
    ] : [];
    return { ok: true, siteId, siteName: site.name, oldHost, newHost, customPrimary, redirectDays: days, effects, blockers, current: { id: current.id, hostname: current.hostname }, target: target ? { id: target.id, hostname: target.hostname, label: target.label } : null };
  }

  async function start(env, { siteId, targetDomainId, confirmHostname, redirectDays, actorId }) {
    const p = await preview(env, siteId, targetDomainId, { redirectDays });
    if (!p.ok) return p;
    if (p.blockers.length) return fail("move_blocked", 409, { blockers: p.blockers });
    if (String(confirmHostname || "").trim().toLowerCase() !== p.newHost) return fail("confirmation_required", 422, { detail: `Type the new address (${p.newHost}) to confirm.` });
    const ctx = await context(env, siteId);
    const target = await domainsRepo.get(env, targetDomainId);
    const move = await repo.insertMove(env, {
      id: crypto.randomUUID(), siteId, fromDomainId: ctx.current.id, toDomainId: target.id, oldHost: p.oldHost, newHost: p.newHost,
      oldRouteId: ctx.route.resource_id, oldZoneId: siteResources.routeZoneId(ctx.route) || pd.zoneIdFor(env, ctx.current),
      newZoneId: pd.zoneIdFor(env, target), workerName: ctx.worker.resource_name,
      updatePrimary: !p.customPrimary, redirectDays: p.redirectDays, requestedBy: actorId
    });
    if (!move) return fail("move_blocked", 409, { blockers: ["An earlier move of this site is unfinished."] });
    return run(env, move.id);
  }

  async function stepNewRoute(env, move) {
    const r = await infra.ensureWorkerRoute(env, { pattern: `${move.new_host}/*`, workerName: move.worker_name, zoneId: move.new_zone_id });
    await repo.recordStep(env, move.id, "new_route", { newRouteId: r.routeId, detail: `route in target zone` });
  }
  async function stepCheck(env, move) {
    const res = await infra.checkHealth(env, { url: `https://${move.new_host}/` });
    if (!res.ok) throw new Error(`the new address https://${move.new_host}/ did not answer (status ${res.statusCode ?? "unreachable"}). Nothing was switched.`);
    await repo.recordStep(env, move.id, "check_new_host");
  }
  async function stepSwitch(env, move) {
    const fresh = await repo.getMove(env, move.id);
    const site = await repo.getSiteWithTenant(env, move.site_id);
    await repo.applySwitch(env, { siteId: site.id, tenantId: site.tenant_id, host: move.new_host, domainId: move.to_domain_id, setPrimary: move.update_primary, route: { provider: infra.PROVIDER_NAME, routeId: fresh.new_route_id, zoneId: move.new_zone_id } });
    await repo.recordStep(env, move.id, "switch");
  }
  async function stepRedeploy(env, move) {
    if (!move.update_primary) return repo.recordStep(env, move.id, "redeploy", { detail: "skipped: primary domain unchanged" });
    const r = await redeploy(env, move.site_id);
    if (!r?.ok) throw new Error(`the site is live at ${move.new_host} but the redeploy did not start (${r?.error || "unknown"}). Resume to retry.`);
    await repo.recordStep(env, move.id, "redeploy");
  }
  async function stepRedirect(env, move) {
    const days = move.redirect_days;
    if (days === 0) {
      try { await infra.deleteWorkerRoute(env, move.old_route_id, { zoneId: move.old_zone_id }); } catch (err) { if (!/not found|10007|does not exist/i.test(String(err.message))) throw err; }
      return repo.recordStep(env, move.id, "redirect", { detail: "no redirect (0 days): old route removed" });
    }
    const r = await infra.ensureWorkerRoute(env, { pattern: `${move.old_host}/*`, workerName: selfWorker(env), zoneId: move.old_zone_id });
    const until = new Date(Date.now() + days * 86400000).toISOString();
    await repo.saveRedirect(env, { oldHost: move.old_host, newHost: move.new_host, siteId: move.site_id, moveId: move.id, routeId: r.routeId, zoneId: move.old_zone_id, expiresAt: until });
    await repo.recordStep(env, move.id, "redirect", { detail: `until ${until}` });
  }

  const STEPS = [["new_route", stepNewRoute], ["check_new_host", stepCheck], ["switch", stepSwitch], ["redeploy", stepRedeploy], ["redirect", stepRedirect]];

  /** Runs whatever is left. Safe to call again after a failure. */
  async function run(env, moveId) {
    let move = await repo.getMove(env, moveId);
    if (!move) return fail("not_found", 404);
    for (const [key, fn] of STEPS) {
      move = await repo.getMove(env, moveId);
      if (move.steps[key]) continue;
      try { await fn(env, move); }
      catch (err) {
        await repo.setState(env, moveId, "failed", { error: `${key}: ${safeMessage(err)}` });
        return { ok: false, error: "move_failed", status: 502, step: key, detail: safeMessage(err), moveId, state: "failed", move: await repo.getMove(env, moveId) };
      }
    }
    move = await repo.getMove(env, moveId);
    if (move.redirect_days === 0) await repo.setState(env, moveId, "completed");
    else await repo.setState(env, moveId, "redirecting", { redirectUntil: new Date(Date.now() + move.redirect_days * 86400000).toISOString() });
    return { ok: true, moveId, state: (await repo.getMove(env, moveId)).state, move: await repo.getMove(env, moveId) };
  }

  async function resume(env, moveId) {
    const move = await repo.getMove(env, moveId);
    if (!move) return fail("not_found", 404);
    if (move.state !== "failed") return fail("not_resumable", 409, { detail: `The move is ${move.state}.` });
    await repo.setState(env, moveId, "running");
    return run(env, moveId);
  }

  /** Puts everything back, in the order that keeps the site reachable. Works from 'failed' or 'redirecting'. */
  async function rollback(env, moveId) {
    const move = await repo.getMove(env, moveId);
    if (!move) return fail("not_found", 404);
    if (!["failed", "redirecting"].includes(move.state)) return fail("not_rollbackable", 409, { detail: `The move is ${move.state}.` });
    const errors = [];
    const attempt = async (label, fn) => { try { await fn(); } catch (err) { errors.push(`${label}: ${safeMessage(err)}`); } };
    const site = await repo.getSiteWithTenant(env, move.site_id);

    if (move.steps.switch) {
      // 1. the old host serves the site again (recreating the route if the redirect period already removed it)
      let oldRouteId = move.old_route_id;
      await attempt("restore old route", async () => { oldRouteId = (await infra.ensureWorkerRoute(env, { pattern: `${move.old_host}/*`, workerName: move.worker_name, zoneId: move.old_zone_id })).routeId; });
      if (errors.length) return { ok: false, error: "rollback_incomplete", status: 502, detail: errors.join("; "), moveId };
      // 2. registry, site row and route row go back in one batch
      await repo.revertSwitch(env, { siteId: site.id, tenantId: site.tenant_id, host: move.old_host, domainId: move.from_domain_id, setPrimary: move.update_primary, route: { provider: infra.PROVIDER_NAME, routeId: oldRouteId, zoneId: move.old_zone_id } });
      await repo.deleteRedirect(env, move.old_host);
      if (move.update_primary) await attempt("redeploy", async () => { const r = await redeploy(env, move.site_id); if (!r?.ok) throw new Error(r?.error || "redeploy did not start"); });
    }
    // 3. only now is the new host's route removed
    if (move.new_route_id) await attempt("remove new route", async () => { try { await infra.deleteWorkerRoute(env, move.new_route_id, { zoneId: move.new_zone_id }); } catch (err) { if (!/not found|10007|does not exist/i.test(String(err.message))) throw err; } });
    await repo.setState(env, moveId, "rolled_back", { error: errors.length ? errors.join("; ") : null });
    return errors.length ? { ok: true, moveId, state: "rolled_back", warnings: errors } : { ok: true, moveId, state: "rolled_back" };
  }

  /** Daily: remove the old routes of redirects whose time is up. A failed delete is retried next run. */
  async function sweepExpiredRedirects(env) {
    let removed = 0; const failed = [];
    for (const r of await repo.listExpiredRedirects(env)) {
      try {
        try { await infra.deleteWorkerRoute(env, r.route_id, { zoneId: r.zone_id }); } catch (err) { if (!/not found|10007|does not exist/i.test(String(err.message))) throw err; }
        await repo.deleteRedirect(env, r.old_host);
        await repo.setState(env, r.move_id, "completed");
        removed += 1;
      } catch (err) { failed.push({ host: r.old_host, error: safeMessage(err) }); }
    }
    return { removed, failed };
  }

  return { preview, start, run, resume, rollback, sweepExpiredRedirects };
}

/** For the request path: where the old host redirects to, or null. Method is kept for non-GET (308). */
export async function redirectResponseFor(env, request) {
  const url = new URL(request.url);
  const hit = await repo.findRedirect(env, url.hostname.toLowerCase());
  if (!hit) return null;
  const target = `https://${hit.new_host}${url.pathname}${url.search}`;
  return new Response(null, { status: ["GET", "HEAD"].includes(request.method.toUpperCase()) ? 301 : 308, headers: { Location: target, "Cache-Control": "public, max-age=300" } });
}

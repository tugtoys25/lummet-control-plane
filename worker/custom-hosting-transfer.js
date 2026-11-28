// =====================================================
// MOVING AN EXISTING SITE INTO THE CUSTOMER'S OWN CLOUDFLARE ACCOUNT
//
// Job type `site_hosting_transfer` (resumable, run by job-runner.js like every other job). The site keeps serving from Lummet
// until the very last step, so a move that fails or is cancelled leaves the site exactly as it was.
//
//   validate          the site, the account and the destination are still usable
//   create_resources  D1, KV and R2 in the customer's account (ids kept on the transfer row: a retry never creates twice)
//   copy_media        every R2 object, page by page (cursor kept)
//   copy_kv           every KV key (cursor kept)
//   deploy_target     the site's current release uploaded to the customer's account with the NEW resources bound, workers.dev
//                     (and the custom domain) attached
//   cutover           the short final window, in this order, all in one resumable step:
//                       0. guard: media files too large to copy automatically stop the move unless the customer confirmed
//                          they are not carried over
//                       1. freeze: the site is put into maintenance (signed access state, refreshed every slice) so nothing
//                          can be written any more
//                       2. database: D1 export from Lummet -> import into the customer's (bookmarks kept)
//                       3. delta: media and cache written since the first pass are copied again
//                       4. verify: the copy in the customer's account answers its health check WITH the imported data
//                       5. switch: the site's records point at the customer's account; Lummet's Worker is removed; the old
//                          address is redirected (route repointed to the control plane) for CUSTOM_HOSTING_REDIRECT_DAYS and
//                          its label stays held. The Lummet D1 / KV / R2 copy is KEPT until the customer removes it.
//                     A failure at any point un-freezes the site (it keeps serving from Lummet, untouched) and the next
//                     attempt starts the window again from a fresh database.
//
// Copy steps work in bounded slices (time and subrequest budget). When a slice runs out, the job is re-queued and the next run
// carries on from the saved cursor. Writes made before the freeze are covered by the delta pass; nothing can be written after
// the freeze. If a worker dies while frozen, the signed maintenance state expires by itself within minutes and the site serves again.
// =====================================================
import * as repo from "./repositories/custom-hosting.js";
import * as teardownRepo from "./repositories/site-teardown.js";
import * as siteResources from "./repositories/site-resources.js";
import * as cloudflareProvider from "./infra-cloudflare.js";
import * as jobsModule from "./jobs.js";
import * as sites from "./sites.js";
import * as tenantTemplate from "./tenant-template.js";
import * as releaseRepo from "./repositories/tenant-releases.js";
import { lineProfile } from "./template-lines.js";
import { buildSiteBindings } from "./site-bindings.js";
import { computeResourceNames } from "./provisioning.js";
import { routeZoneId } from "./repositories/site-resources.js";
import * as customHosting from "./custom-hosting.js";
import * as siteAccess from "./site-access.js";

export const JOB_TYPE = "site_hosting_transfer";
export const TRANSFER_STEPS = ["validate", "create_resources", "copy_media", "copy_kv", "deploy_target", "cutover"];
const LEASE_MS = 90_000;
const DEFAULT_BUDGET_MS = 20_000;
const DEFAULT_SUBREQUESTS = 400;
const MAX_OBJECT_BYTES = 95 * 1024 * 1024;   // a Worker holds the object in memory while copying it
const MAX_DUMP_BYTES = 100 * 1024 * 1024;
const MAX_SKIPPED_LISTED = 50;

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (_) { return d; } };
const notFound = (e) => e?.httpStatus === 404 || /not\s*found|does\s*not\s*exist|no\s*such/i.test(String(e?.message || e));

class Paused extends Error { constructor() { super("paused"); this.paused = true; } }

/** Puts the site into (or out of) maintenance with the signed access state the control plane already uses for suspensions. */
const defaultAccess = {
  async freeze(env, siteId) {
    const q = await siteAccess.enqueueSiteAccessPush(env, siteId, "suspended", "site_move_freeze");
    if (q.skipped) throw new Error("the site has no running deployment to put into maintenance");
    await siteAccess.processSiteAccessPushes(env, { limit: 10 });
    const row = await repo.accessPushStatus(env, siteId, q.generation);
    if (row?.status !== "succeeded") throw new Error(`the site could not be put into maintenance for the final copy (${row?.last_error || row?.status || "no answer"}); nothing was changed`);
  },
  async unfreeze(env, siteId) {
    const q = await siteAccess.enqueueSiteAccessPush(env, siteId, "serving", "site_move_unfreeze");
    if (!q.skipped) await siteAccess.processSiteAccessPushes(env, { limit: 10 }).catch(() => {});   // a push that fails here is retried by the tick
  }
};

const redirectDays = (env) => { const n = Number(env?.CUSTOM_HOSTING_REDIRECT_DAYS); return Number.isFinite(n) && n >= 0 && n <= 365 ? Math.floor(n) : 90; };
const selfWorker = (env) => env.CF_SELF_WORKER_NAME || "lummet-control-plane";

export function createTransferService(infra, { templateService = tenantTemplate, access = defaultAccess } = {}) {
  /** Starts a move. Every check that can fail is done before anything is written. The caller dispatches the job. */
  async function startTransfer(env, { organizationId, siteId, choice, actorUserId }) {
    const site = await sites.getSite(env, siteId);
    if (!site || site.organization_id !== organizationId) return { ok: false, status: 404, error: "site_not_found" };
    if (site.status !== "active" || !site.tenant_id) return { ok: false, status: 409, error: "site_not_active", message: "Only a live site can be moved." };
    if (await repo.getSiteHosting(env, siteId)) return { ok: false, status: 409, error: "site_already_custom_hosted" };
    if (await repo.openTransferForSite(env, siteId)) return { ok: false, status: 409, error: "transfer_already_running" };
    if (await repo.countLummetDomains(env, siteId)) return { ok: false, status: 409, error: "remove_custom_domains_first", message: "Remove the custom domains connected to this site on Lummet first; you then connect them in your own Cloudflare account." };
    if (await repo.inflightDeploymentFor(env, siteId)) return { ok: false, status: 409, error: "deployment_in_progress" };
    for (const t of ["d1", "kv", "r2", "worker"]) {
      if (!(await siteResources.findActiveResource(env, siteId, t))) return { ok: false, status: 409, error: "site_resources_incomplete", missing: t };
    }
    let planned;
    try { planned = await customHosting.planHosting(env, { organizationId, choice, infra, exceptSiteId: siteId }); }
    catch (e) { if (e instanceof customHosting.HostingError) return { ok: false, status: e.status, error: e.code, message: e.message }; throw e; }
    if (!planned.ok) return planned;

    const id = crypto.randomUUID();
    // The hosting row (status 'transferring') reserves the hostname; until the switch every hook treats the site as Lummet-hosted.
    try {
      await repo.insertSiteHosting(env, { siteId, organizationId, accountRef: planned.plan.accountRef, status: "transferring", landing: planned.plan.landing, hostname: planned.plan.hostname, zoneId: planned.plan.zoneId, zoneName: planned.plan.zoneName });
    } catch (e) {
      if (/UNIQUE|constraint/i.test(String(e?.message))) return { ok: false, status: 409, error: "hostname_taken" };
      throw e;
    }
    const job = await jobsModule.createJob(env, { type: JOB_TYPE, organizationId, siteId, createdBy: actorUserId, actorType: "customer_user", stepKeys: TRANSFER_STEPS, payload: { transferId: id } });
    await repo.insertTransfer(env, { id, siteId, organizationId, accountRef: planned.plan.accountRef, jobId: job.jobId, landing: planned.plan.landing, hostname: planned.plan.hostname, zoneId: planned.plan.zoneId, zoneName: planned.plan.zoneName, sourceHost: site.primary_domain, requestedBy: actorUserId });
    return { ok: true, status: 202, transferId: id, jobId: job.jobId };
  }

  /** Runs (resumes) a move until it finishes, fails, or uses up this run's budget (then it is re-queued). */
  async function runJob(env, jobId, { budgetMs = Number(env.CUSTOM_HOSTING_TRANSFER_BUDGET_MS) || DEFAULT_BUDGET_MS, maxSubrequests = DEFAULT_SUBREQUESTS, now = () => Date.now() } = {}) {
    const job = await jobsModule.getJob(env, jobId);
    if (!job) return { ok: false, status: 404, error: "job_not_found" };
    if (job.type !== JOB_TYPE) return { ok: false, status: 409, error: "not_a_transfer_job" };
    if (job.status === "success") return { ok: true, alreadyDone: true };
    if (!["queued", "running", "failed"].includes(job.status)) return { ok: false, status: 409, error: `cannot run a job in status ${job.status}` };
    const transfer = await repo.getTransferByJob(env, jobId);
    if (!transfer) { await jobsModule.markJobFailed(env, jobId, "transfer record missing"); return { ok: false, status: 404, error: "transfer_not_found" }; }
    if (["completed", "cancelled"].includes(transfer.status)) return { ok: true, alreadyDone: true };
    const started = now();
    if (!(await repo.claimTransferLease(env, transfer.id, started, LEASE_MS))) return { ok: true, busy: true };

    const budget = { deadline: started + budgetMs, left: maxSubrequests };
    const spend = (n = 1) => { budget.left -= n; if (budget.left <= 0 || now() >= budget.deadline) throw new Paused(); };
    const state = { transfer, target: parse(transfer.target_resources, {}), progress: parse(transfer.progress, {}) };
    const save = () => repo.patchTransfer(env, transfer.id, { target_resources: state.target, progress: state.progress });

    await jobsModule.markJobRunning(env, jobId);
    await repo.patchTransfer(env, transfer.id, { status: "running", error_message: null });
    try {
      const site = await sites.getSite(env, transfer.site_id);
      if (!site || site.status !== "active") throw new Error(`the site is ${site?.status || "gone"}; only a live site can be moved`);
      const ctx = await customHosting.contextForSite(env, site, { includeTransferring: true });
      if (!ctx) throw new Error("the destination was removed");
      const names = computeResourceNames(site, env);

      for (const step of job.steps) {
        if (step.status === "success" || step.status === "skipped") continue;
        if (step.status !== "running") await jobsModule.startStep(env, jobId, step.step_key);
        const output = await STEPS[step.step_key]({ env, site, ctx, names, state, spend, save, transfer });
        await save();
        await jobsModule.completeStep(env, jobId, step.step_key, output || null);
      }
      await repo.patchTransfer(env, transfer.id, { status: "completed", completed_at: new Date().toISOString(), lease_until: null });
      await jobsModule.markJobSuccess(env, jobId, { transferId: transfer.id, host: state.progress.newHost || null });
      return { ok: true, completed: true };
    } catch (error) {
      await save().catch(() => {});
      if (error?.paused) {
        await repo.requeueJob(env, jobId);
        await repo.releaseTransferLease(env, transfer.id);
        await jobsModule.logJob(env, jobId, "info", "move paused after this slice; it continues on the next run");
        if (env.JOB_QUEUE && typeof env.JOB_QUEUE.send === "function") { try { await env.JOB_QUEUE.send({ kind: "run", jobId }); } catch (_) { /* the sweep starts it */ } }
        return { ok: true, paused: true };
      }
      const message = String(error?.message || error).slice(0, 500);
      const running = (await jobsModule.getJob(env, jobId))?.steps.find((s) => s.status === "running");
      if (running) await jobsModule.failStep(env, jobId, running.step_key, message);
      await jobsModule.markJobFailed(env, jobId, message);
      await repo.patchTransfer(env, transfer.id, { status: "failed", error_message: message, lease_until: null });
      return { ok: false, status: 502, error: message };
    }
  }

  const STEPS = {
    async validate({ env, ctx }) {
      if (ctx.account.status !== "verified") throw new Error("the Cloudflare account has not passed its permission check");
      if (!ctx.account.workers_subdomain) throw new Error("the Cloudflare account has no workers.dev subdomain");
      return { account: ctx.account.label, landing: ctx.hosting.landing, hostname: ctx.hosting.hostname || null };
    },

    async create_resources({ env, ctx, names, state, spend, save }) {
      const t = state.target;
      if (!t.d1) { spend(); const r = await infra.createDatabase(ctx.cfEnv, { name: names.d1Name }); t.d1 = { id: r.resourceId, name: names.d1Name }; await save(); }
      if (!t.kv) { spend(); const r = await infra.createKVNamespace(ctx.cfEnv, { title: names.kvTitle }); t.kv = { id: r.resourceId, name: names.kvTitle }; await save(); }
      if (!t.r2) {
        spend();
        try { const r = await infra.createR2Bucket(ctx.cfEnv, { name: names.r2Name }); t.r2 = { id: r.resourceId, name: names.r2Name }; }
        catch (e) {
          if (e?.cfCode === 10042 || /enable r2/i.test(String(e?.message))) throw new Error("R2 is not enabled on your Cloudflare account: subscribe to R2 in the Cloudflare dashboard, then retry the move");
          throw e;
        }
        await save();
      }
      return { d1: t.d1.name, kv: t.kv.name, r2: t.r2.name };
    },

    async copy_media(a) {
      a.state.progress.r2Started ||= Date.now();
      return copyMedia(a, "r2", null);
    },

    async copy_kv(a) { return copyKv(a, "kv"); },

    async deploy_target({ env, site, ctx, names, state, spend }) {
      spend(6);
      const release = site.app_version ? await templateService.getReleaseByVersion(env, site.app_version) : await templateService.getCurrentReleaseForSite(env, site.id);
      if (!release?.ok) throw new Error(`the site's release ${site.app_version || ""} could not be read`);
      const line = await releaseRepo.lineOfSite(env, site.id);
      const profile = lineProfile(line);
      const host = ctx.host(names.workerName);
      const assets = release.assets || null;
      let bindings = await buildSiteBindings(env, {
        site, deploymentId: `transfer-${state.transfer.id}`, host, hasAssets: !!assets, line,
        resources: { d1: { resource_id: state.target.d1.id }, kv: { resource_id: state.target.kv.id }, r2: { resource_id: state.target.r2.id } }
      });
      bindings = (await customHosting.adaptBindings(infra, env, ctx, bindings, { line, host, workerName: names.workerName, r2BucketName: state.target.r2.id })).bindings;
      await infra.uploadWorkerScript(ctx.cfEnv, {
        workerName: names.workerName, scriptContent: release.scriptContent, bindings, profile, assetsConfig: release.assetsConfig || null,
        assets: assets ? { manifest: assets, readAsset: (hash) => templateService.readAsset(env, hash) } : null
      });
      state.target.worker = { name: names.workerName, version: release.version };
      const routing = await customHosting.applyRouting(infra, env, ctx, { workerName: names.workerName });
      try { await infra.setWorkerSchedule(ctx.cfEnv, { workerName: names.workerName, crons: [...profile.crons] }); } catch (_) { /* reported by the next deploy */ }
      state.progress.newHost = host;
      state.progress.healthUrl = customHosting.healthUrl(ctx, names.workerName, profile.healthPath);
      // The copy answers its health check only after the database is in (cutover, verify): an empty database proves nothing.
      return { version: release.version, url: state.progress.healthUrl, ...routing };
    },

    async cutover(a) {
      const { env, site, ctx, names, state, spend, save, transfer } = a;
      const c = (state.progress.cutover ||= { phase: "prepare" });
      const fail = async (error) => {
        // Back to a clean start: the site serves from Lummet again, and the half-filled database in the customer's account is
        // thrown away at the next attempt (an import never runs on top of rows).
        if (state.progress.frozen) { try { await access.unfreeze(env, site.id); } catch (_) { /* retried by the tick */ } }
        state.progress.frozen = false; await repo.patchTransfer(env, transfer.id, { frozen_at: null }).catch(() => {});
        if (state.progress.d1) state.progress.dirtyDatabase = true;
        state.progress.d1 = null; state.progress.r2b = null; state.progress.kvb = null; state.progress.cutover = null;
        await save().catch(() => {});
        throw error;
      };
      try {
        if (c.phase === "prepare") {
          const fresh = await repo.getTransfer(env, transfer.id);
          const skipped = state.progress.r2?.skippedCount || 0;
          if (skipped > 0 && !fresh?.confirm_skipped) {
            const e = new Error(`${skipped} media file(s) are above ${MAX_OBJECT_BYTES / 1048576} MB and cannot be copied automatically (${(state.progress.r2.skipped || []).slice(0, 5).map((o) => o.key).join(", ")}${skipped > 5 ? ", ..." : ""}). The site was not touched. Copy them to the new bucket yourself, then confirm to continue (they will not exist in the new copy until you do), or cancel the move.`);
            e.needsConfirmation = true;
            throw e;
          }
          if (state.progress.dirtyDatabase) {
            // A previous window failed after the import started: new database, and the Worker is bound to it again.
            spend(8);
            try { await infra.deleteDatabase(ctx.cfEnv, state.target.d1.id); } catch (e) { if (!notFound(e)) throw e; }
            const r = await infra.createDatabase(ctx.cfEnv, { name: names.d1Name });
            state.target.d1 = { id: r.resourceId, name: names.d1Name };
            state.progress.dirtyDatabase = false;
            await save();
            await STEPS.deploy_target(a);
          }
          c.phase = "freeze"; await save();
        }
        if (c.phase === "freeze" || state.progress.frozen) {
          spend();
          await access.freeze(env, site.id);                       // also refreshes the signed state on every slice
          if (!state.progress.frozen) { state.progress.frozen = true; await repo.patchTransfer(env, transfer.id, { frozen_at: new Date().toISOString() }); }
          if (c.phase === "freeze") { c.phase = "database"; await save(); }
        }
        if (c.phase === "database") { await copyDatabase(a); c.phase = "delta"; await save(); }
        if (c.phase === "delta") {
          // Everything written to media since the first pass started (a minute of margin), and the whole cache again (idempotent).
          await copyMedia(a, "r2b", (state.progress.r2Started || 0) - 60_000);
          await copyKv(a, "kvb");
          c.phase = "verify"; await save();
        }
        if (c.phase === "verify") {
          spend();
          const url = state.progress.healthUrl || customHosting.healthUrl(ctx, names.workerName, "/");
          const health = await infra.checkHealth(ctx.cfEnv, { url });
          if (!health.ok) throw new Error(`the copy in your account did not answer at ${url} with the imported data (status ${health.statusCode ?? "unreachable"}); the site keeps running on Lummet`);
          c.phase = "switch"; await save();
        }
        if (c.phase === "switch") {
          const out = await switchOver(a);
          state.progress.frozen = false; c.phase = "done";
          await repo.patchTransfer(env, transfer.id, { frozen_at: null });
          await save();
          return out;
        }
        return { phase: c.phase };
      } catch (e) {
        if (e?.paused) throw e;                    // frozen and mid-window: the next slice continues
        return fail(e);
      }
    }
  };

  /** Media copy, in slices. `key` names the progress record; `since` (ms epoch) limits a delta pass to objects modified after it. */
  async function copyMedia({ env, site, ctx, state, spend, save }, key, since) {
    const src = await siteResources.findActiveResource(env, site.id, "r2");
    const p = (state.progress[key] ||= { cursor: null, index: 0, copied: 0, bytes: 0, skipped: [], skippedCount: 0, done: false });
    while (!p.done) {
      spend();
      const page = await infra.listR2Objects(env, { bucket: src.resource_id, cursor: p.cursor, perPage: 500 });
      for (; p.index < page.objects.length; p.index++) {
        const o = page.objects[p.index];
        if (since != null && o.lastModified) { const t = Date.parse(o.lastModified); if (Number.isFinite(t) && t < since) continue; }
        if (o.size > MAX_OBJECT_BYTES) {
          if (key === "r2") { p.skippedCount++; if (p.skipped.length < MAX_SKIPPED_LISTED) p.skipped.push({ key: o.key, size: o.size }); }
          continue;
        }
        spend(2);
        let obj;
        try { obj = await infra.getR2Object(env, { bucket: src.resource_id, key: o.key }); }
        catch (e) { if (notFound(e)) continue; throw e; }   // deleted since the listing
        await infra.putR2Object(ctx.cfEnv, { bucket: state.target.r2.id, key: o.key, body: obj.body, contentType: obj.contentType || o.contentType || "application/octet-stream" });
        p.copied++; p.bytes += o.size;
        if (p.copied % 25 === 0) await save();
      }
      if (page.cursor) { p.cursor = page.cursor; p.index = 0; await save(); } else p.done = true;
    }
    return { copied: p.copied, bytes: p.bytes, skippedTooLarge: p.skippedCount, skipped: p.skipped.slice(0, 10) };
  }

  async function copyKv({ env, site, ctx, state, spend, save }, key) {
    const src = await siteResources.findActiveResource(env, site.id, "kv");
    const p = (state.progress[key] ||= { cursor: null, index: 0, copied: 0, done: false });
    while (!p.done) {
      spend();
      const page = await infra.listKvKeys(env, { namespaceId: src.resource_id, cursor: p.cursor, limit: 1000 });
      // Chunks of up to 100 keys: read every value, then one bulk write. p.index only moves after a chunk is written,
      // so a pause in the middle of a chunk re-reads that chunk next time (bulk writes are idempotent).
      while (p.index < page.keys.length) {
        const chunk = page.keys.slice(p.index, p.index + 100);
        const entries = [];
        for (const k of chunk) {
          if (k.expiration && k.expiration * 1000 < Date.now() + 60_000) continue;   // about to expire: KV refuses it, and it is gone anyway
          spend();
          let value;
          try { value = await infra.getKvValue(env, { namespaceId: src.resource_id, key: k.name }); } catch (e) { if (notFound(e)) continue; throw e; }
          entries.push({ key: k.name, value: bytesToBase64(value), base64: true, ...(k.expiration ? { expiration: k.expiration } : {}), ...(k.metadata != null ? { metadata: k.metadata } : {}) });
        }
        if (entries.length) { spend(); await infra.putKvBulk(ctx.cfEnv, { namespaceId: state.target.kv.id, entries }); }
        p.copied += entries.length;
        p.index += chunk.length;
        await save();
      }
      if (page.cursor) { p.cursor = page.cursor; p.index = 0; await save(); } else p.done = true;
    }
    return { copied: p.copied };
  }

  async function copyDatabase({ env, site, ctx, state, spend, save }) {
      const src = await siteResources.findActiveResource(env, site.id, "d1");
      const p = (state.progress.d1 ||= { phase: "export", bookmark: null, importBookmark: null, numQueries: null });
      if (p.phase === "export") {
        let r = { status: "active", bookmark: p.bookmark };
        while (r.status !== "complete") {
          spend();
          r = await infra.exportD1Database(env, { databaseId: src.resource_id, bookmark: p.bookmark });
          if (r.status !== "complete") { p.bookmark = r.bookmark; await save(); await new Promise((ok) => setTimeout(ok, Number(env.CUSTOM_HOSTING_POLL_MS ?? 1000))); }
        }
        spend();
        let sql;
        try { sql = await infra.downloadD1Export(env, { signedUrl: r.signedUrl, maxBytes: MAX_DUMP_BYTES }); }
        catch (e) {
          if (e?.tooLarge) throw new Error(`the database export is ${Math.round(e.size / 1048576)} MB, above the ${MAX_DUMP_BYTES / 1048576} MB an automatic move can carry; contact support`);
          throw e;
        }
        spend(3);
        const imp = await infra.importD1Sql(ctx.cfEnv, { databaseId: state.target.d1.id, sql });
        p.phase = imp.status === "complete" ? "done" : "import";
        p.importBookmark = imp.bookmark || null;
        p.numQueries = imp.numQueries ?? null;
        p.exportBytes = sql.length;
        await save();
      }
      while (p.phase === "import") {
        spend();
        const imp = await infra.pollD1Import(ctx.cfEnv, { databaseId: state.target.d1.id, bookmark: p.importBookmark });
        if (imp.status === "complete") { p.phase = "done"; p.numQueries = imp.numQueries ?? null; }
        else { p.importBookmark = imp.bookmark; await save(); await new Promise((ok) => setTimeout(ok, Number(env.CUSTOM_HOSTING_POLL_MS ?? 1000))); }
      }
      return { exportBytes: p.exportBytes || null, numQueries: p.numQueries };
  }

  /** Last step of the window: Lummet stops serving, its old address redirects, the records point at the customer's account. */
  async function switchOver({ env, site, ctx, names, state }) {
    const [d1, kv, r2, worker, route] = await Promise.all(["d1", "kv", "r2", "worker", "route"].map((t) => repo.activeResourceRow(env, site.id, t)));
    // What Lummet had, kept on the transfer so the old copy can be removed later (or restored by staff).
    const source = parse(state.transfer.source_resources, null) || {
      d1: d1 && { id: d1.resource_id, name: d1.resource_name }, kv: kv && { id: kv.resource_id, name: kv.resource_name },
      r2: r2 && { id: r2.resource_id, name: r2.resource_name }, worker: worker && { name: worker.resource_name },
      route: route && { id: route.resource_id, pattern: route.resource_name, zoneId: routeZoneId(route) }
    };
    await repo.patchTransfer(env, state.transfer.id, { source_resources: source });
    const host = state.progress.newHost || ctx.host(names.workerName);
    const days = redirectDays(env);
    const until = new Date(Date.now() + days * 86400000).toISOString();
    // 1. The old Lummet address. Its route is repointed to the control plane, which answers it with a redirect to the new host
    //    (the same mechanism as a platform-domain move: site_host_redirects), until `until`. With 0 days it is removed instead.
    if (route) {
      const zoneId = routeZoneId(route);
      let routeId = null;
      if (days > 0 && host) {
        const r = await infra.ensureWorkerRoute(env, { pattern: route.resource_name, workerName: selfWorker(env), zoneId });
        routeId = r.routeId;
        await repo.saveHostRedirect(env, { oldHost: String(route.resource_name).replace(/\/\*$/, "").toLowerCase(), newHost: host, siteId: site.id, moveId: state.transfer.id, routeId, zoneId, expiresAt: until });
      } else {
        try { await infra.deleteWorkerRoute(env, route.resource_id, { zoneId }); } catch (e) { if (!notFound(e)) throw e; }
      }
      source.redirect = { until: days > 0 ? until : null, routeId };
      await repo.markResourceDeleted(env, site.id, "route");
    }
    // Redirects an earlier platform-domain move left for this site now lead to the new host too (their routes already reach the control plane).
    for (const r of await teardownRepo.redirectsForSite(env, site.id)) {
      if (route && String(route.resource_name).replace(/\/\*$/, "").toLowerCase() === r.old_host) continue;
      if (days > 0 && host && r.route_id) await repo.saveHostRedirect(env, { oldHost: r.old_host, newHost: host, siteId: site.id, moveId: state.transfer.id, routeId: r.route_id, zoneId: r.zone_id || null, expiresAt: until });
      else {
        if (r.route_id) { try { await infra.deleteWorkerRoute(env, r.route_id, { zoneId: r.zone_id || undefined }); } catch (e) { if (!notFound(e)) throw e; } }
        await teardownRepo.deleteRedirect(env, r.old_host);
      }
    }
    const meta = { accountRef: ctx.account.id, movedFrom: "lummet" };
    await repo.switchSiteResources(env, site.id, [
      { type: "d1", resourceId: state.target.d1.id, resourceName: state.target.d1.name, metadata: meta },
      { type: "kv", resourceId: state.target.kv.id, resourceName: state.target.kv.name, metadata: meta },
      { type: "r2", resourceId: state.target.r2.id, resourceName: state.target.r2.name, metadata: meta },
      { type: "worker", resourceId: names.workerName, resourceName: names.workerName, metadata: { ...meta, version: state.target.worker?.version || null } }
    ]);
    await repo.patchSiteHosting(env, site.id, { status: "active", last_error: null });
    await customHosting.applyHostChange(env, site, host);
    // The site's Lummet label (host_label, platform_domain_id) is deliberately KEPT: nobody else can claim the old address while the
    // redirect runs, and it frees only when the site itself is deleted.
    // 2. The old Lummet Worker can no longer be reached; it is removed now. Its data (D1, KV, R2) stays as a safety copy.
    if (source.worker) {
      try { await infra.deleteWorkerScript(env, source.worker.name); source.worker.removed = true; } catch (e) { if (notFound(e)) source.worker.removed = true; }
    }
    await repo.patchTransfer(env, state.transfer.id, { source_resources: source, old_copy_status: "kept" });
    // The new Worker serves normally: make sure no maintenance state from the window is left anywhere.
    try { await access.unfreeze(env, site.id); } catch (_) { /* the tick retries */ }
    return { host, redirectUntil: days > 0 ? until : null, keptLummetCopy: { d1: source.d1?.name || null, kv: source.kv?.name || null, r2: source.r2?.name || null } };
  }

  /** Cancels a move that has not switched yet: what it created in the customer's account is removed, the site is untouched. */
  async function cancelTransfer(env, { organizationId, siteId }) {
    const t = await repo.openTransferForSite(env, siteId) || await repo.latestTransferForSite(env, siteId);
    if (!t || t.organization_id !== organizationId || !["queued", "running", "failed"].includes(t.status)) return { ok: false, status: 404, error: "no_open_transfer" };
    const job = t.job_id ? await jobsModule.getJob(env, t.job_id) : null;
    if (job?.steps?.find((s) => s.step_key === "switch_over" && s.status === "success")) return { ok: false, status: 409, error: "transfer_already_switched" };
    if (!(await repo.claimTransferLease(env, t.id, Date.now(), LEASE_MS))) return { ok: false, status: 409, error: "transfer_busy_try_again" };
    if (t.frozen_at) { try { await access.unfreeze(env, siteId); } catch (_) { /* the tick retries */ } await repo.patchTransfer(env, t.id, { frozen_at: null }); }
    const failures = await removeTargets(env, t);
    if (failures.length) { await repo.releaseTransferLease(env, t.id); return { ok: false, status: 502, error: "cleanup_incomplete", failures }; }
    if (t.job_id) await repo.cancelJob(env, t.job_id);
    await repo.patchTransfer(env, t.id, { status: "cancelled", lease_until: null, completed_at: new Date().toISOString() });
    const h = await repo.getSiteHosting(env, siteId);
    if (h && h.status === "transferring") { await repo.deleteSiteHosting(env, siteId); await repo.deleteSecretRow(env, "site", siteId, "turnstile_secret"); }
    return { ok: true };
  }

  /** The customer accepts that media files above the automatic-copy size are not carried over; a stopped move is queued again. */
  async function confirmSkipped(env, { organizationId, siteId }) {
    const t = await repo.latestTransferForSite(env, siteId);
    if (!t || t.organization_id !== organizationId || !["queued", "running", "failed"].includes(t.status)) return { ok: false, status: 404, error: "no_open_transfer" };
    const progress = parse(t.progress, {});
    if (!(progress.r2?.skippedCount > 0)) return { ok: false, status: 409, error: "nothing_to_confirm", message: "No media file was left out of this move." };
    await repo.patchTransfer(env, t.id, { confirm_skipped: 1, error_message: null });
    if (t.status === "failed" && t.job_id) { return { ok: true, jobId: t.job_id }; }
    return { ok: true, jobId: null };
  }

  const removeTargets = (env, t) => customHosting.removeTransferTargets(infra, env, t);

  /** The customer (or staff) removes the Lummet copy a finished move kept. */
  async function removeOldCopy(env, { organizationId = null, siteId }) {
    const t = await repo.latestTransferForSite(env, siteId);
    if (!t || (organizationId && t.organization_id !== organizationId) || t.status !== "completed") return { ok: false, status: 404, error: "no_completed_transfer" };
    if (t.old_copy_status === "removed") return { ok: true, alreadyRemoved: true };
    const r = await customHosting.removeLummetCopy(infra, env, t);
    return r.ok ? { ok: true } : { ok: false, status: 502, error: "cleanup_incomplete", message: r.error };
  }

  async function transferView(env, siteId) {
    const t = await repo.latestTransferForSite(env, siteId);
    if (!t) return null;
    const job = t.job_id ? await jobsModule.getJob(env, t.job_id) : null;
    const progress = parse(t.progress, {});
    return {
      id: t.id, status: t.status, landing: t.landing, hostname: t.hostname, sourceHost: t.source_host, oldCopy: t.old_copy_status,
      error: t.error_message, createdAt: t.created_at, completedAt: t.completed_at, jobId: t.job_id,
      steps: job ? job.steps.map((s) => ({ key: s.step_key, status: s.status, error: s.error_message || null })) : [],
      copied: { media: progress.r2?.copied || 0, mediaBytes: progress.r2?.bytes || 0, mediaSkippedTooLarge: progress.r2?.skippedCount || 0, kv: progress.kv?.copied || 0, database: progress.d1?.phase === "done" },
      newHost: progress.newHost || null,
      paused: t.status === "running" && job?.status === "queued",
      frozen: !!t.frozen_at,
      needsConfirmation: (t.status === "failed" && progress.r2?.skippedCount > 0 && !t.confirm_skipped) || false,
      skippedMedia: (progress.r2?.skipped || []).slice(0, 20),
      redirectUntil: parse(t.source_resources, {})?.redirect?.until || null
    };
  }

  return { startTransfer, runJob, cancelTransfer, confirmSkipped, removeOldCopy, transferView, removeTargets, TRANSFER_STEPS };
}

function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const infraRef = { current: cloudflareProvider };
const infraProxy = new Proxy({}, { get: (_t, key) => infraRef.current[key] });
/** Route-level tests swap the provider (same pattern as deployments.js). */
export function __setInfraProviderForTests(provider) { infraRef.current = provider || cloudflareProvider; }
/** The provider the customer API and the transfer job use (swappable in route-level tests). */
export const hostingInfra = infraProxy;
export const hostingTransfers = createTransferService(infraProxy);

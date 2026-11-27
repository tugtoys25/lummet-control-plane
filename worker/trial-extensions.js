// =====================================================
// ONE FREE TRIAL PER ORGANIZATION, TRIAL EXTENSIONS, AND PAUSING SITES WHEN A TRIAL ENDS
//
//  * A trial is never restarted. When it has ended the customer can only ask for an extension (requestExtension).
//  * Staff approve with a number of days (decideExtension approve) or decline with a comment. Approval gives a new local trial of
//    that length and puts the customer's paused sites back live. The customer is told in their dashboard and by email.
//  * BILLING_TRIAL_END_SITES=on: sites are paused (status suspended, reason TRIAL_END_SUSPENSION_REASON) once the trial has ended and
//    nothing paid exists. Paying (billing.js) or an approved extension restores them; the sweep also self-heals every tick.
// Only sites this module paused are ever restored here: a site staff or the customer suspended stays as it is.
// =====================================================
import { billingConfig } from "./billing-config.js";
import { resolveAccess } from "./access.js";
import { transitionSiteStatus } from "./sites.js";
import { enqueueSiteAccessPush } from "./site-access.js";
import { TRIAL_END_SUSPENSION_REASON, applySiteGate } from "./billing-lifecycle.js";
import * as repo from "./repositories/trial-extensions.js";
import * as announcements from "./announcements.js";

export { TRIAL_END_SUSPENSION_REASON };
export const MAX_GRANT_DAYS = 90;
export const MAX_MESSAGE = 1000;
const DAY = 86400000;

export const orgHadTrial = (env, organizationId) => repo.orgHadTrial(env, organizationId);

const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);

/** What the customer's billing page needs: may they ask, is a request open, what happened to the last one. */
export async function extensionStateFor(env, organizationId) {
  const [hadTrial, access, pending, last] = await Promise.all([
    repo.orgHadTrial(env, organizationId),
    resolveAccess(env, organizationId).catch(() => null),
    repo.pendingFor(env, organizationId),
    repo.latestFor(env, organizationId)
  ]);
  const ended = !!access && access.state !== "trialing" && access.state !== "active" && access.state !== "past_due" && access.state !== "closed";
  return { hadTrial, trialEnded: hadTrial && ended, pending: pending || null, last: last || null, canRequest: hadTrial && ended && !pending };
}

export async function requestExtension(env, { organizationId, userId, message, wantedDays }) {
  const st = await extensionStateFor(env, organizationId);
  if (!st.hadTrial) return { ok: false, status: 409, error: "no_trial_to_extend" };
  if (!st.trialEnded) return { ok: false, status: 409, error: "trial_still_running" };
  if (st.pending) return { ok: false, status: 409, error: "request_already_pending" };
  const text = clean(message, MAX_MESSAGE);
  if (text.length < 5) return { ok: false, status: 422, error: "message_required" };
  let days = null;
  if (wantedDays != null && wantedDays !== "") {
    days = Number(wantedDays);
    if (!Number.isInteger(days) || days < 1 || days > MAX_GRANT_DAYS) return { ok: false, status: 422, error: "invalid_days" };
  }
  const id = crypto.randomUUID();
  try { await repo.insertRequest(env, { id, organizationId, requestedBy: userId, message: text, wantedDays: days }); }
  catch (e) { if (/UNIQUE/i.test(String(e?.message))) return { ok: false, status: 409, error: "request_already_pending" }; throw e; }
  return { ok: true, id };
}

async function tell(env, staffId, organizationId, subject, body) {
  try { await announcements.send(env, { staff: { id: String(staffId || "system") }, subject, body, format: "text", kind: "organization", ref: organizationId, channels: ["dashboard", "email"] }); }
  catch (e) { console.error(JSON.stringify({ msg: "trial_extension_notice_failed", organizationId, error: e?.message || String(e) })); }
}

/** decision: "approve" (days 1..90) or "decline" (a comment is required). */
export async function decideExtension(env, id, { decision, staffId, days, comment, now = Date.now() }) {
  const req = await repo.getRequest(env, id);
  if (!req) return { ok: false, status: 404, error: "not_found" };
  if (req.status !== "pending") return { ok: false, status: 409, error: "already_decided" };
  const note = clean(comment, MAX_MESSAGE);

  if (decision === "decline") {
    if (note.length < 3) return { ok: false, status: 422, error: "comment_required" };
    if (!(await repo.decide(env, id, { status: "declined", decidedBy: staffId, comment: note }))) return { ok: false, status: 409, error: "already_decided" };
    await tell(env, staffId, req.organization_id, "Your trial extension request", `We could not extend your trial this time.\n\n${note}\n\nYou can choose a plan any time in Billing to bring your sites back online.`);
    return { ok: true, status: "declined" };
  }
  if (decision !== "approve") return { ok: false, status: 422, error: "invalid_decision" };
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > MAX_GRANT_DAYS) return { ok: false, status: 422, error: "invalid_days" };

  const last = await repo.latestSubscription(env, req.organization_id);
  if (!last) return { ok: false, status: 409, error: "no_subscription" };
  const subId = crypto.randomUUID();
  const endsAt = new Date(now + n * DAY).toISOString();
  // Claim the request first: two staff approving at once cannot both create a trial.
  if (!(await repo.decide(env, id, { status: "approved", decidedBy: staffId, days: n, comment: note, grantedSubscriptionId: subId }))) return { ok: false, status: 409, error: "already_decided" };
  await repo.expireLapsedLocalTrials(env, req.organization_id);
  await repo.insertLocalTrial(env, { id: subId, organizationId: req.organization_id, planId: last.plan_id, trialEndsAt: endsAt });
  const gate = await applySiteGate(env, req.organization_id, "trialing").catch(() => ({ restored: 0 }));
  await tell(env, staffId, req.organization_id, "Your trial has been extended", `Good news: your trial now runs for ${n} more day${n === 1 ? "" : "s"}, until ${endsAt.slice(0, 10)}.${note ? `\n\n${note}` : ""}\n\nYour sites are back online. Choose a plan in Billing before then to keep them live.`);
  return { ok: true, status: "approved", days: n, trialEndsAt: endsAt, sitesRestored: gate.restored || 0 };
}

// ---------- pausing and restoring sites ----------
async function pauseOrg(env, organizationId) {
  let n = 0;
  for (const siteId of await repo.activeSiteIds(env, organizationId)) {
    const r = await transitionSiteStatus(env, siteId, "suspended", { reason: TRIAL_END_SUSPENSION_REASON, actorType: "system" });
    if (!r.ok) continue;
    try { await enqueueSiteAccessPush(env, siteId, "suspended", TRIAL_END_SUSPENSION_REASON); n += 1; }
    catch (e) { await transitionSiteStatus(env, siteId, "active", { reason: "site state push enqueue failed; rolled back", actorType: "system" }); throw e; }
  }
  return n;
}

/** Runs from the billing sweep. Off unless BILLING_TRIAL_END_SITES=on. Pauses sites of ended trials, restores those whose customer paid or was extended. */
export async function enforceTrialEnd(env, now = Date.now(), { cfg } = {}) {
  const config = cfg || billingConfig(env);
  const out = { paused: 0, restored: 0 };
  if (!config.trialEndSuspend) return out;
  for (const org of await repo.orgsToPause(env, new Date(now).toISOString())) {
    try {
      const access = await resolveAccess(env, org, now, { cfg: config });
      // Only a real ended trial: "no subscription" (never trialed) and ladder states handled elsewhere are left alone.
      if (access.state === "trial_expired" && access.reason !== "no subscription" && /trial ended/.test(access.reason)) out.paused += await pauseOrg(env, org);
    } catch (e) { console.error(JSON.stringify({ msg: "trial_end_pause_failed", organizationId: org, error: e?.message || String(e) })); }
  }
  for (const org of await repo.orgsWithPausedSites(env, TRIAL_END_SUSPENSION_REASON)) {
    try {
      const access = await resolveAccess(env, org, now, { cfg: config });
      if (access.state === "trialing" || access.state === "active" || access.state === "past_due") out.restored += (await applySiteGate(env, org, access.state)).restored || 0;
    } catch (e) { console.error(JSON.stringify({ msg: "trial_end_restore_failed", organizationId: org, error: e?.message || String(e) })); }
  }
  return out;
}

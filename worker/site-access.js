import * as sites from "./sites.js";
import * as client from "./client.js";
import * as repo from "./repositories/site-access.js";

export async function enqueueSiteAccessPush(env, siteId, state, reason="site_access_change") {
  if (!['serving','suspended','closed'].includes(state)) throw new Error('invalid_site_access_state');
  const site=await sites.getSite(env,siteId); if(!site) throw new Error('site_not_found');
  if (!site.tenant_id) return { skipped:true, reason:"site_not_provisioned" };
  const generation=await repo.nextGeneration(env,siteId);
  await repo.supersedePending(env,siteId);
  const id=crypto.randomUUID();
  await repo.insertPushJob(env,{id,siteId,generation,state,reason});
  return {id,generation};
}
export async function processSiteAccessPushes(env,{limit=25,now=new Date().toISOString(),repository=repo,siteAdapter=sites,clientAdapter=client,enqueue=enqueueSiteAccessPush}={}) {
  // Keep deny states fresh. Cron runs every five minutes; a signed deny state expires after ten minutes at the tenant edge.
  const refreshCutoff = new Date(Date.parse(now) - 4 * 60 * 1000).toISOString();
  for (const site of await repository.listSuspendedSitesNeedingRefresh(env, refreshCutoff)) {
    if (site.last_job_status === "failed" || site.last_job_status === "pending" || site.last_job_status === "running") continue;
    if (site.last_success_at) { const lastSuccessMs=Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(site.last_success_at)?site.last_success_at:String(site.last_success_at).replace(" ","T")+"Z"); if(Number.isFinite(lastSuccessMs)&&lastSuccessMs>Date.parse(refreshCutoff)) continue; }
    const desired = site.organization_status === "closed" ? "closed" : "suspended";
    await enqueue(env, site.site_id, desired, "scheduled_signed_state_refresh");
  }
  const rows=await repository.listDuePushJobs(env,{now,limit});
  const result={attempted:0,succeeded:0,retrying:0,failed:0};
  for(const job of rows||[]){ result.attempted++; const claim=await repository.claimPushJob(env,job.id); if(!claim.meta?.changes)continue;
    try { const site=await siteAdapter.getSite(env,job.site_id); if(!site?.tenant_id) throw new Error('site_tenant_not_provisioned'); const r=await clientAdapter.pushTenantSiteAccess(env,site.tenant_id,{state:job.desired_state,generation:job.generation,siteId:site.id}); if(!r.ok) throw new Error(r.reason||'tenant_push_failed');
      await repository.markPushSucceeded(env,job.id,r.status); result.succeeded++;
    } catch(e){ const attempts=Number(job.attempts||0)+1, terminal=attempts>=5, delay=Math.min(3600,30*Math.pow(2,attempts-1)); await repository.markPushRetry(env,{id:job.id,attempts,terminal,error:e?.message||e,delaySeconds:delay}); if(terminal){result.failed++;console.error(JSON.stringify({msg:'site_access_push_failed',siteId:job.site_id,jobId:job.id,attempts}));}else result.retrying++; }
  } return result;
}

export async function suspendSite(env, siteId, { reason, actorId, actorType = "lummet_admin" } = {}) {
  const site=await sites.getSite(env,siteId); if(!site) return {ok:false,status:404,error:"site_not_found",reasonCode:"site_not_found"};
  const changed=await sites.transitionSiteStatus(env,siteId,"suspended",{reason,actorType,actorId}); if(!changed.ok)return changed;
  try { await enqueueSiteAccessPush(env,siteId,"suspended",reason||"site_suspended"); } catch(error) { await sites.transitionSiteStatus(env,siteId,"active",{reason:"suspension rolled back because access push could not be queued",actorType:"system"}); throw error; }
  return {ok:true};
}
export async function reactivateSite(env, siteId, { reason, actorId, actorType = "lummet_admin" } = {}) {
  const site=await sites.getSite(env,siteId); if(!site) return {ok:false,status:404,error:"site_not_found",reasonCode:"site_not_found"};
  const changed=await sites.transitionSiteStatus(env,siteId,"active",{reason,actorType,actorId}); if(!changed.ok)return changed;
  try { await enqueueSiteAccessPush(env,siteId,"serving",reason||"site_reactivated"); } catch(error) { await sites.transitionSiteStatus(env,siteId,"suspended",{reason:"reactivation rolled back because access push could not be queued",actorType:"system"}); throw error; }
  return {ok:true};
}

export async function retrySiteAccessPush(env,siteId,{actorId,reason},{siteRepository=repo,enqueue=enqueueSiteAccessPush}={}) {
  if(!String(reason||"").trim())return{ok:false,status:422,error:"reason_required",reasonCode:"reason_required"};
  const site=await siteRepository.siteAccessMetadata(env,siteId);if(!site)return{ok:false,status:404,error:"site_not_found",reasonCode:"site_not_found"};if(!site.tenant_id)return{ok:false,status:409,error:"site_not_provisioned",reasonCode:"site_not_provisioned"};
  const desired=site.organization_status==="closed"?"closed":(site.organization_status==="suspended"||site.status==="suspended")?"suspended":"serving";
  const job=await enqueue(env,siteId,desired,`staff retry by ${actorId||"unknown"}: ${String(reason).trim().slice(0,250)}`);
  return{ok:true,siteId,desiredState:desired,job};
}

export async function bulkReactivateSites(env,{siteIds,actorId,reason},{siteAdapter=sites,enqueue=enqueueSiteAccessPush}={}) {
  if(!Array.isArray(siteIds)||siteIds.length<1||siteIds.length>100) return {ok:false,status:422,error:'invalid_site_ids'};
  if(!String(reason||'').trim()) return {ok:false,status:422,error:'reason_required'};
  const ids=[...new Set(siteIds.map(String))],results=[];
  for(const id of ids){const site=await siteAdapter.getSite(env,id);if(!site||site.status!=='suspended'){results.push({siteId:id,ok:false,reason:'site_not_suspended'});continue;} const changed=await siteAdapter.transitionSiteStatus(env,id,'active',{reason:`staff bulk reactivate: ${String(reason).trim().slice(0,400)}`,actorType:'lummet_admin',actorId});if(!changed.ok){results.push({siteId:id,ok:false,reason:changed.error||'reactivation_failed'});continue;} let pushJob; try { pushJob = await enqueue(env,id,'serving','staff_bulk_reactivate'); } catch (error) { await siteAdapter.transitionSiteStatus(env,id,'suspended',{reason:'bulk reactivation rolled back: push job could not be queued',actorType:'system'}); results.push({siteId:id,ok:false,reason:'push_queue_failed',error:String(error?.message||error).slice(0,300)}); continue; } results.push({siteId:id,ok:true,pushStatus:'queued',pushJob:pushJob||null});}
  return {ok:true,results,reactivated:results.filter(x=>x.ok).length,failed:results.filter(x=>!x.ok).length};
}

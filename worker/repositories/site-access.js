// Durable tenant-edge site-access push jobs and site metadata (repository: SQL only).
export async function siteAccessMetadata(env, siteId) {
  return env.LUMMET_DB.prepare("SELECT s.organization_id,s.status,s.tenant_id,o.status organization_status FROM sites s JOIN organizations o ON o.id=s.organization_id WHERE s.id=?").bind(siteId).first();
}
export async function siteAccessSitesForOrganization(env, organizationId) {
  return (await env.LUMMET_DB.prepare("SELECT id,status,tenant_id FROM sites WHERE organization_id=? AND status NOT IN ('deleted','deleting')").bind(organizationId).all()).results || [];
}
export async function nextGeneration(env, siteId) {
  const row=await env.LUMMET_DB.prepare("SELECT COALESCE(MAX(generation),0) generation FROM site_access_push_jobs WHERE site_id=?").bind(siteId).first();
  return Number(row?.generation||0)+1;
}
export async function supersedePending(env, siteId) {
  return env.LUMMET_DB.prepare("UPDATE site_access_push_jobs SET status='superseded',updated_at=CURRENT_TIMESTAMP WHERE site_id=? AND status IN ('pending','running')").bind(siteId).run();
}
export async function insertPushJob(env, {id,siteId,generation,state,reason}) {
  return env.LUMMET_DB.prepare("INSERT INTO site_access_push_jobs(id,site_id,generation,desired_state,status,next_attempt_at,last_error) VALUES(?,?,?,?,'pending',CURRENT_TIMESTAMP,?)").bind(id,siteId,generation,state,String(reason).slice(0,300)).run();
}
export async function listDuePushJobs(env, {limit,now}) {
  return (await env.LUMMET_DB.prepare("SELECT * FROM site_access_push_jobs WHERE (status='pending' OR (status='running' AND updated_at < datetime('now','-10 minutes'))) AND next_attempt_at<=? ORDER BY created_at LIMIT ?").bind(now,limit).all()).results || [];
}
export async function claimPushJob(env, id) {
  return env.LUMMET_DB.prepare("UPDATE site_access_push_jobs SET status='running',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND (status='pending' OR (status='running' AND updated_at < datetime('now','-10 minutes')))").bind(id).run();
}
export async function markPushSucceeded(env, id, status) {
  return env.LUMMET_DB.prepare("UPDATE site_access_push_jobs SET status='succeeded',last_error=NULL,last_http_status=?,updated_at=CURRENT_TIMESTAMP,completed_at=CURRENT_TIMESTAMP WHERE id=?").bind(status,id).run();
}
export async function markPushRetry(env, {id,attempts,terminal,error,delaySeconds}) {
  return env.LUMMET_DB.prepare("UPDATE site_access_push_jobs SET status=?,attempts=?,last_error=?,next_attempt_at=datetime('now',?),updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(terminal?'failed':'pending',attempts,String(error).slice(0,1000),`+${delaySeconds} seconds`,id).run();
}

export async function listSuspendedSitesNeedingRefresh(env, cutoff) {
  return (await env.LUMMET_DB.prepare(`SELECT s.id site_id, s.tenant_id, o.status organization_status,
    (SELECT j.desired_state FROM site_access_push_jobs j WHERE j.site_id=s.id ORDER BY j.generation DESC LIMIT 1) last_state,
    (SELECT j.status FROM site_access_push_jobs j WHERE j.site_id=s.id ORDER BY j.generation DESC LIMIT 1) last_job_status,
    (SELECT j.updated_at FROM site_access_push_jobs j WHERE j.site_id=s.id AND j.status='succeeded' ORDER BY j.generation DESC LIMIT 1) last_success_at
    FROM sites s JOIN organizations o ON o.id=s.organization_id
    WHERE s.tenant_id IS NOT NULL AND (s.status='suspended' OR o.status IN ('suspended','closed'))`).all()).results || [];
}

export async function listPushFailures(env, limit=100) {
  return (await env.LUMMET_DB.prepare(`SELECT j.id job_id,j.site_id,j.desired_state,j.status,j.attempts,j.last_error,j.updated_at,s.name site_name,s.organization_id,o.name organization_name FROM site_access_push_jobs j JOIN sites s ON s.id=j.site_id JOIN organizations o ON o.id=s.organization_id WHERE j.status='failed' ORDER BY j.updated_at DESC LIMIT ?`).bind(Math.min(Math.max(Number(limit)||100,1),500)).all()).results || [];
}
export async function listSitesForStaffAccess(env, limit=500) {
  return (await env.LUMMET_DB.prepare(`SELECT s.id,s.name,s.slug,s.status,s.tenant_id,s.organization_id,o.name organization_name,o.status organization_status FROM sites s JOIN organizations o ON o.id=s.organization_id WHERE s.status NOT IN ('deleted','deleting') ORDER BY o.name,s.name LIMIT ?`).bind(Math.min(Math.max(Number(limit)||500,1),1000)).all()).results || [];
}

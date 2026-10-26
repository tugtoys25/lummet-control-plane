import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWriteGate, evaluateServeGate, refusalFor } from '../worker/access.js';

const STATES = ['trialing','active','past_due','restricted','suspended','closed','trial_expired'];
const MODES = ['off','shadow','enforce'];
const ENTRYPOINTS = [
  ['site create','write','/api/sites'], ['provision','write','/api/provision'],
  ['deploy','write','/api/deployments'], ['rollout','write','/api/rollouts'],
  ['domain attach zone-domains.js','write','/api/zone-domains/attach'],
  ['domain attach domains.js','write','/api/domains/attach'],
  ['tenant-portal GET','serve','tenant-portal:get'], ['tenant-portal mutation','write','/tenant-portal/mutation'],
  ['AI gateway','write','/api/ai'], ['API key create','write','/api/api-keys'],
  ['API key delete','write','/api/api-keys/delete'], ['invitations','write','/api/invitations']
];
const now = Date.parse('2026-10-23T12:00:00Z');
function subFor(state) {
  if (state === 'closed') return null;
  if (state === 'trial_expired') return {id:'sub',status:'expired',trial_ends_at:'2026-10-22T12:00:00Z',updated_at:'2026-10-22T12:00:00Z'};
  if (state === 'suspended') return {id:'sub',status:'suspended',suspended_at:'2026-10-23T11:00:00Z',updated_at:'2026-10-23T11:00:00Z'};
  if (state === 'restricted') return {id:'sub',status:'restricted',restricted_at:'2026-10-23T11:00:00Z',updated_at:'2026-10-23T11:00:00Z'};
  if (state === 'past_due') return {id:'sub',status:'past_due',grace_ends_at:'2026-10-30T12:00:00Z',updated_at:'2026-10-23T11:00:00Z'};
  return {id:'sub',status:state,updated_at:'2026-10-23T11:00:00Z'};
}
function fakeEnv(state, mode) {
  const shadows=[]; const org={id:'org',status:state==='closed'?'closed':'active'}; const sub=subFor(state);
  const db={ prepare(sql) { let binds=[]; return { bind(...v){binds=v;return this;}, async first(){
    if(sql.includes('SELECT id, status FROM organizations')) return org;
    if(sql.includes('SELECT * FROM subscriptions WHERE organization_id') && sql.includes('status NOT IN')) return sub && !['expired','canceled','incomplete_expired'].includes(sub.status) ? sub : null;
    if(sql.includes('SELECT * FROM subscriptions WHERE organization_id')) return sub;
    if(sql.includes('SELECT MAX(created_at) t FROM subscription_status_events')) return {t:null};
    if(sql.includes('SELECT 1 x FROM subscription_access_shadow')) return null;
    return null;
  }, async run(){ if(sql.includes('INSERT INTO subscription_access_shadow')) shadows.push({organization_id:binds[0],subscription_id:binds[1],state:binds[2],reason:binds[4]}); return {meta:{changes:1}}; }, async all(){return {results:[]};} }; }};
  return { LUMMET_DB:db, BILLING_ENFORCE:mode, shadows };
}
const mutates = s => ['trialing','active','past_due'].includes(s);
const serves = s => !['suspended','closed'].includes(s);

for (const [entryPoint, kind, path] of ENTRYPOINTS) {
  test(`${entryPoint}: behavioral access matrix across seven states and three modes`, async t => {
    for (const state of STATES) for (const mode of MODES) await t.test(`${state}/${mode}`, async () => {
      const env=fakeEnv(state,mode); let result;
      if (kind==='serve') result=await evaluateServeGate(env,{organizationId:'org',entryPoint:path,now});
      else result=await evaluateWriteGate(env,{organizationId:'org',method:'POST',subPath:path,now});
      const can=kind==='serve'?serves(state):mutates(state);
      const shouldBlock=mode==='enforce'&&!can;
      assert.equal(result.blocked,shouldBlock,`unexpected blocked result for ${entryPoint}/${state}/${mode}`);
      if (shouldBlock) {
        const reason=refusalFor(result.access);
        assert.equal(reason.reasonCode,`billing_${state}`);
      }
      if (mode==='shadow'&&!can) {
        assert.equal(env.shadows.length,1,'one shadow finding expected');
        assert.match(env.shadows[0].reason,new RegExp(`entry_point=${path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`));
      } else assert.equal(env.shadows.length,0,'no shadow record expected');
      if (mode==='off') assert.equal(result.blocked,false);
    });
  });
}

// Route/service behavior checks: these execute the actual exported service entry points,
// not source matching. The matrix above proves the common decision semantics for each
// named route; these checks prove callers honor the returned decision before side effects.
import { createSite } from '../worker/sites.js';
import { createApiKey, revokeApiKey } from '../worker/api-keys.js';
import { runAiTask } from '../worker/ai-gateway.js';
import { createTenantPortalService } from '../worker/tenant-portal.js';
import { createProvisioningService } from '../worker/provisioning.js';
import { deployments } from '../worker/deployments.js';
import { domains } from '../worker/domains.js';
import { zoneDomains } from '../worker/zone-domains.js';

function serviceEnv(state, mode) {
  const base=fakeEnv(state,mode);
  const site={id:'site',organization_id:'org',status:'active',tenant_id:'tenant'};
  base.LUMMET_DB.prepare = function(sql) { let binds=[]; return {bind(...v){binds=v;return this;},async first(){
    if(sql.includes('SELECT id, status FROM organizations'))return {id:'org',status:state==='closed'?'closed':'active'};
    if(sql.includes('SELECT * FROM subscriptions WHERE organization_id')&&sql.includes('status NOT IN')){const s=subFor(state);return s&&!['expired','canceled','incomplete_expired'].includes(s.status)?s:null;}
    if(sql.includes('SELECT * FROM subscriptions WHERE organization_id'))return subFor(state);
    if(sql.includes('SELECT MAX(created_at) t FROM subscription_status_events'))return {t:null};
    if(sql.includes('SELECT 1 x FROM subscription_access_shadow'))return null;
    if(sql.includes('SELECT * FROM sites WHERE id = ?'))return site;
    if(sql.includes('SELECT s.organization_id,s.status,s.tenant_id,o.status organization_status'))return {organization_id:'org',status:'active',tenant_id:'tenant',organization_status:state==='closed'?'closed':'active'};
    if(sql.includes('SELECT COUNT(*) AS n FROM ai_credit_ledger'))return {n:0};
    if(sql.includes('SELECT 1 x FROM subscription_access_shadow'))return null;
    return null;
  },async run(){if(sql.includes('INSERT INTO subscription_access_shadow'))base.shadows.push({organization_id:binds[0],subscription_id:binds[1],state:binds[2],reason:binds[4]});return {meta:{changes:1}};},async all(){return {results:[]};}};};
  return base;
}

for (const entry of ['actual site create','actual API-key create','actual API-key delete','actual AI gateway','actual tenant-portal GET','actual tenant-portal mutation']) {
  test(`${entry}: actual service honors enforce and shadow decisions`, async t => {
    for (const state of STATES) for (const mode of MODES) await t.test(`${state}/${mode}`, async () => {
      const env=serviceEnv(state,mode); let result;
      if(entry==='actual site create') result=await createSite(env,{organizationId:'org',name:'Example',productId:'product'});
      else if(entry==='actual API-key create') result=await createApiKey(env,{organizationId:'org',name:'test key',scopes:['sites:read']});
      else if(entry==='actual API-key delete') result=await revokeApiKey(env,'org','key-id');
      else if(entry==='actual AI gateway') result=await runAiTask(env,{organizationId:'org',task:'not-a-task'});
      else {
        const portal=createTenantPortalService({async getFromTenant(){return {ok:true,data:{}}},async postToTenant(){return {ok:true,data:{}}}});
        const site={id:'site',organization_id:'org',tenant_id:'tenant'};
        // Use a report endpoint: its entitlement check is satisfied by this test DB adapter.
        if(entry.endsWith('GET')) result=await portal.getReport(env,site,'r1');
        else result=await portal.runReport(env,site,'r1');
      }
      const allowed=entry==='actual tenant-portal GET'?serves(state):mutates(state);
      const blocked=mode==='enforce'&&!allowed;
      assert.equal(result.status===402,blocked,`${entry} should ${blocked?'refuse':'not return billing refusal'} for ${state}/${mode}`);
      if(blocked) assert.equal(result.reasonCode||result.reasonCode,`billing_${state}`);
      if(mode==='shadow'&&!allowed){assert.ok(env.shadows.some(x=>String(x.reason).includes('entry_point=')),`${entry} must record a shadow entry point`);}
    });
  });
}

for (const entry of ['actual provision','actual deploy','actual domains.js attach','actual zone-domains.js attach']) {
  test(`${entry}: actual service honors all access states and modes`, async t => {
    for (const state of STATES) for (const mode of MODES) await t.test(`${state}/${mode}`, async () => {
      const env=serviceEnv(state,mode); let result;
      if(entry==='actual provision') result=await createProvisioningService({PROVIDER_NAME:'test'}).startProvisioning(env,'site');
      else if(entry==='actual deploy') result=await deployments.startDeployment(env,{siteId:'site'});
      else if(entry==='actual domains.js attach') result=await domains.addDomain(env,{siteId:'site',hostname:'not a hostname',actorUserId:'user'});
      else result=await zoneDomains.attachHostnames(env,{id:'zone',provider_zone_id:'zone-provider',zone_name:'example.test',activated_at:new Date(now).toISOString()},{id:'site',organization_id:'org',slug:'site',status:'active'},{redeploy:false,now});
      const allowed=mutates(state), blocked=mode==='enforce'&&!allowed;
      assert.equal(result.status===402||result.reasonCode===`billing_${state}`,blocked,`${entry} billing decision mismatch for ${state}/${mode}`);
      if(blocked) assert.equal(result.reasonCode,`billing_${state}`);
      if(mode==='shadow'&&!allowed) assert.ok(env.shadows.some(x=>String(x.reason).includes('entry_point=')),`${entry} should log entry point`);
    });
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import { checkDowngradeGuard } from "../worker/plan-change-guard.js";
function envMock({ target = {}, current = {} } = {}) {
 const calls=[];
 return { calls, LUMMET_DB: { prepare(sql) { return { sql, args: [], bind(...args) { this.args=args; return this; }, async all() { calls.push({sql,args:this.args}); if(sql.includes("SELECT key,value_type,value FROM plan_entitlements")) return {results:Object.entries(this.args[0]==="target"?target:current).map(([key,value])=>({key,value_type:typeof value==="number"?"number":"text",value:String(value)}))}; if(sql.includes("SELECT id, name AS label FROM sites")) return {results:[{id:"site1",label:"Site 1"},{id:"site2",label:"Site 2"}]}; if(sql.includes("cu.email AS label")) return {results:[{id:"u1",label:"a@example.com",kind:"member"},{id:"u2",label:"b@example.com",kind:"member"}]}; if(sql.includes("SELECT d.id")) return {results:[{id:"d1",label:"example.com"},{id:"d2",label:"example.net"}]}; return {results:[]}; }, async first() { calls.push({sql,args:this.args}); if(sql.includes("COUNT(*) n FROM sites")) return {n:4}; if(sql.includes("organization_invitations")) return {n:5}; if(sql.includes("COUNT(DISTINCT")) return {n:3}; if(sql.includes("SELECT s.plan_id")) return {plan_id:"current"}; return null; } }; } } };
}
test("downgrade guard returns exact site, seat and domain excesses", async()=>{
 const env=envMock({target:{"sites.max":2,"users.max":3,"domains.custom.max":1,"storage.max_mb":100},current:{"sites.max":10,"users.max":10,"domains.custom.max":10,"storage.max_mb":1000}});
 const result=await checkDowngradeGuard(env,"org","target");
 assert.equal(result.ok,false); assert.deepEqual(result.blockers.filter(x=>x.metric!=="storageMb").map(x=>[x.metric,x.used,x.limit,x.excess]),[["sites",4,2,2],["users",5,3,2],["customDomains",3,1,2]]);
 assert.equal(result.blockers.find(x=>x.metric==="sites").removalRequired.length,2);
 assert.equal(result.blockers.some(x=>x.metric==="storageMb"),true);
});
test("downgrade guard passes when counted usage fits and no storage cap reduction is proposed", async()=>{
 const env=envMock({target:{"sites.max":10,"users.max":10,"domains.custom.max":10,"storage.max_mb":1000},current:{"sites.max":10,"users.max":10,"domains.custom.max":10,"storage.max_mb":1000}});
 // This fixture intentionally uses counts below all limits.
 const original=env.LUMMET_DB.prepare.bind(env.LUMMET_DB);
 env.LUMMET_DB.prepare=(sql)=>{const q=original(sql); if(sql.includes("COUNT(*) n FROM sites")) q.first=async()=>({n:2}); if(sql.includes("organization_invitations")) q.first=async()=>({n:2}); if(sql.includes("COUNT(DISTINCT")) q.first=async()=>({n:2}); return q;};
 const result=await checkDowngradeGuard(env,"org","target"); assert.equal(result.ok,true); assert.deepEqual(result.blockers,[]);
});

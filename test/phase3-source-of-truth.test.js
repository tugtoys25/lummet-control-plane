import test from "node:test";
import assert from "node:assert/strict";
import { saveBillingProfile, recordDrift, resolveDrift, reconcileSubscriptions } from "../worker/phase3-source-of-truth.js";

function dbMock() {
 const calls=[];
 const db={calls, prepare(sql){return {sql, args:[], bind(...args){this.args=args;return this}, async first(){calls.push({sql,args:this.args,kind:"first"}); if(sql.includes("SELECT id FROM reconciliation")) return null; if(sql.includes("SELECT * FROM reconciliation_findings")) return {id:this.args[0],organization_id:"o1",subscription_id:"s1",field:"status",stripe_value:"past_due"}; if(sql.includes("SELECT id FROM subscriptions")) return {id:"s1"}; if(sql.includes("SELECT * FROM organization_billing_profiles")) return {organization_id:this.args[0]}; if(sql.includes("SELECT pp.stripe_price_id")) return {stripe_price_id:"price_1"}; return null;}, async run(){calls.push({sql,args:this.args,kind:"run"});return {meta:{changes:1}}},async all(){return {results:[{id:"s1",organization_id:"o1",provider_subscription_id:"sub1",status:"active",current_period_end:"2026-01-01T00:00:00.000Z",cancel_at_period_end:0}]}}}}};
 return {LUMMET_DB:db};
}
test("billing profile validates and upserts normalized country", async()=>{const env=dbMock(); const p=await saveBillingProfile(env,"o1",{billing_email:"bill@example.com",country:"rw"}); assert.equal(p.organization_id,"o1"); assert.ok(env.LUMMET_DB.calls.some(c=>c.sql.includes("ON CONFLICT"))); await assert.rejects(()=>saveBillingProfile(env,"o1",{billing_email:"bad"}),/invalid/);});
test("drift is recorded and resolution requires an actor and reason",async()=>{const env=dbMock(); const id=await recordDrift(env,{organizationId:"o1",subscriptionId:"s1",field:"status",lummetValue:"active",stripeValue:"past_due"}); assert.ok(id); await assert.rejects(()=>resolveDrift(env,{findingId:id,decision:"accept_stripe",actorId:"staff"}),/reason/); assert.equal((await resolveDrift(env,{findingId:id,decision:"keep_lummet",actorId:"staff",reason:"Verified against customer record"})).status,"kept_lummet");});
test("reconciliation compares values and propagates provider failures",async()=>{const env=dbMock(); const out=await reconcileSubscriptions(env,{fetchSubscription:async()=>({status:"past_due",current_period_end:1767225600,cancel_at_period_end:false,items:{data:[{price:{id:"price_2"}}]}})}); assert.equal(out.checked,1); assert.ok(out.findings.length>=2); await assert.rejects(()=>reconcileSubscriptions(env,{fetchSubscription:async()=>{throw new Error("rate limited")}}),/rate limited/);});

test("accept Stripe drift applies only allowlisted subscription fields before resolving the finding", async()=>{
 const env=dbMock(); const result=await resolveDrift(env,{findingId:"drift1",decision:"accept_stripe",actorId:"staff:9",reason:"Verified provider as source of truth"});
 assert.equal(result.status,"accepted_stripe"); assert.ok(env.LUMMET_DB.calls.some(c=>c.sql.includes("UPDATE subscriptions SET status=?"))); assert.ok(env.LUMMET_DB.calls.some(c=>c.sql.includes("UPDATE reconciliation_findings SET status=?")));
});

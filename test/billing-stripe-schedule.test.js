import test from "node:test";
import assert from "node:assert/strict";
import { changePlan, updateCustomer } from "../worker/billing-stripe.js";
const response = (data, status=200) => new Response(JSON.stringify(data), {status,headers:{"Content-Type":"application/json"}});
test("period-end downgrade creates a schedule and preserves all current items until the period boundary", async(t)=>{
 const original=globalThis.fetch; const calls=[];
 globalThis.fetch=async(url,init)=>{
  calls.push({url:String(url),init});
  if(String(url).includes("/subscriptions/sub_test?")) return response({id:"sub_test",current_period_start:100,current_period_end:200,items:{data:[{id:"si_main",price:{id:"price_pro"},quantity:2},{id:"si_addon",price:{id:"price_addon"},quantity:1}]},schedule:null});
  if(String(url).endsWith("/subscription_schedules")) return response({id:"sub_sched",current_phase:{start_date:100,end_date:200}});
  if(String(url).endsWith("/subscription_schedules/sub_sched")) return response({id:"sub_sched",end_behavior:"release"});
  throw new Error(`Unexpected Stripe request: ${url}`);
 };
 t.after(()=>{globalThis.fetch=original;});
 const result=await changePlan({STRIPE_SECRET_KEY:"sk_test_unit"},"sub_test","price_basic",{idempotencyKey:"test-downgrade",atPeriodEnd:true});
 assert.equal(result.scheduled,true); assert.equal(result.effectiveAt,200); assert.equal(calls.length,3);
 const form=new URLSearchParams(calls[2].init.body);
 assert.equal(form.get("phases[0][end_date]"),"200");
 assert.equal(form.get("phases[0][items][0][price]"),"price_pro");
 assert.equal(form.get("phases[1][items][0][price]"),"price_basic");
 assert.equal(form.get("phases[1][items][1][price]"),"price_addon");
 assert.equal(form.get("end_behavior"),"release");
});
test("period-end downgrade refuses to overwrite a pre-existing Stripe schedule", async(t)=>{
 const original=globalThis.fetch; let calls=0;
 globalThis.fetch=async()=>{calls++;return response({id:"sub_test",schedule:"sub_sched_existing",items:{data:[{id:"si_main",price:{id:"price_pro"},quantity:1}]},current_period_start:100,current_period_end:200});};
 t.after(()=>{globalThis.fetch=original;});
 await assert.rejects(()=>changePlan({STRIPE_SECRET_KEY:"sk_test_unit"},"sub_test","price_basic",{idempotencyKey:"test-existing",atPeriodEnd:true}),/subscription_already_scheduled/);
 assert.equal(calls,1);
});

test("billing-profile sync sends normalized address and a stable idempotency key to Stripe", async(t)=>{
 const original=globalThis.fetch; let call; globalThis.fetch=async(url,init)=>{call={url:String(url),init};return response({id:"cus_profile"});}; t.after(()=>{globalThis.fetch=original;});
 await updateCustomer({STRIPE_SECRET_KEY:"sk_test_unit"},"cus_profile",{legal_name:"Example Ltd",billing_email:"finance@example.com",address_line1:"1 High Street",address_line2:null,city:"London",region:null,postal_code:"SW1A",country:"GB",tax_exempt:false,po_number:"PO-9"},{idempotencyKey:"profile-save-1"});
 assert.match(call.url,/\/customers\/cus_profile$/); assert.equal(call.init.headers["Idempotency-Key"],"profile-save-1"); const form=new URLSearchParams(call.init.body); assert.equal(form.get("name"),"Example Ltd"); assert.equal(form.get("address[country]"),"GB"); assert.equal(form.get("metadata[po_number]"),"PO-9");
});

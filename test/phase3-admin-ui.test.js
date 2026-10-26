import test from "node:test";
import assert from "node:assert/strict";
import { createTestDb, applyMigrations } from "./support/d1-shim.js";
import * as customerAuth from "../worker/customer-auth.js";
import { renderReconciliationPage } from "../worker/views/pages/saas-admin.js";

test("staff reconciliation page shows open drift and audited resolution actions", async()=>{
 const env={LUMMET_DB:createTestDb()}; applyMigrations(env.LUMMET_DB);
 const signup=await customerAuth.signUp({async json(){return {email:"drift-ui@example.com",password:"correct-horse-battery",organizationName:"Drift UI Org"};},headers:{get:()=>"203.0.113.8"}},env);
 await env.LUMMET_DB.prepare(`INSERT INTO reconciliation_findings (id,organization_id,field,lummet_value,stripe_value) VALUES (?,?,?,?,?)`).bind("finding-ui",signup.organizationId,"status","active","past_due").run();
 const html=await renderReconciliationPage(env,{id:"admin-1",email:"admin@example.com",isSuperAdmin:true});
 assert.match(html,/Billing reconciliation/); assert.match(html,/Accept Stripe value/); assert.match(html,/Keep Lummet value/); assert.match(html,/Required audit reason/); assert.match(html,/finding-ui/);
});

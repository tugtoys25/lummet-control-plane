#!/usr/bin/env node
import { execFileSync } from "node:child_process";
const db=process.env.STAGING_D1_DATABASE_NAME||"lummet-control-plane-staging-db";
if(process.env.ENVIRONMENT!=="staging"){console.error("Refusing to seed unless ENVIRONMENT=staging.");process.exit(1)}
function query(sql){const out=execFileSync("npx",["wrangler","d1","execute",db,"--remote","--command",sql,"--json"],{encoding:"utf8",stdio:["ignore","pipe","pipe"]});return JSON.parse(out)}
const planRows=query("SELECT id FROM plans WHERE status='active' ORDER BY created_at LIMIT 1");const plan=planRows[0]?.results?.[0]?.id;if(!plan){console.error("No active plan exists in staging; seed catalog before access-state fixtures.");process.exit(1)}
const fixtures=[['trialing','trialing','active'],['active','active','active'],['past_due','past_due','active'],['restricted','restricted','active'],['suspended','suspended','active'],['closed','suspended','closed'],['trial_expired','expired','active']];
for(const [slug,status,orgStatus] of fixtures){const id=`staging-access-${slug}`;const orgSql=`INSERT OR IGNORE INTO organizations(id,name,slug,status,billing_email) VALUES('${id}','Staging ${slug}','staging-access-${slug}','${orgStatus}','staging+${slug}@example.invalid')`;query(orgSql);const subId=`staging-sub-${slug}`;const end=status==='expired'?"datetime('now','-2 days')":"datetime('now','+7 days')";const sql=`INSERT OR IGNORE INTO subscriptions(id,organization_id,plan_id,status,trial_ends_at,current_period_end) VALUES('${subId}','${id}','${plan}','${status}',${status==='expired'?"datetime('now','-2 days')":"NULL"},${end})`;query(sql);console.log(`Seeded fixture ${slug}`)}
console.log(`Created idempotent access-state fixtures in ${db}.`);

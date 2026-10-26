#!/usr/bin/env node
// Phase 3.5 operational reconciliation. Read-only by default; findings are never applied to subscription state.
import { execFileSync } from "node:child_process";
import { stripeRequest } from "../worker/billing-stripe.js";
import { reconcileSubscriptions } from "../worker/phase3-source-of-truth.js";
const args = process.argv.slice(2);
const option = (name) => { const i=args.indexOf(`--${name}`); return i>=0 ? args[i+1] : null; };
const db = option("db");
if (!db) { console.error("Usage: node scripts/reconcile-billing.mjs --db <database> [--remote] [--limit 100]"); process.exit(2); }
const remote=args.includes("--remote");
const limit=Number(option("limit")||100);
if (!Number.isInteger(limit)||limit<1||limit>500) { console.error("--limit must be 1..500"); process.exit(2); }
const run = async () => {
  const env = { LUMMET_DB: { prepare(sql) { return { bind(...values) { this.values=values; return this; }, async all() {
    const cmd=["wrangler","d1","execute",db,"--command",bound,"--json",...(remote?["--remote"]:["--local"])];
    const raw=execFileSync(cmd[0],cmd.slice(1),{encoding:"utf8"});
    return JSON.parse(raw.slice(raw.indexOf("[")))[0]||{results:[]};
  }, async first(){ const r=await this.all(); return r.results?.[0]||null; }, async run() {
    const q=sql.replace(/\?/g,()=>{ const v=this.values.shift(); return v===null?"NULL":typeof v==="number"?String(v):`'${String(v).replace(/'/g,"''")}'`; });
    const file=(await import("node:fs")).mkdtempSync("/tmp/lummet-reconcile-");
    try { (await import("node:fs")).writeFileSync(file+"/q.sql",q); execFileSync("wrangler",["d1","execute",db,"--file",file+"/q.sql",...(remote?["--remote"]:["--local"])],{stdio:"inherit"}); return {meta:{changes:1}}; }
    finally {(await import("node:fs")).rmSync(file,{recursive:true,force:true});}
  } }; } } };
  const result=await reconcileSubscriptions(env,{limit,fetchSubscription:(id)=>stripeRequest({STRIPE_SECRET_KEY:process.env.STRIPE_SECRET_KEY},"GET",`/subscriptions/${encodeURIComponent(id)}`)});
  console.log(JSON.stringify(result,null,2));
};
run().catch(e=>{console.error("reconciliation failed:",e.message);process.exitCode=1;});

#!/usr/bin/env node
/** Build or safely apply the Phase 4 Stripe webhook endpoint configuration. Dry-run is the default. */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const EVENTS = [
  "checkout.session.completed",
  "checkout.session.expired",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.trial_will_end",
  "invoice.upcoming",
  "invoice.finalized",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.marked_uncollectible",
  "invoice.voided",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
  "credit_note.created",
  "customer.updated",
  "customer.tax_id.created",
  "customer.tax_id.updated",
  "customer.tax_id.deleted",
  "payment_method.attached",
  "payment_method.detached",
  "payment_method.automatically_updated"
];
const args = process.argv.slice(2);
const has = (x) => args.includes(`--${x}`);
const opt = (x) => { const i=args.indexOf(`--${x}`); return i>=0 ? args[i+1] : null; };
const mode=opt('mode') || 'test';
if (!['test','live'].includes(mode)) { console.error('Usage: node scripts/stripe-webhook-config.mjs [--mode test|live] [--url https://...] [--apply] [--allow-live]'); process.exit(2); }
const key=String(process.env.STRIPE_SECRET_KEY||'');
const keyMode=/^(sk|rk)_test_/.test(key)?'test':/^(sk|rk)_live_/.test(key)?'live':null;
const url=opt('url') || process.env.STRIPE_WEBHOOK_URL || '';
if (url) { try { const u=new URL(url); if(u.protocol!=='https:' || u.username || u.password) throw new Error(); } catch { console.error('REFUSED: webhook URL must be a valid HTTPS URL without embedded credentials.'); process.exit(2); } }
const payload={url,enabled_events:EVENTS,api_version:String(process.env.STRIPE_API_VERSION||''),description:`Lummet ${mode} webhook (Phase 4)`};
if (!has('apply')) { console.log(JSON.stringify({mode,operation:'create webhook endpoint',dryRun:true,requiredKeyPrefix:mode==='test'?'sk_test_/rk_test_':'sk_live_/rk_live_',url: url||'(set STRIPE_WEBHOOK_URL or --url)',apiVersion:payload.api_version||'(set pinned STRIPE_API_VERSION)',eventCount:EVENTS.length,events:EVENTS,notes:['No network request was made.','Customer portal, retries, email, branding, tax registrations and legal approvals remain dashboard/operator checks.']},null,2)); process.exit(0); }
if (!url || !/^\d{4}-\d{2}-\d{2}$/.test(payload.api_version)) { console.error('REFUSED: --apply requires HTTPS URL and pinned STRIPE_API_VERSION (YYYY-MM-DD).'); process.exit(2); }
if (!keyMode || keyMode!==mode) { console.error(`REFUSED: requested ${mode} mode but STRIPE_SECRET_KEY mode is ${keyMode||'unknown'}.`); process.exit(2); }
if (mode==='live' && !(has('allow-live') && process.env.STRIPE_LIVE_CHANGES_APPROVED==='true')) { console.error('REFUSED: live endpoint creation requires --allow-live and STRIPE_LIVE_CHANGES_APPROVED=true.'); process.exit(2); }
const idempotencyKey='lummet-webhook-'+createHash('sha256').update(`${mode}:${url}`).digest('hex');
const body=new URLSearchParams(); body.set('url',url); body.set('description',payload.description); body.set('api_version',payload.api_version); for(const e of EVENTS) body.append('enabled_events[]',e);
const res=await fetch('https://api.stripe.com/v1/webhook_endpoints',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Stripe-Version':payload.api_version,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':idempotencyKey},body});
const result=await res.json().catch(()=>({}));
if(!res.ok){console.error(`Stripe endpoint creation failed: HTTP ${res.status}; ${result.error?.type||'unknown error'}: ${result.error?.message||'no message'}`);process.exit(1)}
const out={mode,id:result.id,url:result.url,api_version:result.api_version,enabled_events:result.enabled_events,status:'created; verify endpoint delivery manually',signingSecret:'NOT RETURNED OR STORED BY THIS SCRIPT'};
const outFile=opt('out'); if(outFile){await writeFile(outFile,JSON.stringify(out,null,2)+'\n',{mode:0o600}); console.log(`Redacted endpoint evidence written to ${outFile}`)} else console.log(JSON.stringify(out,null,2));

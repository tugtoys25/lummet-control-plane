#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
function raw(args){return execFileSync('npx',['wrangler',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']})}
function runJson(args){return JSON.parse(raw(args))}
function listNames(data,keyNames){let rows=Array.isArray(data)?data:(data?.result||data?.results||data?.queues||data?.buckets||[]);if(rows.length===1&&Array.isArray(rows[0]?.result))rows=rows[0].result;return new Set(rows.map(r=>keyNames.map(k=>r?.[k]).find(Boolean)).filter(Boolean))}
const buckets=['lummet-backups-staging','lummet-tenant-templates-staging'];
const currentBuckets=listNames(runJson(['r2','bucket','list','--json']),['name','bucket_name']);
for(const name of buckets)if(!currentBuckets.has(name)){raw(['r2','bucket','create',name]);console.log(`Created staging R2 bucket ${name}`)}else console.log(`Staging R2 bucket exists: ${name}`);
const queues=['lummet-jobs-staging-dlq','lummet-jobs-staging'];
const currentQueues=listNames(runJson(['queues','list','--json']),['queue_name','name']);
for(const name of queues)if(!currentQueues.has(name)){raw(['queues','create',name]);console.log(`Created staging Queue ${name}`)}else console.log(`Staging Queue exists: ${name}`);

#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
const token=process.env.CLOUDFLARE_API_TOKEN, account=process.env.CLOUDFLARE_ACCOUNT_ID;
if(!token||!account){console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required to record a D1 bookmark.');process.exit(1)}
const config=await readFile('wrangler.jsonc','utf8');
const match=config.match(/"database_name"\s*:\s*"lummet-control-plane-staging-db"[\s\S]{0,250}?"database_id"\s*:\s*"([0-9a-f-]{36})"/i);
if(!match){console.error('Could not locate the resolved staging D1 database ID in wrangler.jsonc.');process.exit(1)}
const databaseId=match[1];
const url=`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/d1/database/${encodeURIComponent(databaseId)}/time_travel/bookmark`;
const response=await fetch(url,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
let body;try{body=await response.json()}catch{throw new Error(`D1 Time Travel API returned non-JSON HTTP ${response.status}`)}
if(!response.ok||body.success!==true||typeof body.result?.bookmark!=="string"||!body.result.bookmark){console.error(`D1 Time Travel bookmark request failed (HTTP ${response.status}; codes ${(body.errors||[]).map(e=>e.code).join(',')||'unknown'}).`);process.exit(1)}
const evidence={databaseName:'lummet-control-plane-staging-db',bookmark:body.result.bookmark,recordedAt:new Date().toISOString(),source:'Cloudflare D1 Time Travel bookmark API'};
await writeFile('d1-time-travel-bookmark.json',JSON.stringify(evidence,null,2)+'\n');
console.log(`Recorded D1 Time Travel bookmark for ${evidence.databaseName}; bookmark stored in d1-time-travel-bookmark.json.`);

#!/usr/bin/env node
// Reuses or creates an isolated staging D1 database through Cloudflare's documented D1 API.
import { readFile, writeFile } from 'node:fs/promises';
const path='wrangler.jsonc';
let text=await readFile(path,'utf8');
const name='lummet-control-plane-staging-db';
let id=process.env.STAGING_D1_DATABASE_ID;
if(!id){
  const token=process.env.CLOUDFLARE_API_TOKEN, account=process.env.CLOUDFLARE_ACCOUNT_ID;
  if(!token||!account){console.error('Missing CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID; cannot provision staging D1.');process.exit(1)}
  const endpoint=`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/d1/database`;
  async function api(url,init={}){const response=await fetch(url,{...init,headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...(init.headers||{})},signal:AbortSignal.timeout(15000)});let body;try{body=await response.json()}catch{throw new Error(`Cloudflare D1 API returned non-JSON HTTP ${response.status}`)}if(!response.ok||body.success!==true)throw new Error(`Cloudflare D1 API request failed (HTTP ${response.status}; codes ${(body.errors||[]).map(e=>e.code).join(',')||'unknown'})`);return body.result}
  const listed=await api(`${endpoint}?name=${encodeURIComponent(name)}&per_page=100`);
  const existing=(Array.isArray(listed)?listed:[]).find(db=>db.name===name);
  if(existing?.uuid) id=existing.uuid;
  else {const created=await api(endpoint,{method:'POST',body:JSON.stringify({name})});id=created?.uuid;}
}
if(!id||!/^[0-9a-f-]{36}$/i.test(id)){console.error('Could not resolve a valid staging D1 database ID.');process.exit(1)}
text=text.replace('"database_id":"00000000-0000-0000-0000-000000000001"',`"database_id":"${id}"`);
if(text.includes('"database_id":"00000000-0000-0000-0000-000000000001"')){console.error('Could not replace the staging D1 placeholder.');process.exit(1)}
await writeFile(path,text);console.log(`Prepared isolated staging D1 binding for ${name}; database ID withheld from logs.`);

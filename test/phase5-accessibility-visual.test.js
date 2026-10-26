import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createAssets } from './support/public-env.js';

function env(){const db=createTestDb();applyMigrations(db);return {LUMMET_DB:db,ASSETS:createAssets(),CONTACT_EMAIL:'hello@example.test',CREDENTIAL_KEK:btoa('k'.repeat(32))};}
async function page(e,path){const r=await worker.fetch(new Request('https://cp.test'+path,{headers:{'CF-Connecting-IP':'198.51.100.5'}}),e,{waitUntil(p){Promise.resolve(p).catch(()=>{})}});return {status:r.status,text:await r.text()};}

test('pricing and signup pages expose accessible labels, headings and keyboard controls',async()=>{const e=env();const pricing=await page(e,'/pricing');assert.equal(pricing.status,200);assert.match(pricing.text,/pricing-comparison-title/);assert.match(pricing.text,/scope="col"/);assert.match(pricing.text,/pricing-family/);const login=await page(e,'/app/login');assert.equal(login.status,200);for(const id of ['login-email','login-password','signup-org','signup-email','signup-password']) assert.match(login.text,new RegExp(`for="${id}"`));});

test('billing screen has the four required tabs and save-flow affordances are keyboard buttons',()=>{const s=readFileSync(new URL('../worker/views/customer-pages/billing.js',import.meta.url),'utf8');for(const x of ['Billing sections','billing-overview','billing-plans','billing-invoices','billing-details','data-save-offer'])assert.match(s,new RegExp(x));assert.match(s,/type="button"/);});

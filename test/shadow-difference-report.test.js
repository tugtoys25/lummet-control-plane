import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
test('shadow difference reporter exits nonzero for unexplained findings and succeeds for reviewed findings',()=>{const dir=mkdtempSync(join(tmpdir(),'lummet-shadow-'));try{const input=join(dir,'in.json'),out=join(dir,'out.json'),script=resolve(import.meta.dirname,'../scripts/report-shadow-differences.mjs');writeFileSync(input,JSON.stringify([{id:1,organization_id:'org',state:'restricted',reason:'entry_point=/api/sites'}]));let r=spawnSync(process.execPath,[script,input,out],{encoding:'utf8'});assert.equal(r.status,1);assert.match(r.stdout,/unexplained=1/);assert.equal(JSON.parse(readFileSync(out,'utf8')).unexplained,1);writeFileSync(input,JSON.stringify([{id:1,organization_id:'org',state:'restricted',reason:'entry_point=/api/sites',owner:'ops',disposition:'explained',reviewedAt:'2026-10-23T00:00:00Z'}]));r=spawnSync(process.execPath,[script,input,out],{encoding:'utf8'});assert.equal(r.status,0);assert.match(r.stdout,/unexplained=0/)}finally{rmSync(dir,{recursive:true,force:true})}});

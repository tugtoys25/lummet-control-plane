#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const args=process.argv.slice(2); const at=args.indexOf('--db'); const db=at>=0?args[at+1]:null; const remote=args.includes('--remote');
if(!db){console.error('Usage: node scripts/migration-preflight.mjs --db <database> [--remote]');process.exit(2)}
function query(sql){const a=['d1','execute',db,'--command',sql,'--json',remote?'--remote':'--local'];const out=execFileSync('npx',['wrangler',...a],{encoding:'utf8',stdio:['ignore','pipe','pipe']});return JSON.parse(out)}
const tables=query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")[0]?.results||[];
const hasHistory=tables.some(t=>t.name==='schema_migrations');
if(!hasHistory){const applicationTables=tables.filter(t=>t.name!=='d1_migrations'&&t.name!=='_cf_KV');if(applicationTables.length){console.error(`MIGRATION PREFLIGHT FAILED: ${db} has ${applicationTables.length} application tables (${applicationTables.map(t=>t.name).join(", ")}) but no schema_migrations history. Do not apply migrations; reconcile/record history first.`);process.exit(1)}console.log(`Fresh database ${db}: no application tables; full initial migration chain is safe.`);process.exit(0)}
const appliedRows=query('SELECT filename FROM schema_migrations ORDER BY filename')[0]?.results||[];const applied=new Set(appliedRows.map(x=>x.filename));const files=readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort();const unknown=[...applied].filter(f=>!files.includes(f));if(unknown.length){console.error(`MIGRATION PREFLIGHT FAILED: database records unknown migration(s): ${unknown.join(', ')}`);process.exit(1)}const pending=files.filter(f=>!applied.has(f));console.log(`Migration history verified for ${db}: applied=${applied.size}, pending=${pending.length}${pending.length?`, next=${pending[0]}`:''}. No applied migration will be rerun by migrate.mjs.`);

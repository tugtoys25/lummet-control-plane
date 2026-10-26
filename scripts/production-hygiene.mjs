#!/usr/bin/env node
/** Optional production hygiene check. Disabled by default; this does not replace the full test/security review. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const enabled=String(process.env.ENFORCE_PRODUCTION_HYGIENE||'off').toLowerCase()==='on';
if(!enabled){console.log('SKIP production hygiene: ENFORCE_PRODUCTION_HYGIENE is off (default).');process.exit(0)}
const root=process.cwd();const required=['docs/STRIPE_SETUP.md','docs/GO_LIVE_RECORD.md','docs/PLACEHOLDERS.md','docs/OWNER_DECISIONS.md'];const missing=[];for(const f of required){try{await readFile(path.join(root,f))}catch{missing.push(f)}}
const codeowners=await readFile(path.join(root,'.github/CODEOWNERS'),'utf8').catch(()=> '');if(!codeowners.trim()||/@OWNER\b/.test(codeowners))missing.push('.github/CODEOWNERS (replace @OWNER with a real reviewer)');
if(missing.length){console.error('PRODUCTION HYGIENE BLOCKED (enabled):\n- '+missing.join('\n- '));process.exit(1)}console.log('Production hygiene document/ownership checks passed; external service and approval checks remain separate.');

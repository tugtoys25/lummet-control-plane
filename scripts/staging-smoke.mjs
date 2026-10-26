#!/usr/bin/env node
const base=process.env.STAGING_BASE_URL;if(!base){console.error("STAGING_BASE_URL is required");process.exit(1)}
for(const path of ["/api/health","/"]){const r=await fetch(new URL(path,base),{redirect:"manual",signal:AbortSignal.timeout(10000)});console.log(`${path} HTTP ${r.status}`);if(path==="/api/health"&&r.status!==200)process.exitCode=1;if(path==="/"&&r.status>=500)process.exitCode=1;}

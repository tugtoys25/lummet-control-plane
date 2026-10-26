#!/usr/bin/env node
// Creates the isolated staging R2 buckets and Queues. Creating an existing one is fine.
import { execFileSync } from 'node:child_process';
function create(args, label) {
  try {
    execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`Created ${label}`);
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    if (/already exists?/i.test(out)) { console.log(`Exists: ${label}`); return; }
    console.error(`FAILED ${label}\n${out}`);
    process.exit(1);
  }
}
for (const n of ['lummet-backups-staging', 'lummet-tenant-templates-staging']) create(['r2', 'bucket', 'create', n], `staging R2 bucket ${n}`);
for (const n of ['lummet-jobs-staging-dlq', 'lummet-jobs-staging']) create(['queues', 'create', n], `staging Queue ${n}`);

#!/usr/bin/env node
/** Report shadow findings that lack an explicit reviewed disposition. Read-only. */
import { readFileSync, writeFileSync } from 'node:fs';
const input = process.argv[2] || 'shadow-findings.json';
const output = process.argv[3] || 'shadow-differences-report.json';
let parsed;
try { parsed = JSON.parse(readFileSync(input, 'utf8')); }
catch (e) { console.error(`Cannot read ${input}: ${e.message}`); process.exit(2); }
const rows = Array.isArray(parsed) ? parsed : parsed.data;
if (!Array.isArray(rows)) { console.error('Expected a JSON array or {"data": [...]}'); process.exit(2); }
const reviewed = new Set(['explained','accepted','known-safe','false-positive']);
const differences = rows.filter(r => !reviewed.has(String(r.disposition || '').trim().toLowerCase()) || !String(r.owner || '').trim() || !String(r.reviewedAt || '').trim());
const report = { generatedAt: new Date().toISOString(), input, total: rows.length, unexplained: differences.length, differences: differences.map(r => ({ id:r.id ?? null, organizationId:r.organization_id ?? r.organizationId ?? null, state:r.state ?? null, reason:r.reason ?? null, entryPoint:(String(r.reason || '').match(/entry_point=([^ ]+)/)||[])[1] ?? null, owner:r.owner ?? null, disposition:r.disposition ?? null, reviewedAt:r.reviewedAt ?? null })) };
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(`shadow findings=${report.total} unexplained=${report.unexplained} report=${output}`);
if (report.unexplained) process.exitCode = 1;

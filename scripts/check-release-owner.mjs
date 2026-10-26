#!/usr/bin/env node
/** Release-only ownership/placeholder gate. --generate updates CODEOWNERS from the single owner config. */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootArg = process.argv.indexOf('--root');
const root = rootArg >= 0 && process.argv[rootArg + 1] ? path.resolve(process.argv[rootArg + 1]) : scriptRoot;
const ownerPath = path.join(root, 'docs/release-owner.json');
const codeownersPath = path.join(root, '.github/CODEOWNERS');
const generate = process.argv.includes('--generate');
const ownerOnly = generate || process.argv.includes('--owner-only');
const ownerConfig = JSON.parse(await readFile(ownerPath, 'utf8'));
const owner = String(ownerConfig.owner || '').trim();
const validOwner = /^@[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9][A-Za-z0-9-]*)?$/.test(owner);
let codeowners = await readFile(codeownersPath, 'utf8');
if (generate) {
  if (!validOwner) { console.error('OWNER GATE BLOCKED: set docs/release-owner.json owner to an actual GitHub @user or @org/team. No owner has been invented.'); process.exit(1); }
  codeowners = codeowners.replace(/@OWNER\b/g, owner);
  await writeFile(codeownersPath, codeowners);
  console.log(`Generated .github/CODEOWNERS using configured owner ${owner}.`);
}
const placeholders = ownerOnly ? '' : await readFile(path.join(root, 'docs/PLACEHOLDERS.md'), 'utf8');
const problems = [];
if (!validOwner) problems.push('docs/release-owner.json owner is empty or invalid');
if (/@OWNER\b/.test(codeowners)) problems.push('.github/CODEOWNERS still contains @OWNER');
if (validOwner && !codeowners.split(/\r?\n/).some(line => line.trim().split(/\s+/).slice(1).includes(owner))) problems.push(`.github/CODEOWNERS does not assign any path to ${owner}`);
const unresolvedMarkers = [...new Set((placeholders.match(/\b(?:TODO|TBD|TBC|OWNER_REQUIRED|NOT_CONFIGURED)\b/gi) || []))];
if (placeholders.split(/\r?\n/).some(line => /^\s*-\s+\[OPEN\]/i.test(line))) problems.push('docs/PLACEHOLDERS.md still has [OPEN] launch placeholders');
if (unresolvedMarkers.length) problems.push(`docs/PLACEHOLDERS.md contains unresolved markers: ${unresolvedMarkers.join(', ')}`);
if (problems.length) { console.error('RELEASE OWNERSHIP/PLACEHOLDER GATE BLOCKED:\n- ' + problems.join('\n- ')); process.exit(1); }
console.log(`RELEASE OWNERSHIP/PLACEHOLDER GATE PASS: owner ${owner}; no unresolved release markers.`);

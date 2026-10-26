#!/usr/bin/env node
// Isolated runner: natural exit first, force-exit fallback for leaked handles. Child output is file-backed so
// an orphaned descendant cannot keep a captured stdout pipe open and deadlock the runner.
import { readdirSync, writeFileSync, readFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const files=[];function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=`${dir}/${e.name}`;if(e.isDirectory())walk(p);else if(e.isFile()&&p.endsWith('.test.js'))files.push(p.replaceAll('\\','/'))}}walk('test');files.sort();const skips=String(process.env.TEST_SKIP||'').split(',').map(x=>x.trim()).filter(Boolean);for(let i=files.length-1;i>=0;i--)if(skips.some(s=>files[i].endsWith('/'+s)))files.splice(i,1);
const filters=String(process.env.TEST_FILTER||'').split(',').map(x=>x.trim()).filter(Boolean);const selected=files.filter(f=>!filters.length||filters.some(x=>x.endsWith('.test.js')?f.endsWith('/'+x):f.includes(x)));const timeoutMs=Math.max(5000,Number(process.env.TEST_FILE_TIMEOUT_MS||20000));const forceExitAllowlist=new Set(String(process.env.TEST_FORCE_EXIT_ALLOWLIST||'').split(',').map(x=>x.trim()).filter(Boolean));const results=[];
function run(file,force){return new Promise(resolve=>{const logPath=join(tmpdir(),`lummet-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);const fd=openSync(logPath,'w');const args=['--test','--test-reporter=tap',...(force?['--test-force-exit']:[]),file];const child=spawn(process.execPath,args,{detached:process.platform!=='win32',stdio:['ignore',fd,fd]});closeSync(fd);let timedOut=false,settled=false;const timer=setTimeout(()=>{timedOut=true;try{if(process.platform!=='win32')process.kill(-child.pid,'SIGTERM');else child.kill('SIGTERM')}catch{}const killer=setTimeout(()=>{try{if(process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL')}catch{}},1000);killer.unref()},timeoutMs);child.on('error',e=>{if(settled)return;settled=true;clearTimeout(timer);let output='';try{output=readFileSync(logPath,'utf8')}catch{}try{unlinkSync(logPath)}catch{}resolve({status:1,output:output+'\n'+e.message,timedOut})});child.on('close',code=>{if(settled)return;settled=true;clearTimeout(timer);let output='';try{output=readFileSync(logPath,'utf8')}catch{}try{unlinkSync(logPath)}catch{}resolve({status:code,output,timedOut})})})}
function lastCount(output, label) {
  const matches = [...output.matchAll(new RegExp(`^# ${label} (\\d+)$`, 'gm'))];
  return matches.length ? Number(matches[matches.length - 1][1]) : null;
}
for (const file of selected) {
  const start = performance.now();
  let r = await run(file, false), forced = false, output = r.output;
  if (r.timedOut) { forced = true; const retry = await run(file, true); output += '\n--- retry with --test-force-exit ---\n' + retry.output; r = retry; }
  const ms = Math.round(performance.now() - start);
  const tests = lastCount(output, 'tests'), passCount = lastCount(output, 'pass'), failCount = lastCount(output, 'fail');
  const skipped = lastCount(output, 'skipped') ?? 0, todo = lastCount(output, 'todo') ?? 0, cancelled = lastCount(output, 'cancelled') ?? 0;
  const allowlisted = forced && forceExitAllowlist.has(file);
  const hasSummary = tests !== null && passCount !== null && failCount !== null;
  const passed = r.status === 0 && !r.timedOut && hasSummary && failCount === 0 && (!forced || allowlisted);
  results.push({ file, ms, passed, timedOut: r.timedOut, code: r.status, testCount: tests || 0, passCount: passCount || 0, failCount: failCount || 0, skipped, todo, cancelled, needsForceExit: forced, allowlisted, hasSummary });
  console.log(`${passed ? (forced ? 'PASS_ALLOWLISTED' : 'PASS') : forced ? 'FORCED_EXIT' : r.timedOut ? 'TIMEOUT' : 'FAIL'} ${file} ${ms}ms${forced ? (allowlisted ? ' (documented force-exit allow-list)' : ' (natural exit failed; forced retry is diagnostic only)') : ''}`);
  if (!passed) console.log(output);
}
const bad = results.filter(r => !r.passed), forced = results.filter(r => r.needsForceExit);
const sum = key => results.reduce((n, r) => n + r[key], 0);
const lines = [
  '# Per-file test timing and handle-leak report', '', `Generated: ${new Date().toISOString()}`,
  `Files selected: ${results.length}; tests: ${sum('testCount')}; passed: ${sum('passCount')}; failed tests: ${sum('failCount')}; skipped: ${sum('skipped')}; todo: ${sum('todo')}; cancelled: ${sum('cancelled')}; failing files/timeouts/forced exits: ${bad.length}; per-file timeout: ${timeoutMs}ms`,
  `Force-exit allow-list: ${forceExitAllowlist.size ? [...forceExitAllowlist].join(', ') : 'none'}`, '',
  '| Test file | Tests | Passed | Failed | Skipped | Duration | Result | Natural exit |', '|---|---:|---:|---:|---:|---:|---|---|',
  ...results.map(r => `| \`${r.file}\` | ${r.testCount} | ${r.passCount} | ${r.failCount} | ${r.skipped} | ${r.ms} ms | ${r.needsForceExit ? (r.allowlisted ? 'PASS_ALLOWLISTED' : 'FORCED_EXIT') : r.timedOut ? 'TIMEOUT' : r.passed ? 'PASS' : 'FAIL'} | ${r.needsForceExit ? 'HANGS; forced retry diagnostic only' : 'exits naturally'} |`),
  '', '## Files requiring `--test-force-exit`', ...(forced.length ? forced.map(r => `- \`${r.file}\` — natural process exit failed within ${timeoutMs} ms; ${r.allowlisted ? 'allow-listed by TEST_FORCE_EXIT_ALLOWLIST, but still requires follow-up' : 'fails the suite unless explicitly allow-listed with justification'}.`) : ['- None observed in this run.']),
  '', `Total tests: ${sum('testCount')}; passed: ${sum('passCount')}; failed: ${sum('failCount')}; skipped: ${sum('skipped')}; todo: ${sum('todo')}; forced_exit: ${forced.length}; failed files: ${bad.length}`,
  `Exit status: ${bad.length ? 1 : 0}`
];
writeFileSync('test-timings.md', lines.join('\n') + '\n');
console.log(`SUMMARY files=${results.length} tests=${sum('testCount')} forced_exit=${forced.length} failed=${bad.length} passed=${sum('passCount')} failed_tests=${sum('failCount')} skipped=${sum('skipped')} todo=${sum('todo')} cancelled=${sum('cancelled')}`);
process.exit(bad.length ? 1 : 0);

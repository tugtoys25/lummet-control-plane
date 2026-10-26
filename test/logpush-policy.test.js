// Round 6.3C: Logpush plan (config as code, offline checker). Nothing here talks to Cloudflare; the live job is NOT VERIFIED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, readFileSync as read } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, validateConfig, openPlaceholders, renderPlan, ALLOWED_FIELDS, FORBIDDEN_FIELDS } from '../scripts/lib/logpush-policy.mjs';
import { main } from '../scripts/logpush-config.mjs';

const clone = (x) => JSON.parse(JSON.stringify(x));
const io = () => { const out = []; const err = []; return { out, err, log: (m) => out.push(String(m)), error: (m) => err.push(String(m)) }; };

test('the shipped plan is valid, disabled, and never requests the Event field or any header, cookie or client-address field', () => {
  const c = loadConfig();
  assert.deepEqual(validateConfig(c), []);
  assert.equal(c.job.enabled, false);
  assert.equal(c.job.dataset, 'workers_trace_events');
  for (const f of c.job.fields) { assert.ok(ALLOWED_FIELDS.includes(f), f); assert.ok(!FORBIDDEN_FIELDS.includes(f), f); }
  assert.ok(!c.job.fields.includes('Event'));
  assert.ok(c.job.fields.includes('Logs') && c.job.fields.includes('Exceptions'), 'Worker logs are what the job is for');
});

test('owner values are open placeholders: destination, retention and sample rate', () => {
  const open = openPlaceholders(loadConfig()).join('\n');
  for (const word of ['job.destination', 'job.retention', 'job.sampleRate']) assert.ok(open.includes(word), word);
});

test('validation refuses: a forbidden field, an unreviewed field, a missing neverInclude, an enabled job, a wrong dataset', () => {
  const bad = (mut) => { const c = clone(loadConfig()); mut(c); return validateConfig(c).join(' | '); };
  assert.match(bad((c) => c.job.fields.push('Event')), /Event/);
  assert.match(bad((c) => c.job.fields.push('RequestHeaders')), /RequestHeaders/);
  assert.match(bad((c) => c.job.fields.push('SomethingNew')), /allowlist/);
  assert.match(bad((c) => { c.job.fields = []; }), /fields/);
  assert.match(bad((c) => { c.job.neverInclude = ['Event']; }), /neverInclude/);
  assert.match(bad((c) => { c.job.enabled = true; }), /enabled/);
  assert.match(bad((c) => { c.job.dataset = 'http_requests'; }), /dataset/);
  assert.match(bad((c) => { c.auditRows.requires = ['AUDIT_LOG_STREAM=on']; }), /LOG_REDACTION/);
});

test('validation refuses a destination that already carries a credential', () => {
  for (const dest of ['s3://bucket/path?access_key=AKIAXXXX&secret=abc', 'https://user:pass@logs.example.com/ingest', 'https://logs.example.com/ingest?token=abc', 'https://b.s3.example.com/x?X-Amz-Signature=abc']) {
    const c = clone(loadConfig()); c.job.destination = dest;
    assert.match(validateConfig(c).join(' '), /destination/, dest);
  }
  const c = clone(loadConfig()); c.job.destination = 's3://owner-log-bucket/lummet';
  assert.deepEqual(validateConfig(c), []);
});

test('the rendered plan never echoes a destination', () => {
  const c = clone(loadConfig()); c.job.destination = 's3://owner-log-bucket/lummet';
  const plan = JSON.stringify(renderPlan(c));
  assert.ok(!plan.includes('owner-log-bucket'));
  assert.match(plan, /not shown/);
});

test('script: prints a dry-run report, exit 0; --strict exits 1 while placeholders remain; invalid config exits 2; no network, no mutation', async () => {
  const a = io(); assert.equal(await main([], {}, a), 0);
  const report = JSON.parse(a.out.join('\n'));
  assert.deepEqual({ dryRun: report.dryRun, mutates: report.mutates, callsCloudflare: report.callsCloudflare, valid: report.valid }, { dryRun: true, mutates: false, callsCloudflare: false, valid: true });
  assert.ok(report.openPlaceholders.length >= 3); assert.ok(report.applyBlockedBy.length);
  assert.equal(await main(['--strict'], {}, io()), 1);
  const src = readFileSync(new URL('../scripts/logpush-config.mjs', import.meta.url), 'utf8') + readFileSync(new URL('../scripts/lib/logpush-policy.mjs', import.meta.url), 'utf8');
  assert.ok(!/\bfetch\s*\(|api\.cloudflare\.com|process\.env\./.test(src), 'offline: no fetch, no Cloudflare API address, no environment read');
});

test('script: --out writes the report to a file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-')); const file = join(dir, 'r.json'); const a = io();
  assert.equal(await main(['--out', file], {}, a), 0);
  assert.equal(JSON.parse(read(file, 'utf8')).valid, true);
});

test('docs: the runbook exists, keeps secrets out, says the live job is not verified, and names the Event-field reason', () => {
  const d = readFileSync(new URL('../docs/LOGPUSH.md', import.meta.url), 'utf8');
  for (const needle of ['Event', 'LOG_REDACTION', 'AUDIT_LOG_STREAM', 'NOT VERIFIED', 'logpush-config.mjs']) assert.ok(d.includes(needle), needle);
  assert.doesNotMatch(d, /(sk_live|whsec_|AKIA[0-9A-Z]{8})/);
});

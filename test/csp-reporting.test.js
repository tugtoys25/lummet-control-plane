// Round 6.3C (stage _pre): CSP violation-report collection and the review procedure. CSP_MODE default is NOT flipped.
// Acceptance tests written first.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createAssets } from './support/public-env.js';
import worker from '../worker/index.js';
import * as csp from '../worker/csp.js';
import * as report from '../worker/csp-report.js';
import { configIssues } from '../worker/config-check.js';
import * as review from '../scripts/lib/csp-review.mjs';
import { main as reviewMain } from '../scripts/csp-report-review.mjs';

const html = (body, extra = {}) => new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ...extra } });
function env(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, ASSETS: createAssets(), CONTACT_EMAIL: 'hello@example.test', CREDENTIAL_KEK: btoa('k'.repeat(32)), ...extra }; }
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };

/** Posts a report through the real Worker and returns the status and every console.warn line. */
async function post(e, body, contentType = 'application/csp-report', headers = {}) {
  const logged = []; const orig = console.warn; console.warn = (m) => logged.push(String(m));
  try {
    const res = await worker.fetch(new Request('https://cp.test/api/csp-report', { method: 'POST', headers: { 'Content-Type': contentType, 'CF-Connecting-IP': '198.51.100.1', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }), e, ctx);
    return { status: res.status, lines: logged.map((l) => { try { return JSON.parse(l); } catch { return l; } }) };
  } finally { console.warn = orig; }
}

beforeEach(() => report.resetCspReportLimiter());

// ---- defaults are unchanged ---------------------------------------------------------------------------------------

test('CSP_MODE default is still report-only and nothing in the shipped config flips it to enforce', () => {
  assert.equal(csp.cspMode({}), 'report-only');
  assert.equal(csp.cspMode(undefined), 'report-only');
  assert.equal(csp.cspMode({ CSP_MODE: 'ENFORCE' }), 'enforce', 'the switch itself still works');
  for (const f of ['wrangler.jsonc', 'wrangler.example.jsonc']) assert.doesNotMatch(readFileSync(new URL('../' + f, import.meta.url), 'utf8'), /"CSP_MODE":\s*"enforce"/, f);
});

test('CSP_REPORT_MODE defaults to basic; only "full" turns the new collector on', () => {
  assert.equal(report.cspReportMode({}), 'basic');
  assert.equal(report.cspReportMode({ CSP_REPORT_MODE: 'full' }), 'full');
  assert.equal(report.cspReportMode({ CSP_REPORT_MODE: ' FULL ' }), 'full');
  for (const v of ['', 'on', 'yes', 'true', 'basic']) assert.equal(report.cspReportMode({ CSP_REPORT_MODE: v }), 'basic', v);
});

test('basic mode behaves exactly like 2.6.0.7: one record with four fields, query dropped, always 204, malformed ignored', async () => {
  const e = env();
  const r = await post(e, { 'csp-report': { 'document-uri': 'https://cp.test/app?token=SECRET', 'violated-directive': 'script-src-elem', 'blocked-uri': 'inline', 'script-sample': 'alert(1)', 'source-file': 'https://cp.test/x.js' } });
  assert.equal(r.status, 204);
  assert.equal(r.lines.length, 1);
  assert.deepEqual(r.lines[0], { csp_violation: true, directive: 'script-src-elem', blocked: 'inline', document: 'https://cp.test/app' });
  const bad = await post(e, 'not json'); assert.equal(bad.status, 204); assert.equal(bad.lines.length, 0);
  const big = await post(e, '{"csp-report":{"document-uri":"' + 'a'.repeat(20000) + '"}}'); assert.equal(big.status, 204);
  const reportingApiInBasic = await post(e, [{ type: 'csp-violation', url: 'https://cp.test/', body: { documentURL: 'https://cp.test/x?y=1', effectiveDirective: 'img-src', blockedURL: 'https://t.example/p.png?id=7' } }], 'application/reports+json');
  assert.equal(reportingApiInBasic.status, 204);
  assert.deepEqual(reportingApiInBasic.lines[0], { csp_violation: true, directive: 'img-src', blocked: 'https://t.example/p.png', document: 'https://cp.test/x' }, 'the old single-report array form still works');
});

// ---- full mode: collection ----------------------------------------------------------------------------------------

test('full mode: a legacy report is normalised and carries disposition, source and format', async () => {
  const e = env({ CSP_REPORT_MODE: 'full' });
  const r = await post(e, { 'csp-report': { 'document-uri': 'https://cp.test/app/team?x=1#frag', 'violated-directive': 'script-src-elem', 'effective-directive': 'script-src-elem', 'blocked-uri': 'https://evil.example/a.js?k=v', disposition: 'report', 'source-file': 'https://cp.test/app/team?z=2', 'line-number': 12 } });
  assert.equal(r.status, 204);
  assert.equal(r.lines.length, 1);
  assert.deepEqual(r.lines[0], { csp_violation: true, directive: 'script-src-elem', blocked: 'https://evil.example/a.js', document: 'https://cp.test/app/team', disposition: 'report', source: 'https://cp.test/app/team', line: 12, format: 'legacy' });
});

test('full mode: a Reporting API batch (application/reports+json) yields one record per csp-violation, other report types are ignored, and the batch is capped at 10', async () => {
  const e = env({ CSP_REPORT_MODE: 'full', CSP_REPORT_MAX_PER_MINUTE: '0' });
  const one = (i) => ({ type: 'csp-violation', age: 5, url: 'https://cp.test/p' + i, body: { documentURL: 'https://cp.test/p' + i + '?q=1', effectiveDirective: 'connect-src', blockedURL: 'https://t.example/c' + i, disposition: 'enforce', sourceFile: 'https://cp.test/static/app.js', lineNumber: 3 } });
  const batch = [one(1), { type: 'deprecation', body: { id: 'x' } }, one(2), one(3)];
  const r = await post(e, batch, 'application/reports+json');
  assert.equal(r.status, 204);
  assert.deepEqual(r.lines.map((l) => l.document), ['https://cp.test/p1', 'https://cp.test/p2', 'https://cp.test/p3']);
  assert.ok(r.lines.every((l) => l.format === 'reporting-api' && l.disposition === 'enforce' && l.directive === 'connect-src'));
  const many = await post(e, Array.from({ length: 25 }, (_, i) => one(i)), 'application/reports+json');
  assert.equal(many.lines.length, 10, 'batch cap');
});

test('full mode scrubs: query strings, fragments, tokens and ids in paths, scripts samples, control characters, and nonce values in the directive', async () => {
  const e = env({ CSP_REPORT_MODE: 'full' });
  const token = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
  const uuid = '6f1e2d3c-4b5a-4968-8776-655443322110';
  const r = await post(e, { 'csp-report': {
    'document-uri': `https://cp.test/app/reset-password/${token}/org/${uuid}/member/42?token=SECRET&email=jane@example.com#top`,
    'violated-directive': "script-src-elem 'nonce-abc123SECRETnonce'",
    'blocked-uri': `https://x.example/pixel/${token}.gif?uid=jane@example.com`,
    'script-sample': 'fetch("/api?email=jane@example.com")',
    'source-file': `https://cp.test/a/${uuid}?s=1`,
    'original-policy': "script-src 'nonce-abc123SECRETnonce'"
  } });
  assert.equal(r.lines.length, 1);
  const text = JSON.stringify(r.lines[0]);
  for (const bad of ['SECRET', 'jane', 'example.com/pixel', token, uuid, 'nonce', 'fetch(', 'top']) assert.equal(text.includes(bad), false, `"${bad}" must not be logged: ${text}`);
  assert.equal(r.lines[0].directive, 'script-src-elem');
  assert.equal(r.lines[0].document, 'https://cp.test/app/reset-password/:token/org/:id/member/:n');
  assert.equal(r.lines[0].blocked, 'https://x.example/pixel/:token');
  const allowed = new Set(['blocked', 'csp_violation', 'directive', 'disposition', 'document', 'format', 'line', 'source']);
  for (const k of Object.keys(r.lines[0])) assert.ok(allowed.has(k), `unexpected field ${k}`);
});

test('full mode: data:/blob: blocked URIs keep only the scheme; keywords like inline and eval pass; junk becomes empty; control characters are removed', () => {
  assert.equal(report.sanitizeReportUri('data:image/png;base64,AAAA'), 'data');
  assert.equal(report.sanitizeReportUri('blob:https://cp.test/6f1e2d3c-4b5a-4968-8776-655443322110'), 'blob');
  for (const k of ['inline', 'eval', 'self', 'wasm-eval']) assert.equal(report.sanitizeReportUri(k), k);
  assert.equal(report.sanitizeReportUri('chrome-extension://abcdefgh/inject.js?x=1'), 'chrome-extension://abcdefgh/inject.js');
  assert.equal(/[\u0000-\u001f\u007f]/.test(report.sanitizeReportUri('https://a.example/\u0000\u001b[31mred')), false, 'control characters never reach the log');
  assert.match(report.sanitizeReportUri('https://a.example/\u0000\u001b[31mred'), /^https:\/\/a\.example\//);
  assert.equal(report.sanitizeReportUri(undefined), '');
  assert.equal(report.sanitizeReportUri({ a: 1 }), '');
  assert.equal(report.sanitizeReportUri('x'.repeat(500)).length <= 200, true);
});

test('full mode: a report with neither directive nor URLs is dropped; non-JSON and non-object bodies are ignored; the answer is always 204', async () => {
  const e = env({ CSP_REPORT_MODE: 'full' });
  for (const body of ['', 'null', '42', '"str"', '[]', '{}', '{"csp-report":{}}', '[{"type":"csp-violation"}]', '[1,2,3]', '{"csp-report":"x"}']) {
    const r = await post(e, body);
    assert.equal(r.status, 204, body); assert.equal(r.lines.length, 0, body);
  }
});

test('full mode: a flood is capped per minute (default 60), one marker is logged, and the next minute starts fresh', async () => {
  const e = env({ CSP_REPORT_MODE: 'full', CSP_REPORT_MAX_PER_MINUTE: '3' });
  const body = (i) => JSON.stringify({ 'csp-report': { 'document-uri': 'https://cp.test/p' + i, 'violated-directive': 'img-src', 'blocked-uri': 'https://t.example/' + i } });
  const lines = [];
  const orig = console.warn; console.warn = (m) => lines.push(JSON.parse(m));
  try {
    for (let i = 0; i < 10; i++) assert.equal((await report.handleCspReport(new Request('https://cp.test/api/csp-report', { method: 'POST', body: body(i) }), e, 60_000 * 5 + i)).status, 204);
    const first = lines.filter((l) => l.csp_violation).length;
    const markers = lines.filter((l) => l.csp_violation_suppressed);
    assert.equal(first, 3); assert.equal(markers.length, 1, 'exactly one marker per window');
    await report.handleCspReport(new Request('https://cp.test/api/csp-report', { method: 'POST', body: body(99) }), e, 60_000 * 6 + 1);
    assert.equal(lines.filter((l) => l.csp_violation).length, 4, 'a new minute logs again');
  } finally { console.warn = orig; }
  assert.equal(report.cspReportLimit({}), 60);
  assert.equal(report.cspReportLimit({ CSP_REPORT_MAX_PER_MINUTE: '0' }), 0, '0 means unlimited');
  assert.equal(report.cspReportLimit({ CSP_REPORT_MAX_PER_MINUTE: 'abc' }), 60);
  assert.equal(report.cspReportLimit({ CSP_REPORT_MAX_PER_MINUTE: '-5' }), 60);
});

test('basic mode never caps (2.6.0.7 behaviour)', async () => {
  const e = env({ CSP_REPORT_MAX_PER_MINUTE: '1' });
  let total = 0;
  for (let i = 0; i < 5; i++) total += (await post(e, { 'csp-report': { 'document-uri': 'https://cp.test/x', 'violated-directive': 'img-src', 'blocked-uri': 'inline' } })).lines.length;
  assert.equal(total, 5);
});

test('the report endpoint stays open: no auth, no CSRF block, never rate limited by the WAF config', async () => {
  const e = env({ CSP_REPORT_MODE: 'full' });
  const r = await post(e, { 'csp-report': { 'document-uri': 'https://cp.test/a', 'violated-directive': 'img-src', 'blocked-uri': 'inline' } }, 'application/csp-report', { Cookie: 'lummet_session=x', Origin: 'https://evil.example' });
  assert.equal(r.status, 204);
  const waf = JSON.parse(readFileSync(new URL('../config/cloudflare-waf-rate-limits.v1.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(JSON.stringify(waf.rules), /csp-report/);
});

// ---- headers: Reporting-Endpoints / report-to ---------------------------------------------------------------------

test('basic mode: the report-only header is byte-for-byte what 2.6.0.7 sent and there is no Reporting-Endpoints header', async () => {
  const r = await csp.finalizeResponse(html('<p>x</p>'), {});
  assert.match(r.headers.get('Content-Security-Policy-Report-Only'), /script-src 'nonce-[^']+'; script-src-attr 'none'; report-uri \/api\/csp-report$/);
  assert.equal(r.headers.get('Reporting-Endpoints'), null);
});

test('full mode, report-only: report-uri plus report-to and a same-origin Reporting-Endpoints header', async () => {
  const r = await csp.finalizeResponse(html('<p>x</p>'), { CSP_REPORT_MODE: 'full' });
  assert.match(r.headers.get('Content-Security-Policy-Report-Only'), /; report-uri \/api\/csp-report; report-to csp-endpoint$/);
  assert.equal(r.headers.get('Reporting-Endpoints'), 'csp-endpoint="/api/csp-report"');
});

test('full mode, enforce: the enforced policy keeps reporting so a regression after the flip is visible; basic enforce does not', async () => {
  const full = await csp.finalizeResponse(html('<p>x</p>'), { CSP_MODE: 'enforce', CSP_REPORT_MODE: 'full' });
  assert.match(full.headers.get('Content-Security-Policy'), /script-src 'nonce-[^']+'; script-src-attr 'none'; report-uri \/api\/csp-report; report-to csp-endpoint$/);
  assert.equal(full.headers.get('Content-Security-Policy-Report-Only'), null);
  assert.equal(full.headers.get('Reporting-Endpoints'), 'csp-endpoint="/api/csp-report"');
  const basic = await csp.finalizeResponse(html('<p>x</p>'), { CSP_MODE: 'enforce' });
  assert.doesNotMatch(basic.headers.get('Content-Security-Policy'), /report-/);
  assert.equal(basic.headers.get('Reporting-Endpoints'), null);
});

test('non-HTML responses and pages that bring their own policy are untouched by CSP_REPORT_MODE', async () => {
  const own = "default-src 'self'; script-src 'self'";
  const a = await csp.finalizeResponse(html('x', { 'Content-Security-Policy': own }), { CSP_REPORT_MODE: 'full' });
  assert.equal(a.headers.get('Content-Security-Policy'), own);
  assert.equal(a.headers.get('Reporting-Endpoints'), null);
  const j = await csp.finalizeResponse(new Response('{}', { headers: { 'Content-Type': 'application/json' } }), { CSP_REPORT_MODE: 'full' });
  assert.equal(j.headers.get('Reporting-Endpoints'), null);
});

// ---- config-check -------------------------------------------------------------------------------------------------

test('config-check: production requires CSP_REPORT_MODE to be set explicitly to basic or full; CSP_MODE=enforce is still required', () => {
  const keys = (e) => configIssues({ ENVIRONMENT: 'production', ...e }).map((i) => i.key);
  assert.ok(keys({}).includes('CSP_REPORT_MODE'));
  assert.ok(keys({ CSP_REPORT_MODE: 'on' }).includes('CSP_REPORT_MODE'));
  assert.ok(!keys({ CSP_REPORT_MODE: 'basic' }).includes('CSP_REPORT_MODE'));
  assert.ok(!keys({ CSP_REPORT_MODE: 'full' }).includes('CSP_REPORT_MODE'));
  assert.ok(keys({ CSP_REPORT_MODE: 'full' }).includes('CSP_MODE'), 'unchanged from 2.6.0.7');
  assert.ok(keys({ CSP_REPORT_MODE: 'full', CSP_REPORT_MAX_PER_MINUTE: 'abc' }).includes('CSP_REPORT_MAX_PER_MINUTE'));
  assert.ok(!keys({ CSP_REPORT_MODE: 'full', CSP_REPORT_MAX_PER_MINUTE: '120' }).includes('CSP_REPORT_MAX_PER_MINUTE'));
  assert.ok(!keys({ CSP_REPORT_MODE: 'full' }).includes('CSP_REPORT_MAX_PER_MINUTE'), 'optional, default 60');
});

// ---- review procedure (offline tool over Worker logs) -------------------------------------------------------------

const V = (o = {}) => ({ csp_violation: true, directive: 'script-src-elem', blocked: 'inline', document: 'https://cp.test/app', ...o });
const day = (n) => `2026-11-${String(n).padStart(2, '0')}T00:00:00Z`;

test('review: extracts violations from plain lines, wrangler tail JSON and Logpush workers_trace_events, and skips junk', () => {
  const plain = JSON.stringify(V());
  const tail = JSON.stringify({ outcome: 'ok', logs: [{ message: [JSON.stringify(V({ directive: 'img-src' }))], level: 'warn', timestamp: Date.parse(day(2)) }] });
  const logpush = JSON.stringify({ Event: { RequestURL: 'https://cp.test/api/csp-report' }, Logs: [{ Level: 'warn', Message: [JSON.stringify(V({ directive: 'connect-src' }))], TimestampMs: Date.parse(day(3)) }, { Level: 'log', Message: ['hello'], TimestampMs: 1 }], EventTimestampMs: Date.parse(day(3)) });
  const text = [plain, tail, logpush, 'garbage line', '', '{"msg":"unrelated"}'].join('\n');
  const out = review.extractViolations(text);
  assert.equal(out.violations.length, 3);
  assert.deepEqual(out.violations.map((v) => v.directive).sort(), ['connect-src', 'img-src', 'script-src-elem']);
  assert.equal(out.skipped, 1, 'one unparsable line');
  assert.equal(out.lines, 4, 'four parseable JSON lines (the blank line and the garbage line are not)');
  assert.equal(out.suppressed, 0);
  assert.ok(out.violations.find((v) => v.directive === 'img-src').ts, 'timestamp carried from the wrapper');
});

test('review: suppression markers are counted; records are not trusted blindly (fields are re-sanitised and truncated)', () => {
  const text = [JSON.stringify({ csp_violation_suppressed: true }), JSON.stringify(V({ blocked: 'x'.repeat(900), directive: 'img-src <script>' }))].join('\n');
  const out = review.extractViolations(text);
  assert.equal(out.suppressed, 1);
  assert.equal(out.violations[0].blocked.length <= 200, true);
  assert.equal(/[<>]/.test(out.violations[0].directive), false);
});

test('review: aggregate groups by directive, blocked and document, counts, and sorts most frequent first', () => {
  const vs = [V(), V(), V({ directive: 'img-src', blocked: 'https://t.example/p.png' }), V({ document: 'https://cp.test/other' })];
  const rows = review.aggregate(vs);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { directive: 'script-src-elem', blocked: 'inline', document: 'https://cp.test/app', count: 2, first: null, last: null });
  assert.ok(rows[0].count >= rows[1].count && rows[1].count >= rows[2].count);
});

test('review: verdicts - NO_INPUT, VIOLATIONS_FOUND, INCOMPLETE, WINDOW_TOO_SHORT, NO_VIOLATIONS_IN_WINDOW', () => {
  const base = { violations: [], suppressed: 0, lines: 10, from: day(1), to: day(9), minDays: 7 };
  assert.equal(review.verdict({ ...base, lines: 0 }).code, 'NO_INPUT');
  assert.equal(review.verdict({ ...base, violations: [V()] }).code, 'VIOLATIONS_FOUND');
  assert.equal(review.verdict({ ...base, suppressed: 2 }).code, 'INCOMPLETE');
  assert.equal(review.verdict({ ...base, to: day(4) }).code, 'WINDOW_TOO_SHORT');
  assert.equal(review.verdict({ ...base, from: null, to: null }).code, 'WINDOW_TOO_SHORT', 'an unstated window is not assumed');
  assert.equal(review.verdict({ ...base, from: 'junk', to: day(9) }).code, 'WINDOW_TOO_SHORT');
  const ok = review.verdict(base);
  assert.equal(ok.code, 'NO_VIOLATIONS_IN_WINDOW'); assert.equal(ok.pass, true);
  assert.match(ok.message, /coverage|page type/i, 'the verdict reminds the reviewer that silence is only meaningful if every page type was visited');
  for (const c of ['NO_INPUT', 'VIOLATIONS_FOUND', 'INCOMPLETE', 'WINDOW_TOO_SHORT']) assert.equal(review.verdict({ ...base, ...(c === 'NO_INPUT' ? { lines: 0 } : c === 'VIOLATIONS_FOUND' ? { violations: [V()] } : c === 'INCOMPLETE' ? { suppressed: 1 } : { to: day(2) }) }).pass, false, c);
  assert.equal(review.DEFAULT_MIN_DAYS, 7, 'the default window is a placeholder [OPEN], documented as such');
});

test('review CLI: reads files, prints a table or JSON, exit 0 only when the verdict passes, 2 on bad usage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'csp-review-'));
  const clean = join(dir, 'clean.ndjson'); writeFileSync(clean, [JSON.stringify({ msg: 'x' }), JSON.stringify({ msg: 'y' })].join('\n'));
  const dirty = join(dir, 'dirty.ndjson'); writeFileSync(dirty, [JSON.stringify(V()), JSON.stringify(V())].join('\n'));
  const io = () => { const out = [], err = []; return { out, err, log: (m) => out.push(String(m)), error: (m) => err.push(String(m)) }; };
  const a = io(); assert.equal(await reviewMain([clean, '--from', day(1), '--to', day(9)], {}, a), 0);
  assert.match(a.out.join('\n'), /NO_VIOLATIONS_IN_WINDOW/);
  const b = io(); assert.equal(await reviewMain([dirty, '--from', day(1), '--to', day(9)], {}, b), 1);
  assert.match(b.out.join('\n'), /VIOLATIONS_FOUND/); assert.match(b.out.join('\n'), /script-src-elem/);
  const c = io(); assert.equal(await reviewMain([dirty, '--from', day(1), '--to', day(9), '--json'], {}, c), 1);
  const parsed = JSON.parse(c.out.join('')); assert.equal(parsed.verdict.code, 'VIOLATIONS_FOUND'); assert.equal(parsed.rows[0].count, 2);
  const d = io(); assert.equal(await reviewMain([clean, '--from', day(1), '--to', day(3)], {}, d), 1); assert.match(d.out.join('\n'), /WINDOW_TOO_SHORT/);
  const e2 = io(); assert.equal(await reviewMain([clean, '--from', day(1), '--to', day(3), '--min-days', '2'], {}, e2), 0);
  const f = io(); assert.equal(await reviewMain([], {}, f), 2); assert.match(f.err.join(), /Usage/);
  const g = io(); assert.equal(await reviewMain([join(dir, 'missing.ndjson')], {}, g), 2); assert.match(g.err.join(), /missing\.ndjson/);
  const h = io(); assert.equal(await reviewMain([clean, '--min-days', 'abc'], {}, h), 2);
});

test('docs: the review procedure is written down, never says CSP_MODE should be flipped by default, and labels live evidence as NOT VERIFIED', () => {
  const doc = readFileSync(new URL('../docs/CSP_REPORTING.md', import.meta.url), 'utf8');
  assert.match(doc, /csp-report-review/);
  assert.match(doc, /CSP_REPORT_MODE/);
  assert.match(doc, /NOT VERIFIED/);
  assert.match(doc, /\[OPEN\]/);
  assert.match(doc, /page type/i);
  assert.doesNotMatch(doc, /default.{0,40}enforce/i, 'no sentence proposes enforce as a default');
});

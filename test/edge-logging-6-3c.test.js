// Round 6.3C (stage 2): audit stream, console redaction wiring, config-check rules, defaults. Live Cloudflare behavior is NOT VERIFIED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import { logAudit } from '../worker/audit.js';
import { auditStreamMode, auditStreamLine } from '../worker/audit-stream.js';
import { containsSensitive } from '../worker/redact.js';
import { configIssues } from '../worker/config-check.js';
import { resetErrorTrackingForTests } from '../worker/error-tracking.js';

const j = (...p) => p.join('');
const STRIPE = j('sk_', 'live_', '4eC39HqLyjWDarjtT1zdp7dc');
const DSN = 'https://0123abcd4567ef89@o42.ingest.tracker.example/4501';
const mk = (extra = {}) => { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ...extra }; };
function capture() {
  const out = []; const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const k of Object.keys(saved)) console[k] = (...a) => out.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  return { out, restore: () => Object.assign(console, saved) };
}
const ENTRY = { adminId: 'adm_1', action: 'refund', resource: 'invoice', resourceId: 'in_123', success: true, statusCode: 200, method: 'POST', endpoint: '/api/platform/refund?token=SECRETQUERY', requestId: '6f1e2d3c-1111-2222-3333-444455556666', reason: `customer jane.doe@example.com asked from 203.0.113.7 using ${STRIPE}`, errorMessage: 'password=hunter2', ipHash: 'deadbeefdeadbeef', organizationId: 'org_9' };

// ---- audit stream ----------------------------------------------------------------------------------------------------

test('AUDIT_LOG_STREAM is off unless it is exactly "on"', () => {
  assert.equal(auditStreamMode({}), 'off'); assert.equal(auditStreamMode(undefined), 'off');
  assert.equal(auditStreamMode({ AUDIT_LOG_STREAM: ' ON ' }), 'on');
  for (const v of ['', 'off', 'true', 'yes', '1', 'shadow']) assert.equal(auditStreamMode({ AUDIT_LOG_STREAM: v }), 'off', v);
  assert.equal(auditStreamLine({}, ENTRY), null);
});

test('off (default): logAudit writes the D1 row and nothing to the log', async () => {
  const e = mk(); const c = capture();
  try { await logAudit(e, ENTRY); } finally { c.restore(); }
  assert.deepEqual(c.out, []);
  assert.equal((await e.LUMMET_DB.prepare('SELECT COUNT(*) AS n FROM lummet_audit_logs').first()).n, 1);
});

test('on: one allowlisted, scrubbed JSON line per audit row; the D1 row is unchanged', async () => {
  const e = mk({ AUDIT_LOG_STREAM: 'on' }); const c = capture();
  try { await logAudit(e, ENTRY); } finally { c.restore(); }
  assert.equal(c.out.length, 1);
  const line = JSON.parse(c.out[0]);
  assert.equal(line.event, 'audit'); assert.equal(line.action, 'refund'); assert.equal(line.resource_id, 'in_123'); assert.equal(line.success, true); assert.equal(line.status_code, 200);
  assert.equal(line.endpoint, '/api/platform/refund'); assert.equal(line.actor_type, 'lummet_admin'); assert.equal(line.organization_id, 'org_9');
  assert.deepEqual(containsSensitive(c.out[0]), [], c.out[0]);
  for (const leaked of ['jane.doe', '203.0.113.7', STRIPE, 'SECRETQUERY', 'hunter2', 'deadbeef']) assert.ok(!c.out[0].includes(leaked), leaked);
  assert.ok(!('ip_hash' in line));
  const row = await e.LUMMET_DB.prepare('SELECT action, ip_hash FROM lummet_audit_logs').first();
  assert.equal(row.action, 'refund'); assert.equal(row.ip_hash, 'deadbeefdeadbeef', 'the system of record keeps what it always kept');
});

test('on: only the allowlisted fields can appear, whatever the entry carries', () => {
  const line = JSON.parse(auditStreamLine({ AUDIT_LOG_STREAM: 'on' }, { ...ENTRY, password: 'p', token: 't', body: { card: '4242424242424242' }, cookie: 'sid=1' }));
  const allowed = new Set(['level', 'event', 'action', 'resource', 'resource_id', 'success', 'status_code', 'method', 'endpoint', 'request_id', 'actor_type', 'initiated_by', 'admin_id', 'tenant_id', 'organization_id', 'customer_user_id', 'reason', 'error_message']);
  for (const k of Object.keys(line)) assert.ok(allowed.has(k), k);
});

test('on: the stream never breaks an audit write, whatever it is given', async () => {
  const e = mk({ AUDIT_LOG_STREAM: 'on' }); const c = capture();
  try {
    await assert.doesNotReject(logAudit(e, { get action() { throw new Error('getter'); } }));
    await assert.doesNotReject(logAudit(e, null));
    await assert.doesNotReject(logAudit({ AUDIT_LOG_STREAM: 'on' }, ENTRY));
  } finally { c.restore(); }
});

// ---- LOG_REDACTION wiring ----------------------------------------------------------------------------------------------

function failingOn(db, needle, message) { return { prepare(sql) { if (sql.includes(needle)) throw new Error(message); return db.prepare(sql); }, batch: (x) => db.batch(x), exec: (x) => db.exec(x) }; }
async function failingRequest(extra) {
  resetErrorTrackingForTests();
  const e = mk(extra); e.LUMMET_DB = failingOn(e.LUMMET_DB, 'customer_sessions', 'D1_ERROR for jane.doe@example.com at 203.0.113.7');
  const c = capture(); const p = []; const ctx = { waitUntil: (x) => p.push(Promise.resolve(x).catch(() => {})) };
  try {
    const res = await worker.fetch(new Request('https://cp.test/api/organizations/6f1e2d3c-1111-2222-3333-444455556666/notifications', { headers: { Cookie: 'lummet_customer_session=abc' } }), e, ctx);
    await res.text(); await Promise.all(p);
    return { status: res.status, log: c.out.join('\n') };
  } finally { c.restore(); }
}

test('LOG_REDACTION=on: the error line the Worker logs for an unhandled exception carries no email or address', async () => {
  const r = await failingRequest({ LOG_REDACTION: 'on' });
  assert.equal(r.status, 500); assert.ok(r.log.includes('unhandled_exception'), r.log);
  assert.ok(!r.log.includes('jane.doe') && !r.log.includes('203.0.113.7'), r.log);
});

test('LOG_REDACTION off (default): behaviour is unchanged from 2.6.0.7, so the same line is logged as before', async () => {
  const r = await failingRequest({});
  assert.equal(r.status, 500); assert.ok(r.log.includes('jane.doe'), 'the default does not scrub; the owner turns it on');
});

test('every logging flag off: nothing extra is logged and no tracker is contacted', async () => {
  const realFetch = globalThis.fetch; let called = 0; globalThis.fetch = async () => { called++; return new Response('{}'); };
  try { const r = await failingRequest({ SENTRY_DSN: DSN }); assert.ok(!r.log.includes('error_tracking')); } finally { globalThis.fetch = realFetch; }
  assert.equal(called, 0);
});

test('the security headers stay on every response with every new flag switched on', async () => {
  const e = mk({ LOG_REDACTION: 'on', AUDIT_LOG_STREAM: 'on', ERROR_TRACKING: 'shadow' }); const c = capture();
  try {
    for (const path of ['/login', '/api/health', '/definitely-not-a-page', '/robots.txt']) {
      const res = await worker.fetch(new Request('https://cp.test' + path), e, { waitUntil() {} });
      assert.ok(res.headers.get('Strict-Transport-Security'), path); assert.equal((res.headers.get('X-Content-Type-Options') || '').toLowerCase(), 'nosniff', path); assert.ok(res.headers.get('X-Request-Id'), path);
    }
  } finally { c.restore(); }
});

// ---- config-check: production requires the new settings ---------------------------------------------------------------

const keys = (extra) => configIssues({ ENVIRONMENT: 'production', ...extra }).map((i) => i.key);

test('config-check: production requires ERROR_TRACKING, LOG_REDACTION and AUDIT_LOG_STREAM to be set explicitly', () => {
  for (const k of ['ERROR_TRACKING', 'LOG_REDACTION', 'AUDIT_LOG_STREAM']) { assert.ok(keys({}).includes(k), k); assert.ok(keys({ [k]: 'maybe' }).includes(k), k); }
  assert.ok(!keys({ ERROR_TRACKING: 'off' }).includes('ERROR_TRACKING')); assert.ok(!keys({ ERROR_TRACKING: 'shadow' }).includes('ERROR_TRACKING')); assert.ok(!keys({ ERROR_TRACKING: 'on' }).includes('ERROR_TRACKING'));
  assert.ok(!keys({ LOG_REDACTION: 'on' }).includes('LOG_REDACTION')); assert.ok(!keys({ AUDIT_LOG_STREAM: 'off' }).includes('AUDIT_LOG_STREAM'));
  assert.ok(!keys({ ERROR_TRACKING: 'shadow' }).includes('ERROR_TRACKING'), 'shadow is a valid explicit choice');
});

test('config-check: ERROR_TRACKING=on needs a valid DSN and the recorded owner approval; off and shadow need neither', () => {
  assert.ok(keys({ ERROR_TRACKING: 'on' }).includes('SENTRY_DSN')); assert.ok(keys({ ERROR_TRACKING: 'on', SENTRY_DSN: 'http://k@h.example/1' }).includes('SENTRY_DSN'));
  assert.ok(!keys({ ERROR_TRACKING: 'on', SENTRY_DSN: DSN }).includes('SENTRY_DSN'));
  assert.ok(keys({ ERROR_TRACKING: 'on', SENTRY_DSN: DSN }).includes('ERROR_TRACKING_APPROVED')); assert.ok(keys({ ERROR_TRACKING: 'on', SENTRY_DSN: DSN, ERROR_TRACKING_APPROVED: 'no' }).includes('ERROR_TRACKING_APPROVED'));
  assert.ok(!keys({ ERROR_TRACKING: 'on', SENTRY_DSN: DSN, ERROR_TRACKING_APPROVED: 'yes' }).includes('ERROR_TRACKING_APPROVED'));
  for (const mode of ['off', 'shadow']) { assert.ok(!keys({ ERROR_TRACKING: mode }).includes('SENTRY_DSN')); assert.ok(!keys({ ERROR_TRACKING: mode }).includes('ERROR_TRACKING_APPROVED')); }
});

test('config-check: the audit stream may not be on while LOG_REDACTION is not on; the events cap must be a whole number', () => {
  assert.ok(keys({ AUDIT_LOG_STREAM: 'on', LOG_REDACTION: 'off' }).includes('AUDIT_LOG_STREAM/LOG_REDACTION'));
  assert.ok(!keys({ AUDIT_LOG_STREAM: 'on', LOG_REDACTION: 'on' }).includes('AUDIT_LOG_STREAM/LOG_REDACTION'));
  assert.ok(!keys({ AUDIT_LOG_STREAM: 'off', LOG_REDACTION: 'off' }).includes('AUDIT_LOG_STREAM/LOG_REDACTION'));
  assert.ok(keys({ ERROR_TRACKING_MAX_PER_MINUTE: 'lots' }).includes('ERROR_TRACKING_MAX_PER_MINUTE')); assert.ok(!keys({ ERROR_TRACKING_MAX_PER_MINUTE: '10' }).includes('ERROR_TRACKING_MAX_PER_MINUTE')); assert.ok(!keys({}).includes('ERROR_TRACKING_MAX_PER_MINUTE'));
  assert.deepEqual(configIssues({ ENVIRONMENT: 'staging' }), [], 'staging is not nagged');
});

test('the issue list names settings only; no value, DSN or secret appears in it', () => {
  const text = JSON.stringify(configIssues({ ENVIRONMENT: 'production', ERROR_TRACKING: 'on', SENTRY_DSN: 'https://0123abcd4567ef89@o42.ingest.tracker.example/4501x y' }));
  assert.ok(!text.includes('0123abcd4567ef89') && !text.includes('tracker.example'));
});

// ---- defaults shipped -----------------------------------------------------------------------------------------------------

test('wrangler.jsonc and wrangler.example.jsonc ship every new flag off, the DSN is not a var, and CSP_MODE is not flipped to enforce', () => {
  for (const f of ['../wrangler.jsonc', '../wrangler.example.jsonc']) {
    const t = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(t, /"ERROR_TRACKING": "off"/, f); assert.match(t, /"ERROR_TRACKING_APPROVED": "no"/, f); assert.match(t, /"LOG_REDACTION": "off"/, f); assert.match(t, /"AUDIT_LOG_STREAM": "off"/, f);
    assert.ok(!/"SENTRY_DSN"\s*:/.test(t), 'a secret is set with wrangler secret put, never as a var');
    assert.ok(!/"CSP_MODE": "enforce"/.test(t), f);
  }
});

test('docs: the error-tracking runbook exists and states what is scrubbed, that the provider is an owner decision, and that nothing is verified live', () => {
  const d = readFileSync(new URL('../docs/ERROR_TRACKING.md', import.meta.url), 'utf8');
  for (const needle of ['SENTRY_DSN', 'ERROR_TRACKING', 'shadow', 'sub-processor', 'NOT VERIFIED', '[OPEN]']) assert.ok(d.includes(needle), needle);
  assert.doesNotMatch(d, /sk_live|whsec_/);
});

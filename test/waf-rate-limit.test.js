// Round 6.3A: WAF rate-limit config, apply script, Worker Retry-After, production config requirements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import { withRetryAfter, retryAfterSeconds, retryAfterMode } from '../worker/rate-limit-response.js';
import { configIssues } from '../worker/config-check.js';
import { main } from '../scripts/cloudflare-waf-rate-limit-config.mjs';
import { loadConfig, validateConfig, applyThresholds, buildManagedRules, compileExpression, ruleMatches, readPlanLimits, checkAgainstPlan } from '../scripts/lib/waf-rate-limits.mjs';

const indexSrc = readFileSync(new URL('../worker/index.js', import.meta.url), 'utf8');
const ZONE = 'a'.repeat(32);
const PLAN = { CF_WAF_MAX_RULES: '10', CF_WAF_ALLOWED_PERIODS: '10,60,600', CF_WAF_MAX_TIMEOUT: '3600' };
const APPLY_ENV = { CF_API_TOKEN: 'tok_secret_value', CF_WAF_ZONE_ID: ZONE, CF_WAF_ENVIRONMENT: 'staging', WAF_THRESHOLDS_CONFIRMED: 'yes', ...PLAN };

function io() { const out = []; const err = []; return { out, err, log: (m) => out.push(String(m)), error: (m) => err.push(String(m)) }; }
function cfFetch({ existing = [], status = 200, putStatus = 200 } = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization });
    if (init.method === 'GET') return status === 404 ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({ success: true, result: { id: 'rs', rules: existing } }), { status });
    return new Response(JSON.stringify({ success: putStatus < 400, errors: putStatus < 400 ? [] : [{ message: 'bad expression' }] }), { status: putStatus });
  };
  f.calls = calls; return f;
}

// ---- config file
test('config file is valid, versioned, and never rate-limits the Stripe webhook or the CSP report endpoint', () => {
  const config = loadConfig();
  assert.deepEqual(validateConfig(config), []);
  assert.equal(config.version, 1); assert.deepEqual(config.rules.map((r) => r.key), ['auth-staff', 'auth-customer', 'invitations', 'billing', 'contact']);
  for (const rule of config.rules) for (const m of ['GET', 'POST', 'PUT']) for (const never of config.neverRateLimit) assert.equal(ruleMatches(rule, m, never), false, `${rule.key} ${m} ${never}`);
  const bad = structuredClone(config); bad.rules[3].match.paths.push({ exact: '/api/billing/webhook/stripe' }); bad.rules[3].match.methods = ['POST'];
  assert.match(validateConfig(bad).join(';'), /would match protected path/);
});

test('every exact path in the config is a real route in the worker, and the rules cover the real sensitive routes', () => {
  const config = loadConfig();
  for (const rule of config.rules) for (const p of rule.match.paths) {
    if (p.exact && !p.exact.startsWith('/contact') && !p.exact.startsWith('/forms')) assert.ok(indexSrc.includes(`"${p.exact}"`), `${p.exact} is not a worker route`);
  }
  const covered = (method, path) => config.rules.some((r) => ruleMatches(r, method, path));
  for (const path of ['/api/auth/login', '/api/auth/login/mfa', '/api/customer/login', '/api/customer/signup', '/api/customer/password/forgot', '/api/customer/password/reset', '/api/customer/mfa/complete', '/api/customer/webauthn/login/verify', '/api/invitations/tok123/accept', '/api/organizations/org1/invitations', '/api/organizations/org1/billing/checkout', '/api/organizations/org1/billing/portal', '/api/organizations/org1/billing/change-plan', '/contact', '/contact-sales', '/forms/demo']) assert.equal(covered('POST', path), true, path);
  for (const [m, path] of [['GET', '/api/auth/login'], ['GET', '/contact'], ['POST', '/api/billing/webhook/stripe'], ['GET', '/api/organizations/org1/billing/profile'], ['POST', '/api/organizations/org1/sites'], ['POST', '/']]) assert.equal(covered(m, path), false, `${m} ${path}`);
});

test('compiled rules are Cloudflare ratelimit rules with block action, ip.src and the configured thresholds', () => {
  const config = loadConfig(); const rules = buildManagedRules(config);
  assert.equal(rules.length, 5);
  for (const r of rules) {
    assert.match(r.ref, /^lummet-v1-[a-z-]+$/); assert.equal(r.action, 'block'); assert.equal(r.enabled, true);
    assert.deepEqual(r.ratelimit.characteristics, ['ip.src']); assert.ok(r.ratelimit.requests_per_period > 0 && r.ratelimit.period > 0 && r.ratelimit.mitigation_timeout > 0);
    assert.doesNotMatch(r.expression, /["'][^"']*\\/);
  }
  assert.match(compileExpression(config.rules[0]), /http\.request\.method in \{"POST"\}/);
});

test('threshold overrides: valid ones apply; unknown rules, unknown fields and bad numbers are rejected', () => {
  const config = loadConfig();
  const ok = applyThresholds(config, '{"billing":{"requests":7,"period":120,"timeout":900}}');
  assert.deepEqual(ok.errors, []); const b = ok.rules.find((r) => r.key === 'billing'); assert.deepEqual([b.requests, b.period, b.timeout], [7, 120, 900]);
  for (const raw of ['{"nope":{"requests":1}}', '{"billing":{"speed":1}}', '{"billing":{"requests":0}}', '{"billing":{"requests":"5"}}', '[1]', '{bad']) assert.ok(applyThresholds(config, raw).errors.length, raw);
  assert.deepEqual(applyThresholds(config, '').errors, []);
});

test('plan limits: unknown limits are reported, and rule count, period and timeout are checked', () => {
  assert.deepEqual(readPlanLimits({}).missing.sort(), ['CF_WAF_ALLOWED_PERIODS', 'CF_WAF_MAX_RULES', 'CF_WAF_MAX_TIMEOUT']);
  const { limits, missing } = readPlanLimits(PLAN); assert.deepEqual(missing, []);
  const rules = applyThresholds(loadConfig(), '').rules;
  assert.deepEqual(checkAgainstPlan(rules, 0, limits), []);
  assert.match(checkAgainstPlan(rules, 6, limits).join(';'), /plan allows 10/);
  assert.match(checkAgainstPlan(rules, 0, { ...limits, periods: [10] }).join(';'), /period 60s is not allowed/);
  assert.match(checkAgainstPlan(rules, 0, { ...limits, maxTimeout: 60 }).join(';'), /exceeds the plan maximum/);
});

// ---- apply script
test('dry run is the default: it never calls Cloudflare, mutates nothing, prints the rules and the blockers', async () => {
  const f = cfFetch(); const o = io();
  const code = await main([], { ...APPLY_ENV }, f, o);
  assert.equal(code, 0); assert.equal(f.calls.length, 0, 'no network at all'); const report = JSON.parse(o.out.join('\n'));
  assert.equal(report.dryRun, true); assert.equal(report.mutates, false); assert.equal(report.rules.length, 5); assert.deepEqual(report.applyBlockedBy, []);
  assert.doesNotMatch(o.out.join('\n'), /tok_secret_value/);
  const o2 = io(); await main([], {}, f, o2); const blocked = JSON.parse(o2.out.join('\n')).applyBlockedBy.join(' | ');
  assert.match(blocked, /CF_WAF_ZONE_ID/); assert.match(blocked, /plan limits unknown/); assert.match(blocked, /thresholds are not confirmed/);
  assert.equal(f.calls.length, 0);
});

test('--diff is read-only: one GET, no PUT, and it shows add/update/remove with unmanaged rules preserved', async () => {
  const f = cfFetch({ existing: [{ ref: 'lummet-v1-billing', expression: 'old' }, { ref: 'lummet-v1-retired', expression: 'x' }, { ref: 'customer-own', expression: 'y' }] }); const o = io();
  assert.equal(await main(['--diff'], APPLY_ENV, f, o), 0);
  assert.deepEqual(f.calls.map((c) => c.method), ['GET']);
  const plan = JSON.parse(o.out.join('\n')).plan;
  assert.deepEqual(plan.update, ['lummet-v1-billing']); assert.deepEqual(plan.remove, ['lummet-v1-retired']); assert.equal(plan.preservedUnmanaged, 1); assert.equal(plan.add.length, 4);
});

test('apply refuses without the required inputs and never calls Cloudflare to change anything', async () => {
  const cases = [
    ['no zone', { ...APPLY_ENV, CF_WAF_ZONE_ID: '' }, ['--apply']],
    ['bad zone', { ...APPLY_ENV, CF_WAF_ZONE_ID: 'abc' }, ['--apply']],
    ['no token', { ...APPLY_ENV, CF_API_TOKEN: '' }, ['--apply']],
    ['environment mismatch', { ...APPLY_ENV, CF_WAF_ENVIRONMENT: 'production' }, ['--apply']],
    ['environment unset', { ...APPLY_ENV, CF_WAF_ENVIRONMENT: '' }, ['--apply']],
    ['plan limits unknown', { ...APPLY_ENV, CF_WAF_MAX_RULES: '' }, ['--apply']],
    ['thresholds unconfirmed', { ...APPLY_ENV, WAF_THRESHOLDS_CONFIRMED: 'no' }, ['--apply']],
    ['period not allowed', { ...APPLY_ENV, CF_WAF_ALLOWED_PERIODS: '10' }, ['--apply']],
    ['rollback without apply', APPLY_ENV, ['--rollback']],
    ['bad mode', APPLY_ENV, ['--mode', 'qa']],
    ['bad thresholds json', { ...APPLY_ENV, WAF_RATE_LIMIT_THRESHOLDS: '{x' }, ['--apply']],
    ['production without approval', { ...APPLY_ENV, CF_WAF_ENVIRONMENT: 'production' }, ['--mode', 'production', '--apply']],
    ['production flag without env approval', { ...APPLY_ENV, CF_WAF_ENVIRONMENT: 'production' }, ['--mode', 'production', '--apply', '--allow-production']],
    ['production env approval without flag', { ...APPLY_ENV, CF_WAF_ENVIRONMENT: 'production', CF_WAF_CHANGES_APPROVED: 'true' }, ['--mode', 'production', '--apply']]
  ];
  for (const [name, env, argv] of cases) {
    const f = cfFetch(); const o = io(); const code = await main(argv, env, f, o);
    assert.notEqual(code, 0, name); assert.ok(!f.calls.some((c) => c.method !== 'GET'), `${name}: no mutation`);
    assert.doesNotMatch(o.err.join('\n') + o.out.join('\n'), /tok_secret_value/, `${name}: token never printed`);
  }
});

test('apply (staging) PUTs managed rules, preserves unmanaged rules, replaces stale managed ones, and is idempotent', async () => {
  const foreign = { id: 'f1', ref: 'customer-own', expression: 'true', action: 'block' };
  const f = cfFetch({ existing: [foreign, { ref: 'lummet-v1-retired', expression: 'x' }] }); const o = io();
  assert.equal(await main(['--apply'], APPLY_ENV, f, o), 0);
  assert.deepEqual(f.calls.map((c) => c.method), ['GET', 'PUT']);
  const put = f.calls[1]; assert.match(put.url, new RegExp(`/zones/${ZONE}/rulesets/phases/http_ratelimit/entrypoint$`)); assert.equal(put.auth, 'Bearer tok_secret_value');
  assert.deepEqual(put.body.rules[0], foreign); assert.equal(put.body.rules.length, 6);
  assert.ok(!put.body.rules.some((r) => r.ref === 'lummet-v1-retired'));
  const again = cfFetch({ existing: put.body.rules }); assert.equal(await main(['--apply'], APPLY_ENV, again, io()), 0);
  assert.deepEqual(again.calls[1].body, put.body, 'second apply sends the same rules');
  assert.doesNotMatch(o.out.join('\n'), /tok_secret_value/);
});

test('production apply needs --allow-production AND CF_WAF_CHANGES_APPROVED=true; rollback removes only managed rules', async () => {
  const env = { ...APPLY_ENV, CF_WAF_ENVIRONMENT: 'production', CF_WAF_CHANGES_APPROVED: 'true' };
  const f = cfFetch(); assert.equal(await main(['--mode', 'production', '--apply', '--allow-production'], env, f, io()), 0); assert.equal(f.calls[1].method, 'PUT');
  const foreign = { ref: 'customer-own', expression: 'true' };
  const r = cfFetch({ existing: [foreign, ...buildManagedRules(loadConfig())] });
  assert.equal(await main(['--apply', '--rollback'], { ...APPLY_ENV, WAF_THRESHOLDS_CONFIRMED: 'no' }, r, io()), 0);
  assert.deepEqual(r.calls[1].body.rules, [foreign]);
});

test('a Cloudflare error is reported without the token and with a failing exit code; a 404 entrypoint is treated as empty', async () => {
  const o = io(); assert.equal(await main(['--apply'], APPLY_ENV, cfFetch({ putStatus: 400 }), o), 1); assert.match(o.err.join(''), /bad expression/); assert.doesNotMatch(o.err.join(''), /tok_secret_value/);
  const f = cfFetch({ status: 404 }); assert.equal(await main(['--apply'], APPLY_ENV, f, io()), 0); assert.equal(f.calls[1].body.rules.length, 5);
});

// ---- Worker Retry-After
test('Retry-After is added to 429 responses only when RATE_LIMIT_RETRY_AFTER=on, never overwritten, and never added to other statuses', () => {
  const req = (p) => new Request(`https://cp.example.test${p}`);
  const r429 = () => new Response('{}', { status: 429 });
  assert.equal(withRetryAfter(r429(), req('/api/customer/login'), {}).headers.get('retry-after'), null, 'default off');
  assert.equal(withRetryAfter(r429(), req('/api/customer/login'), { RATE_LIMIT_RETRY_AFTER: 'bogus' }).headers.get('retry-after'), null);
  const on = { RATE_LIMIT_RETRY_AFTER: 'on' };
  assert.equal(withRetryAfter(r429(), req('/api/customer/login'), on).headers.get('retry-after'), '900');
  assert.equal(withRetryAfter(r429(), req('/contact'), on).headers.get('retry-after'), '3600');
  assert.equal(withRetryAfter(r429(), req('/api/organizations/o/ai/generate'), on).headers.get('retry-after'), '60');
  assert.equal(withRetryAfter(new Response('', { status: 429, headers: { 'Retry-After': '5' } }), req('/api/x'), on).headers.get('retry-after'), '5');
  assert.equal(withRetryAfter(new Response('', { status: 401 }), req('/api/x'), on).headers.get('retry-after'), null);
  assert.equal(retryAfterMode({ RATE_LIMIT_RETRY_AFTER: ' ON ' }), 'on'); assert.equal(retryAfterSeconds('/api/v1/sites'), 900);
});

async function login(env, ip, n) {
  let last;
  for (let i = 0; i < n; i++) last = await worker.fetch(new Request('https://cp.example.test/api/customer/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password-1' }) }), env, { waitUntil() {} });
  return last;
}
test('real Worker: repeated bad sign-ins end in 429 with Retry-After when on, and without it when off', async () => {
  for (const [flag, expected] of [['on', '900'], ['off', null], [undefined, null]]) {
    const db = createTestDb(); applyMigrations(db);
    const env = { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production', ...(flag ? { RATE_LIMIT_RETRY_AFTER: flag } : {}) };
    const res = await login(env, '203.0.113.' + (flag === 'on' ? 5 : flag === 'off' ? 6 : 7), 15);
    assert.equal(res.status, 429, `flag ${flag}`); assert.equal(res.headers.get('retry-after'), expected, `flag ${flag}`);
    assert.equal((await res.json()).error, 'too_many_attempts');
  }
});

// ---- config-check
test('production config-check requires the new settings; staging does not', () => {
  const keys = (env) => configIssues({ ENVIRONMENT: 'production', ...env }).map((i) => i.key);
  const all = ['RATE_LIMIT_RETRY_AFTER', 'CF_WAF_ZONE_ID', 'CF_WAF_MAX_RULES/CF_WAF_ALLOWED_PERIODS/CF_WAF_MAX_TIMEOUT', 'WAF_THRESHOLDS_CONFIRMED'];
  for (const k of all) assert.ok(keys({}).includes(k), `${k} required`);
  const full = { RATE_LIMIT_RETRY_AFTER: 'off', CF_WAF_ZONE_ID: ZONE, WAF_THRESHOLDS_CONFIRMED: 'yes', ...PLAN };
  for (const k of all) assert.ok(!keys(full).includes(k), `${k} satisfied`);
  assert.ok(keys({ ...full, RATE_LIMIT_RETRY_AFTER: 'maybe' }).includes('RATE_LIMIT_RETRY_AFTER'));
  assert.ok(keys({ ...full, CF_WAF_ZONE_ID: 'xyz' }).includes('CF_WAF_ZONE_ID'));
  assert.ok(keys({ ...full, CF_WAF_ALLOWED_PERIODS: 'ten' }).includes(all[2]));
  assert.ok(keys({ ...full, WAF_THRESHOLDS_CONFIRMED: 'no' }).includes('WAF_THRESHOLDS_CONFIRMED'));
  assert.deepEqual(configIssues({ ENVIRONMENT: 'staging' }), []);
});

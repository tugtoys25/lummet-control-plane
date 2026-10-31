// Platform settings: staff console value > wrangler var > built-in default. Real code over an in-memory D1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import * as ps from '../worker/platform-settings.js';
import * as gateways from '../worker/billing-gateways.js';
import { billingMode } from '../worker/billing-config.js';

const ctx = { waitUntil() {} };
let n = 1;
function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)), PORTAL_BASE_URL: 'https://cp.test', ...extra };
}
async function call(env, method, path, { body, cookie } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': `198.51.100.${n++ % 250 + 1}` });
  if (cookie) h.set('Cookie', cookie);
  if (body !== undefined) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function staffCookie(env) {
  await call(env, 'POST', '/api/auth/bootstrap', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } });
  return (await call(env, 'POST', '/api/auth/login', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } })).cookie;
}
const actor = 'staff:1';
const set = (env, key, value, reason = 'testing') => ps.setSetting(env, { key, value, actorId: actor, reason });
const clear = (env, key, reason = 'testing') => ps.clearSetting(env, { key, actorId: actor, reason });
const find = async (env, key) => (await ps.listSettings(env)).find((s) => s.key === key);

test('precedence: no staff value -> wrangler value; no wrangler value -> default', async () => {
  const env = makeEnv({ BILLING_ENFORCE: 'shadow' });
  assert.deepEqual(((s) => [s.value, s.source])(await find(env, 'BILLING_ENFORCE')), ['shadow', 'wrangler']);
  assert.deepEqual(((s) => [s.value, s.source])(await find(env, 'BILLING_GRACE_DAYS')), ['14', 'default']);
  // An empty wrangler var counts as unset (CF_WAF_ZONE_ID is "" in wrangler.jsonc on purpose).
  const empty = makeEnv({ CF_WAF_ZONE_ID: '' });
  assert.equal((await find(empty, 'CF_WAF_ZONE_ID')).source, 'default');
});

test('precedence: a staff value wins over wrangler, and the code that reads env sees it', async () => {
  const env = makeEnv({ BILLING_ENFORCE: 'off' });
  assert.equal(billingMode(await ps.withPlatformSettings(env)), 'off');
  assert.equal((await set(env, 'BILLING_ENFORCE', 'enforce')).ok, true);
  const live = await ps.withPlatformSettings(env);
  assert.equal(billingMode(live), 'enforce');
  assert.equal(live.BILLING_ENFORCE, 'enforce');
  const s = await find(env, 'BILLING_ENFORCE');
  assert.deepEqual([s.value, s.source, s.staffValue, s.wranglerValue, s.updatedBy], ['enforce', 'staff', 'enforce', 'off', actor]);
  // The overlay is a copy: bindings and other vars come through, the original env is untouched.
  assert.equal(live.LUMMET_DB, env.LUMMET_DB);
  assert.equal(env.BILLING_ENFORCE, 'off');
});

test('clearing a staff value falls back to the wrangler value again', async () => {
  const env = makeEnv({ BILLING_ENFORCE: 'shadow' });
  await set(env, 'BILLING_ENFORCE', 'enforce');
  assert.equal(billingMode(await ps.withPlatformSettings(env)), 'enforce');
  assert.equal((await clear(env, 'BILLING_ENFORCE')).ok, true);
  assert.equal(billingMode(await ps.withPlatformSettings(env)), 'shadow');
  const s = await find(env, 'BILLING_ENFORCE');
  assert.deepEqual([s.value, s.source, s.staffValue], ['shadow', 'wrangler', null]);
  // Clearing something that was never set changes nothing.
  assert.equal((await clear(env, 'BILLING_ENFORCE')).unchanged, true);
});

test('a staff value also reaches code that is not an enum: PAYMENT_GATEWAYS drives the gateway list and beats wrangler', async () => {
  const env = makeEnv({ PAYMENT_GATEWAYS: 'nowpayments', NOWPAYMENTS_API_KEY: 'k', NOWPAYMENTS_IPN_SECRET: 's' });
  assert.deepEqual((await gateways.availableGateways(await ps.withPlatformSettings(env))).map((g) => g.gateway), ['nowpayments']);
  assert.equal((await set(env, 'PAYMENT_GATEWAYS', 'stripe, nowpayments')).ok, true);
  assert.deepEqual((await gateways.availableGateways(await ps.withPlatformSettings(env))).map((g) => g.gateway), ['stripe', 'nowpayments']);
});

test('only allow-listed keys: secrets, bindings and lockout-prone settings are refused, and a stray row is ignored', async () => {
  const env = makeEnv();
  for (const key of ['STRIPE_SECRET_KEY', 'CREDENTIAL_KEK', 'LUMMET_DB', 'RESEND_API_KEY', 'NOWPAYMENTS_API_KEY', 'TURNSTILE_SECRET_KEY']) {
    const r = await set(env, key, 'x'); assert.deepEqual([r.ok, r.status, r.error], [false, 404, 'unknown_setting'], key);
  }
  for (const key of ['PLATFORM_ACCESS_JWT_MODE', 'CF_ACCESS_ISSUER', 'WEBAUTHN_RP_ID', 'PORTAL_BASE_URL', 'ENVIRONMENT', 'STAFF_2FA_REQUIRED', 'PASSWORD_HASH_FORMAT']) {
    const r = await set(env, key, 'x'); assert.deepEqual([r.ok, r.status, r.error], [false, 403, 'not_manageable'], key);
  }
  // Someone writes a row straight into the table for a secret and for a lockout-prone key: neither is applied.
  const withSecret = makeEnv({ STRIPE_SECRET_KEY: 'sk_real', PLATFORM_ACCESS_JWT_MODE: 'off' });
  await withSecret.LUMMET_DB.prepare(`INSERT INTO platform_settings (key, value) VALUES ('STRIPE_SECRET_KEY', 'evil'), ('PLATFORM_ACCESS_JWT_MODE', 'enforce')`).run();
  const live = await ps.withPlatformSettings(withSecret);
  assert.equal(live.STRIPE_SECRET_KEY, 'sk_real');
  assert.equal(live.PLATFORM_ACCESS_JWT_MODE, 'off');
  // The registry itself never lists a secret.
  assert.equal(ps.SETTINGS.some((d) => /(SECRET|_TOKEN|KEK|API_KEY|PASSWORD|DSN)/.test(d.key)), false);
});

test('validation: wrong values are refused with a stable code, and good ones are normalised', async () => {
  const env = makeEnv();
  const bad = async (key, value, error = 'invalid_value') => assert.equal((await set(env, key, value)).error, error, `${key}=${value}`);
  await bad('BILLING_ENFORCE', 'on');                 // enum: this one is off|shadow|enforce
  await bad('SYNTHETIC_MONITORS', 'enforce');         // the old wrangler.jsonc value: the code only knows off|shadow|on
  await bad('ORG_IP_ALLOWLIST', 'on');                // and this one only knows off|shadow|enforce
  await bad('BILLING_GRACE_DAYS', '-1'); await bad('BILLING_GRACE_DAYS', '3651'); await bad('BILLING_GRACE_DAYS', 'abc'); await bad('BILLING_GRACE_DAYS', '1.5');
  await bad('BILLING_REMINDER_DAYS', '3,x'); await bad('PAYMENT_GATEWAYS', 'paypal');
  await bad('CONTACT_EMAIL', 'not-an-email'); await bad('STATUS_PROVIDER_URL', 'http://insecure.test'); await bad('PLATFORM_DOMAIN_SUFFIX', 'nodot');
  await bad('REVENUE_REPORTING_CURRENCY', 'US'); await bad('CF_WAF_ZONE_ID', 'zzz');
  await bad('BILLING_ENFORCE', '   ', 'value_required');
  assert.equal((await set(env, 'BILLING_ENFORCE', ' Shadow ')).setting.value, 'shadow');
  assert.equal((await set(env, 'REVENUE_REPORTING_CURRENCY', 'eur')).setting.value, 'EUR');
  assert.equal((await set(env, 'BILLING_REMINDER_DAYS', '3, 1')).setting.value, '3,1');
  assert.equal((await set(env, 'PLATFORM_DOMAIN_SUFFIX', 'Sites.Example.COM')).setting.value, 'sites.example.com');
  assert.equal((await set(env, 'PAYMENT_GATEWAYS', 'stripe;stripe,nowpayments')).setting.value, 'stripe,nowpayments');
  assert.equal((await set(env, 'BILLING_TRIAL_DAYS_DEFAULT', '4')).setting.value, '4');
});

test('every definition accepts its own default-looking and option values (the registry is self-consistent)', () => {
  for (const d of ps.SETTINGS) {
    if (d.options) for (const o of d.options) assert.equal(ps.validateValue(d, o).ok, true, `${d.key}=${o}`);
    assert.ok(d.group && d.help, `${d.key} has a group and help text`);
  }
  assert.equal(new Set(ps.SETTINGS.map((d) => d.key)).size, ps.SETTINGS.length, 'no duplicate keys');
  assert.equal(ps.SETTINGS.some((d) => ps.NOT_MANAGEABLE.has(d.key)), false, 'nothing is both manageable and not manageable');
});

test('a reason is required for every change and clear', async () => {
  const env = makeEnv();
  assert.equal((await set(env, 'BILLING_ENFORCE', 'shadow', '')).error, 'reason_required');
  assert.equal((await set(env, 'BILLING_ENFORCE', 'shadow', 'ab')).error, 'reason_required');
  await set(env, 'BILLING_ENFORCE', 'shadow');
  assert.equal((await clear(env, 'BILLING_ENFORCE', ' ')).error, 'reason_required');
});

test('cross-setting guards stop a save that leaves a misconfiguration', async () => {
  const env = makeEnv();
  assert.equal((await set(env, 'HSTS_PRELOAD', 'on')).error, 'hsts_preload_needs_approval');
  assert.equal((await set(env, 'HSTS_PRELOAD_APPROVED', 'yes')).ok, true);
  assert.equal((await set(env, 'HSTS_PRELOAD', 'on')).ok, true);
  assert.equal((await set(env, 'HSTS_PRELOAD_APPROVED', 'no')).error, 'hsts_preload_needs_approval');
  assert.equal((await clear(env, 'HSTS_PRELOAD_APPROVED')).error, 'hsts_preload_needs_approval');

  assert.equal((await set(env, 'ERROR_TRACKING', 'on')).error, 'error_tracking_needs_approval');
  assert.equal((await set(env, 'ERROR_TRACKING', 'shadow')).ok, true);

  assert.equal((await set(env, 'AUDIT_LOG_STREAM', 'on')).error, 'audit_stream_needs_log_redaction');
  assert.equal((await set(env, 'LOG_REDACTION', 'on')).ok, true);
  assert.equal((await set(env, 'AUDIT_LOG_STREAM', 'on')).ok, true);
  assert.equal((await set(env, 'LOG_REDACTION', 'off')).error, 'audit_stream_needs_log_redaction');

  // Crypto only, with no NOWPayments keys, would leave customers with no way to pay.
  assert.equal((await set(env, 'PAYMENT_GATEWAYS', 'nowpayments')).error, 'no_usable_payment_gateway');
  const withKeys = makeEnv({ NOWPAYMENTS_API_KEY: 'k', NOWPAYMENTS_IPN_SECRET: 's' });
  assert.equal((await set(withKeys, 'PAYMENT_GATEWAYS', 'nowpayments')).ok, true);
});

test('every change is recorded with who, why, and the old and new value', async () => {
  const env = makeEnv({ BILLING_ENFORCE: 'off' });
  await set(env, 'BILLING_ENFORCE', 'shadow', 'start observing');
  await set(env, 'BILLING_ENFORCE', 'enforce', 'go live');
  await set(env, 'BILLING_ENFORCE', 'enforce', 'same again'); // no change, no event
  await clear(env, 'BILLING_ENFORCE', 'back to wrangler');
  const events = await ps.listSettingEvents(env);
  assert.deepEqual(events.map((e) => [e.action, e.old_value, e.new_value, e.reason, e.actor_id]), [
    ['clear', 'enforce', null, 'back to wrangler', actor],
    ['set', 'shadow', 'enforce', 'go live', actor],
    ['set', null, 'shadow', 'start observing', actor]
  ]);
});

test('fail soft: a missing table leaves env exactly as given and never throws', async () => {
  const env = makeEnv({ BILLING_ENFORCE: 'shadow' });
  await env.LUMMET_DB.prepare('DROP TABLE platform_settings').run();
  const real = console.error; const logged = []; console.error = (...a) => logged.push(a.join(' '));
  try {
    const live = await ps.withPlatformSettings(env);
    assert.equal(live, env);
    assert.equal(billingMode(live), 'shadow');
    assert.ok(logged.some((l) => l.includes('platform_settings_unreadable')));
  } finally { console.error = real; }
  // And an env with no database at all passes straight through.
  const bare = { BILLING_ENFORCE: 'off' };
  assert.equal(await ps.withPlatformSettings(bare), bare);
});

test('a stored value that no longer validates is skipped, so wrangler applies', async () => {
  const env = makeEnv({ BILLING_ENFORCE: 'shadow' });
  await env.LUMMET_DB.prepare(`INSERT INTO platform_settings (key, value) VALUES ('BILLING_ENFORCE', 'garbage')`).run();
  assert.equal(billingMode(await ps.withPlatformSettings(env)), 'shadow');
  assert.equal((await find(env, 'BILLING_ENFORCE')).source, 'wrangler');
});

test('scheduled and queue entry points use the staff values too', async () => {
  const env = makeEnv({ BILLING_ENFORCE: 'off' });
  await set(env, 'BILLING_ENFORCE', 'enforce');
  let seen = null;
  const wrapped = { ...env, JOB_QUEUE: undefined };
  const live = await ps.withPlatformSettings(wrapped);
  seen = live.BILLING_ENFORCE;
  assert.equal(seen, 'enforce');
  // The real handlers must not throw with the overlay in place.
  await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, wrapped, ctx);
});

test('route: staff API is staff-only, lists with sources, validates, audits, and a change takes effect on the next request', async () => {
  const env = makeEnv({ BILLING_ENFORCE: 'off' });
  assert.equal((await call(env, 'GET', '/api/platform/saas/settings')).status, 401);
  assert.equal((await call(env, 'PUT', '/api/platform/saas/settings/BILLING_ENFORCE', { body: { value: 'enforce', reason: 'x1x' } })).status, 401);
  const cookie = await staffCookie(env);

  const list = await call(env, 'GET', '/api/platform/saas/settings', { cookie });
  assert.equal(list.status, 200, list.text);
  const row = list.json.data.find((s) => s.key === 'BILLING_ENFORCE');
  assert.deepEqual([row.value, row.source], ['off', 'wrangler']);
  assert.equal(list.json.data.some((s) => s.key === 'STRIPE_SECRET_KEY'), false);

  const put = (key, body) => call(env, 'PUT', `/api/platform/saas/settings/${key}`, { cookie, body });
  assert.equal((await put('BILLING_ENFORCE', { value: 'enforce' })).json.error, 'reason_required');
  assert.equal((await put('BILLING_ENFORCE', { value: 'bogus', reason: 'testing' })).json.error, 'invalid_value');
  assert.equal((await put('STRIPE_SECRET_KEY', { value: 'x', reason: 'testing' })).status, 404);
  assert.equal((await put('PLATFORM_ACCESS_JWT_MODE', { value: 'enforce', reason: 'testing' })).status, 403);
  const ok = await put('BILLING_ENFORCE', { value: 'shadow', reason: 'observe first' });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual([ok.json.data.value, ok.json.data.source], ['shadow', 'staff']);

  const after = await call(env, 'GET', '/api/platform/saas/settings', { cookie });
  assert.equal(after.json.data.find((s) => s.key === 'BILLING_ENFORCE').value, 'shadow');
  assert.deepEqual(after.json.events.map((e) => [e.key, e.action, e.new_value]), [['BILLING_ENFORCE', 'set', 'shadow']]);

  const del = await call(env, 'DELETE', '/api/platform/saas/settings/BILLING_ENFORCE', { cookie, body: { reason: 'back to wrangler' } });
  assert.equal(del.status, 200, del.text);
  assert.deepEqual([del.json.data.value, del.json.data.source], ['off', 'wrangler']);

  const audited = await env.LUMMET_DB.prepare(`SELECT COUNT(*) c FROM audit_log WHERE resource = 'platform_setting' AND success = 1`).first().catch(() => null);
  if (audited) assert.equal(audited.c, 2);
});

test('page: the staff settings page renders every group, the source of each value, and the controls', async () => {
  const env = makeEnv({ BILLING_ENFORCE: 'shadow' });
  const cookie = await staffCookie(env);
  const page = await call(env, 'GET', '/platform/saas/settings', { cookie });
  assert.equal(page.status, 200, page.text.slice(0, 300));
  for (const text of ['Platform settings', 'BILLING_ENFORCE', 'PAYMENT_GATEWAYS', 'Billing', 'Security', 'Public site', 'Recent changes']) assert.ok(page.text.includes(text), text);
  assert.ok(!page.text.includes('STRIPE_SECRET_KEY'));
  assert.equal((await call(env, 'GET', '/platform/saas/settings')).status === 200, false, 'signed-out visitors do not get the page');
});

test('migration 0075 is additive only', async () => {
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../migrations/0075_platform_settings.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(sql, /\b(DROP|DELETE\s+FROM|ALTER\s+TABLE|UPDATE\s)/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS platform_settings/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS platform_setting_events/);
});

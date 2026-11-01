// Turnstile (v2): console toggles are live on the next request; forgot-password and staff sign-in are covered; no lockouts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import { createAssets } from './support/public-env.js';
import * as repo from '../worker/repositories/platform-settings.js';
import * as settings from '../worker/platform-settings.js';

const KEYS = { TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' };
let ip = 1;
function env(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, ASSETS: createAssets(), CREDENTIAL_KEK: btoa('k'.repeat(32)), CSP_MODE: 'enforce', ENVIRONMENT: 'production', ...extra }; }
const ctx = { waitUntil() {} };
async function call(e, method, path, { body, form } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.' + (ip++ % 250 + 1) });
  let payload;
  if (body) { h.set('Content-Type', 'application/json'); payload = JSON.stringify(body); }
  if (form) { h.set('Content-Type', 'application/x-www-form-urlencoded'); payload = new URLSearchParams(form).toString(); }
  const res = await worker.fetch(new Request('https://cp.example.test' + path, { method, headers: h, body: payload, redirect: 'manual' }), e, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { res, status: res.status, text, json };
}

test('turning customer Turnstile on is live on the next sign-in page and request, even when this isolate cached the old value', async () => {
  const e = env(KEYS);
  assert.doesNotMatch((await call(e, 'GET', '/app/login')).text, /cf-turnstile/);
  await repo.upsert(e, { key: 'CUSTOMER_TURNSTILE_REQUIRED', value: 'on', actorId: 'test' }); // as another isolate would: this cache still says off
  const page = await call(e, 'GET', '/app/login');
  assert.match(page.text, /class="cf-turnstile/);
  assert.match(page.res.headers.get('content-security-policy') || '', /challenges\.cloudflare\.com/);
  assert.match((await call(e, 'GET', '/app/signup')).text, /class="cf-turnstile/);
  const attempt = await call(e, 'POST', '/api/customer/login', { body: { email: 'nobody@example.com', password: 'Correct-Horse-Battery-9' } });
  assert.equal(attempt.status, 422);
  assert.equal(attempt.json.error, 'turnstile_required');
});

test('turning customer Turnstile off is live on the next request too', async () => {
  const e = env(KEYS);
  await repo.upsert(e, { key: 'CUSTOMER_TURNSTILE_REQUIRED', value: 'on', actorId: 'test' });
  assert.match((await call(e, 'GET', '/app/login')).text, /class="cf-turnstile/);
  await repo.upsert(e, { key: 'CUSTOMER_TURNSTILE_REQUIRED', value: 'off', actorId: 'test' });
  assert.doesNotMatch((await call(e, 'GET', '/app/login')).text, /cf-turnstile/);
});

test('forgot-password: widget on the page and a challenge on the request when customer Turnstile is on', async () => {
  const e = env(KEYS);
  assert.doesNotMatch((await call(e, 'GET', '/app/forgot-password')).text, /cf-turnstile/);
  await repo.upsert(e, { key: 'CUSTOMER_TURNSTILE_REQUIRED', value: 'on', actorId: 'test' });
  assert.match((await call(e, 'GET', '/app/forgot-password')).text, /class="cf-turnstile/);
  const r = await call(e, 'POST', '/api/customer/password/forgot', { body: { email: 'someone@example.com' } });
  assert.equal(r.status, 422);
  assert.equal(r.json.error, 'turnstile_required');
});

test('Turnstile cannot be switched on from the console without its site key and secret', async () => {
  for (const key of ['CUSTOMER_TURNSTILE_REQUIRED', 'PUBLIC_FORMS_TURNSTILE_REQUIRED']) {
    const refused = await settings.setSetting(env(), { key, value: 'on', actorId: 'staff:test', reason: 'test reason' });
    assert.equal(refused.ok, false, key); assert.equal(refused.error, 'turnstile_needs_keys', key);
    assert.equal((await settings.setSetting(env(KEYS), { key, value: 'on', actorId: 'staff:test', reason: 'test reason' })).ok, true, key);
  }
});

test('the staff Turnstile flag is not editable from the console (it lives in wrangler.jsonc, like STAFF_2FA_REQUIRED)', async () => {
  assert.equal(settings.NOT_MANAGEABLE.has('STAFF_TURNSTILE_REQUIRED'), true);
  const r = await settings.setSetting(env(KEYS), { key: 'STAFF_TURNSTILE_REQUIRED', value: 'on', actorId: 'staff:test', reason: 'test reason' });
  assert.equal(r.ok, false);
});

test('staff sign-in: with the flag on and both keys, the page shows the widget and a login without a token is refused', async () => {
  const e = env({ ...KEYS, STAFF_TURNSTILE_REQUIRED: 'on' });
  assert.equal((await call(e, 'POST', '/api/auth/bootstrap', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } })).status, 200);
  const page = await call(e, 'GET', '/login');
  assert.match(page.text, /class="cf-turnstile/);
  assert.match(page.res.headers.get('content-security-policy') || '', /challenges\.cloudflare\.com/);
  const form = await call(e, 'POST', '/login', { form: { mode: 'login', email: 'root@example.com', password: 'Correct-Horse-Battery-9' } });
  assert.equal(form.status, 200);
  assert.match(form.text, /security check/i);
  assert.equal(form.res.headers.get('set-cookie'), null);
  const api = await call(e, 'POST', '/api/auth/login', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } });
  assert.equal(api.status, 422);
  assert.equal(api.json.error, 'turnstile_required');
});

test('staff sign-in never locks anyone out: flag off, or flag on without keys, behaves exactly as before', async () => {
  for (const extra of [{}, { STAFF_TURNSTILE_REQUIRED: 'off', ...KEYS }, { STAFF_TURNSTILE_REQUIRED: 'on' }]) {
    const e = env(extra);
    assert.equal((await call(e, 'POST', '/api/auth/bootstrap', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } })).status, 200);
    assert.doesNotMatch((await call(e, 'GET', '/login')).text, /cf-turnstile/);
    const api = await call(e, 'POST', '/api/auth/login', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } });
    assert.equal(api.status, 200, JSON.stringify(extra));
  }
});

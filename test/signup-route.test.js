// /app/signup is what the pricing page links to: it must keep ?plan=&period= and open the signup form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import { renderCustomerLoginPage } from '../worker/views/customer-pages/login.js';

function env() { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production' }; }
const ctx = { waitUntil() {} };
async function get(e, path, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.5' }); if (cookie) h.set('Cookie', cookie);
  const res = await worker.fetch(new Request('https://cp.example.test' + path, { headers: h, redirect: 'manual' }), e, ctx);
  return { status: res.status, location: res.headers.get('Location'), text: await res.text() };
}

test('login page opens the signup form only when asked to', () => {
  assert.match(renderCustomerLoginPage({ initialView: 'signup' }), /showSignup\(\);\s*<\/script>/);
  assert.doesNotMatch(renderCustomerLoginPage(), /showSignup\(\);\s*<\/script>/);
});

test('GET /app/signup serves the page itself (no redirect), so the plan in the query string is kept', async () => {
  const r = await get(env(), '/app/signup?plan=plan_casino_news_starter&period=monthly');
  assert.equal(r.status, 200);
  assert.match(r.text, /id="signup-form"/);
  assert.match(r.text, /lummetSignupIntent/);
  assert.match(r.text, /showSignup\(\);\s*<\/script>/);
});

test('a signed-in visitor on /app/signup goes to billing with the plan; bad values are dropped', async () => {
  const e = env();
  const res = await worker.fetch(new Request('https://cp.example.test/api/customer/signup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.5' }, body: JSON.stringify({ email: 'su@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'S' }) }), e, ctx);
  const cookie = (res.headers.get('Set-Cookie') || '').split(';')[0];
  const ok = await get(e, '/app/signup?plan=plan_casino_news_starter&period=annual', cookie);
  assert.equal(ok.status, 302); assert.equal(ok.location, '/app/billing?plan=plan_casino_news_starter&period=annual');
  const bad = await get(e, '/app/signup?plan=%3Cscript%3E&period=monthly', cookie);
  assert.equal(bad.location, '/app/billing');
});

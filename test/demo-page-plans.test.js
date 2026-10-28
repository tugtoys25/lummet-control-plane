// /demo with DEMO_PAGE_PLANS=on: the form stays, buyable plans are listed under it, and "View all plans" goes to /pricing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import { demoPlansMode } from '../worker/public-site/demo-plans.js';
import { setPlanPrice } from './support/plan-prices.js';
import { createAssets } from './support/public-env.js';

const STARTER = 'plan_casino_news_starter';
function env(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, ASSETS: createAssets(), CONTACT_EMAIL: 'hello@example.test', CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production', ...extra }; }
const ctx = { waitUntil() {} };
async function get(e, path) {
  const res = await worker.fetch(new Request('https://cp.example.test' + path, { headers: { 'CF-Connecting-IP': '198.51.100.5' }, redirect: 'manual' }), e, ctx);
  return { status: res.status, text: await res.text() };
}

test('flag: only "on" turns it on', () => {
  assert.equal(demoPlansMode({}), false);
  assert.equal(demoPlansMode({ DEMO_PAGE_PLANS: 'yes' }), false);
  assert.equal(demoPlansMode({ DEMO_PAGE_PLANS: ' ON ' }), true);
});

test('/demo with the flag off has no plan section', async () => {
  const e = env(); await setPlanPrice(e, STARTER, 'price_s');
  const r = await get(e, '/demo');
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, /demo-plans/);
});

test('/demo with the flag on lists only plans that can be bought, linked to /app/signup, plus View all plans', async () => {
  const e = env({ DEMO_PAGE_PLANS: 'on' });
  assert.doesNotMatch((await get(e, '/demo')).text, /id="demo-plans-title"/); // nothing buyable yet: no section
  await setPlanPrice(e, STARTER, 'price_s');
  const r = await get(e, '/demo');
  assert.equal(r.status, 200);
  assert.match(r.text, /id="demo-plans-title"/);
  assert.match(r.text, new RegExp(`href="/app/signup\\?plan=${STARTER}&amp;period=monthly"`));
  assert.match(r.text, /href="\/pricing"/);
  assert.match(r.text, /<form/); // the demo form is still there
});

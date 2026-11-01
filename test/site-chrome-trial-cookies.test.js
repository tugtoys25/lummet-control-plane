// Trial length from one setting; shared header/footer on sign-in and dashboard pages; configurable cookie banner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import { createAssets } from './support/public-env.js';
import { effectiveTrialDays, withEffectiveTrial, configuredTrialDays } from '../worker/billing-config.js';
import { renderCookieBanner, cookieBannerModel } from '../worker/cookie-consent.js';

const STARTER = 'plan_casino_news_starter';
function env(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, ASSETS: createAssets(), CREDENTIAL_KEK: btoa('k'.repeat(32)), CSP_MODE: 'enforce', ENVIRONMENT: 'production', ...extra }; }
const ctx = { waitUntil() {} };
async function call(e, method, path, { body, cookie } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.7' }); if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.example.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { res, status: res.status, text, json, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}

test('trial length: one setting decides it; unset keeps each plan\'s own days; plans without a trial never get one', () => {
  assert.equal(configuredTrialDays({}), null);
  assert.equal(configuredTrialDays({ BILLING_TRIAL_DAYS_DEFAULT: '' }), null);
  assert.equal(configuredTrialDays({ BILLING_TRIAL_DAYS_DEFAULT: 'x' }), null);
  assert.equal(configuredTrialDays({ BILLING_TRIAL_DAYS_DEFAULT: '0' }), null);
  assert.equal(effectiveTrialDays({}, 7), 7);
  assert.equal(effectiveTrialDays({ BILLING_TRIAL_DAYS_DEFAULT: '14' }, 7), 14);
  assert.equal(effectiveTrialDays({ BILLING_TRIAL_DAYS_DEFAULT: '14' }, 0), 0);
  assert.deepEqual(withEffectiveTrial({ BILLING_TRIAL_DAYS_DEFAULT: '3' }, [{ id: 'a', trial_days: 7 }, { id: 'b', trial_days: 0 }]).map((r) => r.trial_days), [3, 0]);
});

test('trial length: pricing page text and a started no-card trial both follow the setting', async () => {
  const e = env({ BILLING_TRIAL_DAYS_DEFAULT: '14' });
  const pricing = await call(e, 'GET', '/pricing');
  assert.match(pricing.text, /14-day free trial/);
  assert.doesNotMatch(pricing.text, /\b7-day free trial/);

  const s = await call(e, 'POST', '/api/customer/signup', { body: { email: 'trial14@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'T14' } });
  const t = await call(e, 'POST', `/api/organizations/${s.json.organizationId}/trial`, { cookie: s.cookie, body: { planId: STARTER } });
  assert.equal(t.status, 200, t.text);
  const days = Math.round((Date.parse(t.json.trialEndsAt) - Date.now()) / 86400000);
  assert.equal(days, 14);

  const plain = env();
  assert.match((await call(plain, 'GET', '/pricing')).text, /7-day free trial/);
});

test('sign-in page: public header and footer, cookie banner with the configured text and links', async () => {
  const e = env();
  const r = await call(e, 'GET', '/app/login');
  assert.equal(r.status, 200);
  assert.match(r.text, /class="site-header"/);
  assert.match(r.text, /class="site-footer"/);
  assert.doesNotMatch(r.text, /footer-cta/);                       // no marketing call to action on a sign-in page
  assert.doesNotMatch(r.text, /<!--lummet:/);                      // every marker was replaced
  assert.match(r.text, /id="lummet-cookie-banner"/);
  assert.match(r.text, /We use essential cookies/);
  assert.match(r.text, /href="\/privacy">Privacy policy</);
  assert.match(r.text, /data-cookie-settings/);
  const nonce = /'nonce-([^']+)'/.exec(r.res.headers.get('Content-Security-Policy') || r.res.headers.get('Content-Security-Policy-Report-Only') || '')?.[1];
  assert.ok(nonce);
  assert.ok(r.text.includes(`<script nonce="${nonce}" src="/static/js/cookie-consent.js`));
  assert.equal(/lnt[0-9a-f]{32}/.test(r.text), false);
});

test('cookie banner: texts and links are editable, a blank text or the off switch removes it everywhere', async () => {
  const e = env();
  await e.LUMMET_DB.prepare(`UPDATE lummet_ui_strings SET value = 'Custom cookie words' WHERE ui_key = 'cookie_banner_text'`).run();
  await e.LUMMET_DB.prepare(`UPDATE lummet_ui_strings SET value = 'Read more' WHERE ui_key = 'cookie_link_2_label'`).run();
  await e.LUMMET_DB.prepare(`UPDATE lummet_ui_strings SET value = '/security' WHERE ui_key = 'cookie_link_2_href'`).run();
  let page = (await call(e, 'GET', '/app/login')).text;
  assert.match(page, /Custom cookie words/);
  assert.match(page, /href="\/security">Read more</);
  const home = (await call(e, 'GET', '/')).text;                   // the public site uses the same text
  assert.match(home, /Custom cookie words/);
  assert.match(home, /<script src="\/static\/js\/cookie-consent\.js/);

  await e.LUMMET_DB.prepare(`UPDATE lummet_ui_strings SET value = '' WHERE ui_key = 'cookie_banner_text'`).run();
  assert.doesNotMatch((await call(e, 'GET', '/app/login')).text, /lummet-cookie-banner/);

  const off = env({ COOKIE_BANNER: 'off' });
  assert.doesNotMatch((await call(off, 'GET', '/app/login')).text, /lummet-cookie-banner/);
  assert.doesNotMatch((await call(off, 'GET', '/')).text, /lummet-cookie-banner|cookie-consent\.js/);
});

test('cookie banner: unsafe link addresses are dropped and text is escaped', () => {
  const ui = { cookie_banner_text: '<b>x</b>', cookie_link_1_label: 'Bad', cookie_link_1_href: 'javascript:alert(1)', cookie_link_2_label: 'Ok', cookie_link_2_href: 'https://example.com/p' };
  const m = cookieBannerModel({}, ui);
  assert.deepEqual(m.links.map((l) => l.href), ['https://example.com/p']);
  const out = renderCookieBanner({}, ui);
  assert.doesNotMatch(out, /<b>x/);
  assert.doesNotMatch(out, /javascript:/);
  assert.equal(renderCookieBanner({}, { cookie_banner_text: '' }), '');
  assert.equal(cookieBannerModel({ COOKIE_CONSENT_DAYS: '90' }, ui).days, 90);
  assert.equal(cookieBannerModel({ COOKIE_CONSENT_DAYS: '9999' }, ui).days, 180);
});

test('dashboard: the compact footer shares the public footer text and links, and carries the banner', async () => {
  const e = env();
  const s = await call(e, 'POST', '/api/customer/signup', { body: { email: 'dash@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'Dash' } });
  const r = await call(e, 'GET', '/app/overview', { cookie: s.cookie });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.match(r.text, /class="lummet-app-footer"/);
  assert.match(r.text, /href="\/privacy"/);
  assert.match(r.text, /id="lummet-cookie-banner"/);
  assert.doesNotMatch(r.text, /<!--lummet:/);
});

test('staff sign-in is left alone: no public header, footer or banner', async () => {
  const e = env();
  const r = await call(e, 'GET', '/login');
  assert.doesNotMatch(r.text, /class="site-header"|lummet-cookie-banner/);
});

// test/aftermarket.test.js — domains for sale: host/redirect detection, enquiry tracking, list, seller verification, Turnstile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePublicRoute } from '../worker/public-site/router.js';
import { createPublicEnv, get, post } from './support/public-env.js';

const text = (r) => r.text();
const inquiries = async (env) => (await env.db.prepare('SELECT * FROM lummet_inquiries ORDER BY id').all()).results;
const addDomain = (env, d, extra = {}) => env.db.prepare(
  `INSERT INTO lummet_aftermarket_domains (domain, status, asking_price, buy_url, hosted, source) VALUES (?, ?, ?, ?, ?, 'admin')`
).bind(d, extra.status || 'listed', extra.price ?? '500 USD', extra.buy ?? 'https://market.example/x', extra.hosted ?? 0).run();
const valid = { f_name: 'Ada', f_email: 'ada@example.test', f_offer: '400' };

test('redirect to the buy form with ?domain= names the listed domain and preselects it; unlisted names are ignored', async () => {
  const env = createPublicEnv();
  await addDomain(env, 'sze.app');
  const html = await text(await get(handlePublicRoute, env, '/aftermarket/domain-acquisition?domain=SZE.app'));
  assert.match(html, /sze\.app is for sale/);
  assert.match(html, /<option value="sze\.app" selected>/);
  assert.match(html, /500 USD/);
  assert.match(html, /href="https:\/\/market\.example\/x"/);
  assert.match(html, /name="robots" content="noindex/);
  const other = await text(await get(handlePublicRoute, env, '/aftermarket/domain-acquisition?domain=google.com'));
  assert.doesNotMatch(other, /google\.com is for sale/);
  assert.match(other, /Buy a domain name/);
  assert.equal((await get(handlePublicRoute, env, '/forms/domain-acquisition')).status, 200);
});

test('an enquiry is stored against the chosen domain with its source, and shows in the summary', async () => {
  const env = createPublicEnv();
  await addDomain(env, 'sze.app');
  await addDomain(env, 'nze.app');
  const res = await post(handlePublicRoute, env, '/aftermarket/domain-acquisition?domain=sze.app', { ...valid, f_domain: 'sze.app' });
  assert.equal(res.status, 303);
  let [row] = await inquiries(env);
  assert.equal(row.subject_ref, 'sze.app');
  assert.equal(row.source, 'redirect');
  assert.match(row.summary, /^sze\.app/);
  // Other + typed domain
  await post(handlePublicRoute, env, '/aftermarket/domains/nze.app', { ...valid, f_domain: 'Other', f_domain_other: 'https://www.Foo.io/x' });
  row = (await inquiries(env))[1];
  assert.equal(row.subject_ref, 'foo.io');
  assert.equal(row.source, 'landing');
  // Other without a domain is refused
  const bad = await post(handlePublicRoute, env, '/aftermarket/domain-acquisition', { ...valid, f_domain: 'Other' });
  assert.equal(bad.status, 422);
  // a value outside the live list is refused
  assert.equal((await post(handlePublicRoute, env, '/aftermarket/domain-acquisition', { ...valid, f_domain: 'evil.com' })).status, 422);
});

test('list page and landing page show only listed domains; the domain host serves its own page when hosted', async () => {
  const env = createPublicEnv();
  env.PORTAL_BASE_URL = 'https://lummet.test';
  await addDomain(env, 'sze.app', { hosted: 1 });
  await addDomain(env, 'draft.app', { status: 'draft' });
  const list = await text(await get(handlePublicRoute, env, '/aftermarket/list-of-domains'));
  assert.match(list, /sze\.app/);
  assert.doesNotMatch(list, /draft\.app/);
  assert.equal((await get(handlePublicRoute, env, '/aftermarket/domains/draft.app')).status, 404);
  assert.match(await text(await get(handlePublicRoute, env, '/aftermarket/domains/sze.app')), /sze\.app is for sale/);
  const own = await handlePublicRoute({ request: new Request('https://www.sze.app/'), env, ctx: { waitUntil() {} } });
  assert.match(await text(own), /sze\.app is for sale/);
  const home = await text(await get(handlePublicRoute, env, '/'));
  assert.doesNotMatch(home, /is for sale/);
  assert.equal((await get(handlePublicRoute, env, '/aftermarket')).status, 301);
});

test('seller flow: claim, TXT verification lists the domain; wrong record does not; admin rows cannot be claimed', async () => {
  const env = createPublicEnv();
  await addDomain(env, 'taken.app');
  const claim = { f_name: 'Sam', f_email: 'sam@example.test', f_domain: 'Mine.example', f_asking_price: '900' };
  assert.equal((await post(handlePublicRoute, env, '/aftermarket/sell-your-domain', { ...claim, f_domain: 'taken.app' })).status, 422);
  assert.equal((await post(handlePublicRoute, env, '/aftermarket/sell-your-domain', { ...claim, f_domain: 'nodot' })).status, 422);
  const res = await post(handlePublicRoute, env, '/aftermarket/sell-your-domain', claim);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/aftermarket/sell-your-domain/verify?domain=mine.example');
  const row = await env.db.prepare(`SELECT * FROM lummet_aftermarket_domains WHERE domain='mine.example'`).first();
  assert.equal(row.status, 'pending');
  assert.match(row.verify_token, /^lummet-verify=[0-9a-f]{40}$/);
  const page = await text(await get(handlePublicRoute, env, '/aftermarket/sell-your-domain/verify?domain=mine.example'));
  assert.ok(page.includes(row.verify_token));
  assert.ok(page.includes('_lummet-verify.mine.example'));
  assert.equal((await inquiries(env))[0].subject_ref, 'mine.example');

  const realFetch = globalThis.fetch;
  const dns = (answers) => { globalThis.fetch = async () => new Response(JSON.stringify({ Answer: answers }), { status: 200 }); };
  try {
    dns([{ type: 16, data: '"lummet-verify=wrong"' }]);
    let r = await post(handlePublicRoute, env, '/aftermarket/sell-your-domain/verify', { domain: 'mine.example', method: 'txt' });
    assert.match(r.headers.get('location'), /msg=txt/);
    assert.equal((await env.db.prepare(`SELECT status FROM lummet_aftermarket_domains WHERE domain='mine.example'`).first()).status, 'pending');
    await env.db.prepare(`UPDATE lummet_aftermarket_domains SET last_check_at = NULL`).run();
    dns([{ type: 16, data: `"${row.verify_token}"` }]);
    r = await post(handlePublicRoute, env, '/aftermarket/sell-your-domain/verify', { domain: 'mine.example', method: 'txt' });
    assert.equal(r.headers.get('location'), '/aftermarket/sell-your-domain/verify?domain=mine.example');
  } finally { globalThis.fetch = realFetch; }
  const after = await env.db.prepare(`SELECT * FROM lummet_aftermarket_domains WHERE domain='mine.example'`).first();
  assert.equal(after.status, 'listed');
  assert.equal(after.verified_method, 'txt');
  assert.equal(after.hosted, 0);
  assert.match(await text(await get(handlePublicRoute, env, '/aftermarket/domains/mine.example')), /mine\.example is for sale/);
});

test('nameserver verification needs the configured nameservers and marks the domain hosted', async () => {
  const env = createPublicEnv();
  env.AFTERMARKET_NAMESERVERS = 'ada.ns.example.net, bob.ns.example.net';
  await post(handlePublicRoute, env, '/aftermarket/sell-your-domain', { f_name: 'S', f_email: 's@example.test', f_domain: 'ns.example', f_asking_price: '1' });
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ Answer: [{ type: 2, data: 'ada.ns.example.net.' }, { type: 2, data: 'bob.ns.example.net.' }] }), { status: 200 });
    const r = await post(handlePublicRoute, env, '/aftermarket/sell-your-domain/verify', { domain: 'ns.example', method: 'ns' });
    assert.equal(r.status, 303);
  } finally { globalThis.fetch = realFetch; }
  const row = await env.db.prepare(`SELECT * FROM lummet_aftermarket_domains WHERE domain='ns.example'`).first();
  assert.deepEqual([row.status, row.verified_method, row.hosted], ['listed', 'ns', 1]);
});

test('Turnstile covers the aftermarket forms: widget, CSP and fail-closed POST', async () => {
  const env = createPublicEnv();
  Object.assign(env, { PUBLIC_FORMS_TURNSTILE_REQUIRED: 'on', TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_SECRET_KEY: 'secret' });
  await addDomain(env, 'sze.app', { hosted: 1 });
  env.PORTAL_BASE_URL = 'https://lummet.test';
  for (const path of ['/aftermarket/domain-acquisition', '/aftermarket/domains/sze.app', '/aftermarket/sell-your-domain']) {
    const res = await get(handlePublicRoute, env, path);
    assert.match(await text(res), /class="cf-turnstile"/, path);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self' https:\/\/challenges\.cloudflare\.com/, path);
  }
  const own = await handlePublicRoute({ request: new Request('https://sze.app/'), env, ctx: { waitUntil() {} } });
  assert.match(own.headers.get('content-security-policy'), /challenges\.cloudflare\.com/);
  const noToken = await post(handlePublicRoute, env, '/aftermarket/domains/sze.app', { ...valid, f_domain: 'sze.app' });
  assert.equal(noToken.status, 503); // fail closed without a token
  assert.equal((await inquiries(env)).length, 0);
});

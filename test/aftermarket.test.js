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
  assert.equal((await get(handlePublicRoute, env, '/aftermarket')).status, 200);   // the marketplace hub
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

function fakeCloudflare(state = {}) {
  const calls = [];
  const s = { zoneStatus: 'pending', seen: [], ...state };
  const infra = {
    createZone: async (_e, { name }) => { calls.push(['createZone', name]); return { zoneId: 'z-' + name, nameServers: ['ada.ns.cf.test', 'bob.ns.cf.test'], cfStatus: 'pending', status: s.createStatus || 'pending' }; },
    getZone: async () => ({ zoneId: 'z', nameServers: ['ada.ns.cf.test', 'bob.ns.cf.test'], cfStatus: s.zoneStatus, status: s.zoneStatus }),
    requestActivationCheck: async () => { calls.push(['activationCheck']); return { ok: true }; },
    deleteZone: async (_e, id) => { calls.push(['deleteZone', id]); return { ok: true }; },
    triggerDnsScan: async () => { calls.push(['scan']); return { ok: true }; },
    acceptScannedRecords: async () => { calls.push(['accept']); return { ok: true, accepted: 1 }; },
    listDnsRecords: async () => [{ id: 'r1', type: 'A', name: 'ns.example', content: '1.2.3.4' }, { id: 'r2', type: 'MX', name: 'ns.example', content: 'mx' }],
    deleteDnsRecord: async (_e, _z, id) => { calls.push(['deleteRecord', id]); return { ok: true }; },
    attachWorkerDomain: async (_e, p) => { calls.push(['attach', p.hostname, p.workerName]); return { customDomainId: 'c' }; }
  };
  const dns = { lookupNS: async () => ({ ok: true, nameServers: s.seen }) };
  return { infra, dns, calls, s };
}

test('nameserver verification: a Cloudflare zone per domain, listed only once Cloudflare reports it active', async () => {
  const { __setAftermarketProvidersForTests } = await import('../worker/aftermarket-zones.js');
  const env = createPublicEnv();
  env.CF_API_TOKEN = 't'; env.CF_ACCOUNT_ID = 'a';
  const cf = fakeCloudflare();
  __setAftermarketProvidersForTests(cf);
  try {
    await post(handlePublicRoute, env, '/aftermarket/sell-your-domain', { f_name: 'S', f_email: 's@example.test', f_domain: 'ns.example', f_asking_price: '1' });
    const q = () => env.db.prepare(`SELECT * FROM lummet_aftermarket_domains WHERE domain='ns.example'`).first();
    const cool = () => env.db.prepare(`UPDATE lummet_aftermarket_domains SET last_check_at = NULL`).run();
    // start: zone created, its own nameservers stored and shown
    let r = await post(handlePublicRoute, env, '/aftermarket/sell-your-domain/verify', { domain: 'ns.example', method: 'ns_start' });
    assert.equal(r.status, 303);
    let row = await q();
    assert.equal(row.cf_zone_id, 'z-ns.example');
    assert.equal(row.ns_assigned, 'ada.ns.cf.test,bob.ns.cf.test');
    const page = await text(await get(handlePublicRoute, env, '/aftermarket/sell-your-domain/verify?domain=ns.example'));
    assert.match(page, /ada\.ns\.cf\.test/);
    // nameservers not changed yet
    await cool();
    r = await post(handlePublicRoute, env, '/aftermarket/sell-your-domain/verify', { domain: 'ns.example', method: 'ns' });
    assert.match(r.headers.get('location'), /msg=ns$/);
    assert.equal((await q()).status, 'pending');
    // registrar shows them, Cloudflare still pending
    cf.s.seen = ['ADA.ns.cf.test.', 'bob.ns.cf.test'];
    await cool();
    r = await post(handlePublicRoute, env, '/aftermarket/sell-your-domain/verify', { domain: 'ns.example', method: 'ns' });
    assert.match(r.headers.get('location'), /msg=ns_seen/);
    assert.ok((await q()).ns_detected_at);
    assert.equal((await q()).status, 'pending');
    // Cloudflare confirms: records kept, old A removed, apex + www attached to this Worker, then listed and hosted
    cf.s.zoneStatus = 'active';
    await cool();
    r = await post(handlePublicRoute, env, '/aftermarket/sell-your-domain/verify', { domain: 'ns.example', method: 'ns' });
    assert.equal(r.headers.get('location'), '/aftermarket/sell-your-domain/verify?domain=ns.example');
    row = await q();
    assert.deepEqual([row.status, row.verified_method, row.hosted], ['listed', 'ns', 1]);
    assert.deepEqual(cf.calls.filter((c) => c[0] === 'attach'), [['attach', 'ns.example', 'lummet-control-plane'], ['attach', 'www.ns.example', 'lummet-control-plane']]);
    assert.ok(cf.calls.some((c) => c[0] === 'deleteRecord' && c[1] === 'r1'));
    assert.ok(!cf.calls.some((c) => c[0] === 'deleteRecord' && c[1] === 'r2'));
    assert.ok(cf.calls.some((c) => c[0] === 'accept'));
  } finally { __setAftermarketProvidersForTests(); }
});

test('nameserver setup is refused for a domain a customer already connected, and when Cloudflare is not configured', async () => {
  const { __setAftermarketProvidersForTests, startZone } = await import('../worker/aftermarket-zones.js');
  const env = createPublicEnv();
  await post(handlePublicRoute, env, '/aftermarket/sell-your-domain', { f_name: 'S', f_email: 's@example.test', f_domain: 'used.example', f_asking_price: '1' });
  const row = () => env.db.prepare(`SELECT * FROM lummet_aftermarket_domains WHERE domain='used.example'`).first();
  assert.deepEqual(await startZone(env, await row()), { ok: false, error: 'ns_off' });   // no CF credentials
  const cf = fakeCloudflare();
  __setAftermarketProvidersForTests(cf);
  try {
    await env.db.prepare(`PRAGMA foreign_keys = OFF`).run().catch(() => {});
    await env.db.prepare(`INSERT INTO domain_zones (id, site_id, zone_name, provider_zone_id, name_servers, status, expires_at) VALUES ('z1', 's1', 'used.example', 'pz', '[]', 'pending', '2099-01-01')`).run();
    assert.deepEqual(await startZone(env, await row()), { ok: false, error: 'ns_taken' });
    assert.ok(!cf.calls.some((c) => c[0] === 'createZone'), 'no Cloudflare zone is created for it');
  } finally { __setAftermarketProvidersForTests(); }
});

test('sweep expires unfinished claims and releases zones of unlisted domains', async () => {
  const { __setAftermarketProvidersForTests, startZone, sweep } = await import('../worker/aftermarket-zones.js');
  const env = createPublicEnv();
  const cf = fakeCloudflare();
  __setAftermarketProvidersForTests(cf);
  try {
    await post(handlePublicRoute, env, '/aftermarket/sell-your-domain', { f_name: 'S', f_email: 's@example.test', f_domain: 'old.example', f_asking_price: '1' });
    const row = await env.db.prepare(`SELECT * FROM lummet_aftermarket_domains WHERE domain='old.example'`).first();
    assert.equal((await startZone(env, row)).ok, true);
    await env.db.prepare(`UPDATE lummet_aftermarket_domains SET zone_expires_at = '2000-01-01T00:00:00.000Z', next_check_at = '2000-01-01T00:00:00.000Z'`).run();
    await sweep(env);
    const after = await env.db.prepare(`SELECT * FROM lummet_aftermarket_domains WHERE domain='old.example'`).first();
    assert.deepEqual([after.status, after.cf_zone_id], ['unlisted', null]);
    assert.ok(cf.calls.some((c) => c[0] === 'deleteZone'));
    // an admin unlists a domain that still has a zone: the sweep deletes it
    await env.db.prepare(`UPDATE lummet_aftermarket_domains SET status = 'unlisted', cf_zone_id = 'zz'`).run();
    const out = await sweep(env);
    assert.equal(out.released, 1);
  } finally { __setAftermarketProvidersForTests(); }
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

// ---- a verified (hosted) domain serves only its for-sale page; Lummet links lead to Lummet ----
test('a hosted domain shows only the for-sale page; everything else goes to Lummet and nothing else can be reached', async () => {
  const { default: worker } = await import('../worker/index.js');
  const { __clearHostedCacheForTests } = await import('../worker/aftermarket-host.js');
  __clearHostedCacheForTests();
  const env = createPublicEnv();
  env.LUMMET_DB = env.db;
  env.PORTAL_BASE_URL = 'https://lummet.test';
  await addDomain(env, 'sze.app', { hosted: 1 });
  await addDomain(env, 'plain.app', { hosted: 0 });
  const ctx = { waitUntil() {} };
  const call = (host, path, init = {}) => worker.fetch(new Request(`https://${host}${path}`, { redirect: 'manual', ...init }), env, ctx);

  // the for-sale page, on the apex and on www
  for (const host of ['sze.app', 'www.sze.app']) {
    const res = await call(host, '/');
    assert.equal(res.status, 200, host);
    const html = await res.text();
    assert.match(html, /sze\.app is for sale/);
    // every Lummet link now leaves for Lummet; no site-relative link is left except static files
    const hrefs = [...html.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1]);
    const relative = hrefs.filter((h) => h.startsWith('/') && !h.startsWith('//') && !h.startsWith('/static/') && !h.startsWith('/_s/'));
    assert.deepEqual(relative, [], 'no site-relative links');
    assert.ok(hrefs.some((h) => h.startsWith('https://lummet.com/')), 'Lummet links are absolute');
    assert.match(html, /<form[^>]*action="\/aftermarket\/domains\/sze\.app"/, 'the enquiry form stays on the domain');
  }
  // its own enquiry post works
  const posted = await call('sze.app', '/aftermarket/domains/sze.app', { method: 'POST', headers: { origin: 'https://sze.app', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...valid, f_domain: 'sze.app' }) });
  assert.equal(posted.status, 303);
  assert.equal((await inquiries(env))[0].source, 'host');
  // any other page goes to Lummet; the admin, API, portal and login are not reachable and never render here
  const about = await call('sze.app', '/about?x=1');
  assert.equal(about.status, 301);
  assert.equal(about.headers.get('location'), 'https://lummet.com/about?x=1');
  assert.equal((await call('sze.app', '/app/login')).headers.get('location'), 'https://lummet.com/app/login');
  assert.equal((await call('sze.app', '/api/customer/login', { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await call('sze.app', '/aftermarket/domains/other.app')).status, 301);
  assert.match(await (await call('sze.app', '/robots.txt')).text(), /Allow: \//);
  // a domain that is not hosted, and Lummet's own host, behave as before
  assert.match(await (await call('plain.app', '/')).text(), /<title>[^<]*(?!is for sale)/);
  assert.doesNotMatch(await (await call('plain.app', '/')).text(), /plain\.app is for sale/);
  const own = await call('lummet.test', '/');
  assert.equal(own.status, 200);
  assert.doesNotMatch(await own.text(), /is for sale/);
});

test('where an enquiry came from is stored (known keys only), and domain names never wrap on the list', async () => {
  const env = createPublicEnv();
  await addDomain(env, 'sze.app');
  await post(handlePublicRoute, env, '/aftermarket/domain-acquisition?domain=sze.app', { ...valid, f_domain: 'sze.app', _attr: 'source=newsletter;medium=email;referrer=news.example.com;evil=<script>;campaign=x<b>y' });
  const row = (await inquiries(env))[0];
  const payload = JSON.parse(row.payload);
  assert.deepEqual(payload.attribution, { source: 'newsletter', medium: 'email', referrer: 'news.example.com', campaign: 'xby' });
  assert.match(row.details, /Came from: source=newsletter, medium=email, campaign=xby, referrer=news\.example\.com|Came from: /);
  assert.doesNotMatch(row.details, /evil|<script>/);
  // the form carries the hidden field and its script (script reads utm_* and the referrer in the browser: pages are cached)
  const html = await text(await get(handlePublicRoute, env, '/aftermarket/domain-acquisition'));
  assert.match(html, /<input type="hidden" name="_attr" value="">/);
  assert.match(html, /src="\/static\/js\/attribution\.js[^"]*"/);
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../public/static/css/components.css', import.meta.url), 'utf8');
  assert.match(css, /\.aftermarket-table tbody th \{[^}]*white-space: nowrap/);
});

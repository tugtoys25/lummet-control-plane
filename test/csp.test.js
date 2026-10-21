// v7E: Content-Security-Policy with a nonce-based script-src, no inline handlers, delegated runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, readdirSync } from 'node:fs';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import * as csp from '../worker/csp.js';
import { createAssets } from './support/public-env.js';

const html = (body, extra = {}) => new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ...extra } });
const nonceOf = (r) => (r.headers.get('Content-Security-Policy') || r.headers.get('Content-Security-Policy-Report-Only') || '').match(/'nonce-([^']+)'/)?.[1];

test('onClick/onSubmit/onChange emit only data attributes, and hostile arguments cannot break out of them', () => {
  assert.equal(csp.onClick('lummetRevokeKey', ['k1']), ' data-onclick="lummetRevokeKey" data-args="[&quot;k1&quot;]"');
  assert.equal(csp.onClick('x'), ' data-onclick="x"');
  assert.equal(csp.onSubmit('f', ['$el'], { prevent: true }), ' data-onsubmit="f" data-args="[&quot;$el&quot;]" data-prevent="1"');
  const evil = csp.onClick('f', ['"><img src=x onerror=alert(1)>', "'; alert(2); '"], { confirm: '"><script>alert(3)</script>' });
  assert.doesNotMatch(evil, /<|>/, 'no angle brackets survive');
  assert.equal((evil.match(/"/g) || []).length % 2, 0, 'quotes stay balanced');
  // Tokenise like a browser: drop the quoted values, what is left are the attribute names.
  const names = evil.replace(/="[^"]*"/g, '').trim().split(/\s+/);
  assert.deepEqual(names, ['data-onclick', 'data-args', 'data-confirm'], 'no live handler attribute is produced');
  for (const bad of ['a b', 'a(', '1x', 'a;b', '']) assert.throws(() => csp.onClick(bad, []));
});

test('finalizeResponse (enforce): the secret token becomes this response\'s nonce, and the header carries the same one', async () => {
  const token = csp.nonceToken();
  const r = await csp.finalizeResponse(html(`<html><body><script nonce="${token}">var a=1</script></body></html>`), { CSP_MODE: 'enforce' });
  const body = await r.text(); const n = nonceOf(r);
  assert.ok(n && n.length >= 20);
  assert.match(body, new RegExp(`<script nonce="${n.replace(/[+/=]/g, '\\$&')}">var a=1</script>`));
  assert.equal(body.includes(token), false, 'the secret never reaches the browser');
  const header = r.headers.get('Content-Security-Policy');
  assert.match(header, /script-src 'nonce-[^']+'; script-src-attr 'none'/);
  assert.match(header, /frame-ancestors 'none'/); assert.match(header, /connect-src 'self'/);
  assert.equal(r.headers.get('Content-Security-Policy-Report-Only'), null);
  // A different response gets a different nonce.
  const r2 = await csp.finalizeResponse(html(`<script nonce="${token}"></script>`), { CSP_MODE: 'enforce' });
  assert.notEqual(nonceOf(r2), n);
});

test('an injected script (no secret token) gets no nonce, so the policy would refuse it', async () => {
  const token = csp.nonceToken();
  const injected = '<script>alert(1)</script><script nonce="guess">alert(2)</script><img src=x onerror=alert(3)>';
  const r = await csp.finalizeResponse(html(`<body>${injected}<script nonce="${token}">ok()</script></body>`), { CSP_MODE: 'enforce' });
  const body = await r.text(); const n = nonceOf(r);
  assert.ok(body.includes('<script>alert(1)</script>'));
  const withNonce = [...body.matchAll(/<script nonce="([^"]*)">/g)].map((m) => m[1]);
  assert.deepEqual(withNonce.sort(), [n, 'guess'].sort());
  assert.notEqual(n, 'guess');
});

test('report-only (the default) keeps the baseline enforced and reports the script policy', async () => {
  const r = await csp.finalizeResponse(html('<p>x</p>'), {});
  assert.equal(csp.cspMode({}), 'report-only');
  assert.doesNotMatch(r.headers.get('Content-Security-Policy'), /script-src/);
  assert.match(r.headers.get('Content-Security-Policy-Report-Only'), /script-src 'nonce-[^']+'; script-src-attr 'none'; report-uri \/api\/csp-report/);
  assert.equal(csp.cspMode({ CSP_MODE: 'ENFORCE' }), 'enforce');
  assert.equal(csp.cspMode({ CSP_MODE: 'yes' }), 'report-only');
});

test('the UI runtime is added once, only to pages that use data-on attributes, with the page\'s nonce', async () => {
  const withActions = await csp.finalizeResponse(html('<html><body><button data-onclick="f">x</button></body></html>'), { CSP_MODE: 'enforce' });
  const body = await withActions.text(); const n = nonceOf(withActions);
  assert.equal((body.match(/lummet-ui-runtime/g) || []).length, 1);
  assert.ok(body.indexOf('lummet-ui-runtime') < body.indexOf('</body>'));
  assert.match(body, new RegExp(`<script nonce="${n.replace(/[+/=]/g, '\\$&')}">/\\*lummet-ui-runtime\\*/`));
  const without = await (await csp.finalizeResponse(html('<p>plain</p>'), { CSP_MODE: 'enforce' })).text();
  assert.equal(without.includes('lummet-ui-runtime'), false);
  // Text that merely mentions the word does not count as using the runtime.
  assert.equal((await (await csp.finalizeResponse(html('<p>data-onclick is how it works</p>'), {})).text()).includes('lummet-ui-runtime'), false);
});

test('non-HTML responses: token stripped if it ever leaks into text, binary and bodyless responses untouched', async () => {
  const token = csp.nonceToken();
  const j = await csp.finalizeResponse(new Response(JSON.stringify({ html: `<script nonce="${token}">` }), { headers: { 'Content-Type': 'application/json' } }), {});
  assert.equal((await j.text()).includes(token), false);
  const clean = await csp.finalizeResponse(new Response('{"a":1}', { headers: { 'Content-Type': 'application/json' } }), {});
  assert.equal(await clean.text(), '{"a":1}');
  assert.ok(clean.headers.get('Content-Security-Policy'));
  const bin = new Uint8Array([0, 1, 2, 255]);
  const b = await csp.finalizeResponse(new Response(bin, { headers: { 'Content-Type': 'application/octet-stream' } }), {});
  assert.deepEqual(new Uint8Array(await b.arrayBuffer()), bin);
  const redirect = await csp.finalizeResponse(new Response(null, { status: 302, headers: { Location: '/x' } }), {});
  assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('Location'), '/x');
  const nc = await csp.finalizeResponse(new Response(null, { status: 204 }), {});
  assert.equal(nc.status, 204);
});

// ---- the browser runtime, run against a stub document ----
function runtime() {
  const listeners = {}; const calls = []; const confirms = [];
  const win = { confirm: (m) => { confirms.push(m); return win.__confirmAnswer !== false; }, __confirmAnswer: true };
  const doc = { addEventListener: (t, f) => { listeners[t] = f; } };
  const sandbox = { window: win, document: doc, JSON, Array };
  vm.createContext(sandbox);
  vm.runInContext(csp.UI_RUNTIME, sandbox);
  const element = (type, attrs, value = '') => {
    const el = { value, tagName: 'BUTTON', getAttribute: (k) => (k in attrs ? attrs[k] : null) };
    el.closest = (sel) => (sel === `[data-on${type}]` && `data-on${type}` in attrs ? el : null);
    return el;
  };
  const fire = (type, el) => { const ev = { type, target: el, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; listeners[type](ev); return ev; };
  return { win, calls, confirms, element, fire, listeners };
}

test('runtime: calls the named page function with the JSON args and the $el / $ev / $value tokens', () => {
  const rt = runtime();
  rt.win.pick = function (...a) { rt.calls.push({ self: this, a }); };
  const el = rt.element('click', { 'data-onclick': 'pick', 'data-args': '["id-1",{"k":2},"$el","$ev","$value"]' }, 'typed');
  const ev = rt.fire('click', el);
  assert.equal(rt.calls.length, 1);
  const a = rt.calls[0].a;
  assert.equal(a[0], 'id-1'); assert.deepEqual(a[1], { k: 2 }); assert.equal(a[2], el); assert.equal(a[3], ev); assert.equal(a[4], 'typed');
  assert.equal(rt.calls[0].self, el, '`this` is the element, as with an inline handler');
});

test('runtime: confirm text gates the call, and a cancelled confirm also stops the default action', () => {
  const rt = runtime(); let hit = 0; rt.win.del = () => { hit++; };
  const el = rt.element('click', { 'data-onclick': 'del', 'data-confirm': 'Sure?' });
  rt.fire('click', el); assert.equal(hit, 1); assert.deepEqual(rt.confirms, ['Sure?']);
  rt.win.__confirmAnswer = false;
  const ev = rt.fire('click', el); assert.equal(hit, 1); assert.equal(ev.defaultPrevented, true);
});

test('runtime: data-prevent and a function returning false both prevent the default; returning true does not', () => {
  const rt = runtime(); rt.win.nope = () => false; rt.win.yes = () => true;
  assert.equal(rt.fire('click', rt.element('click', { 'data-onclick': 'nope' })).defaultPrevented, true);
  assert.equal(rt.fire('click', rt.element('click', { 'data-onclick': 'yes' })).defaultPrevented, false);
  assert.equal(rt.fire('submit', rt.element('submit', { 'data-onsubmit': 'yes', 'data-prevent': '1' })).defaultPrevented, true);
});

test('runtime: refuses names that are not plain functions on window, and survives broken args', () => {
  const rt = runtime(); rt.win.notAFunction = 5; let ran = 0; rt.win.ok = (...a) => { ran++; rt.calls.push(a); };
  for (const bad of ['notAFunction', 'missing', 'a.b', 'a b', 'constructor', '__proto__', '']) rt.fire('click', rt.element('click', { 'data-onclick': bad }));
  assert.equal(ran, 0);
  rt.fire('click', rt.element('click', { 'data-onclick': 'ok', 'data-args': '{not json' }));
  rt.fire('click', rt.element('click', { 'data-onclick': 'ok', 'data-args': '"a string, not an array"' }));
  assert.equal(ran, 2); assert.deepEqual(rt.calls, [[], []]);
});

test('runtime: change and submit are delegated too, and lummetSubmitForm submits the element\'s form', () => {
  const rt = runtime(); let v = null; rt.win.sw = (x) => { v = x; };
  rt.fire('change', rt.element('change', { 'data-onchange': 'sw', 'data-args': '["$value"]' }, 'org-2'));
  assert.equal(v, 'org-2');
  let submitted = 0; rt.win.lummetSubmitForm({ form: { submit() { submitted++; } } });
  assert.equal(submitted, 1);
  assert.deepEqual(Object.keys(rt.listeners).sort(), ['change', 'click', 'input', 'submit']);
});

test('BROWSER_HELPER builds attributes the runtime understands (same encoding as the server helpers)', () => {
  const sandbox = {}; vm.createContext(sandbox); vm.runInContext(csp.BROWSER_HELPER, sandbox);
  const mine = sandbox.lummetAttrs('click', 'lummetRedeliver', ['w"1', 'd<2'], { confirm: 'ok?', prevent: true });
  assert.equal(mine, csp.onClick('lummetRedeliver', ['w"1', 'd<2'], { confirm: 'ok?', prevent: true }));
});

// ---- the source tree ----
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(d + '/' + e.name) : [d + '/' + e.name]);
const SRC = walk(new URL('../worker', import.meta.url).pathname).filter((f) => f.endsWith('.js') && !f.endsWith('/csp.js'));

test('source scan: no inline event-handler attribute is written anywhere in worker/', () => {
  const offenders = SRC.filter((f) => /(?<![\w.-])on(click|submit|change|input|load|error|keyup|keydown|focus|blur|mouse\w+)=\s*["'\\]/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('source scan: every <script> is nonce-bearing, an external src, or a non-executable JSON block', () => {
  const bad = [];
  for (const f of SRC) {
    for (const m of readFileSync(f, 'utf8').matchAll(/<script\b[^>]*>/g)) {
      const tag = m[0];
      if (/nonce="\$\{nonceToken\(\)\}"/.test(tag) || /type="application\/(ld\+)?json"/.test(tag)) continue;
      if (/\/\/.*<script/.test(readFileSync(f, 'utf8').split('\n').find((l) => l.includes(tag)) || '')) continue;   // a comment
      bad.push(f + ' ' + tag);
    }
  }
  assert.deepEqual(bad, []);
});

test('source scan: every function a template names in onClick/onSubmit/onChange is defined somewhere in worker/', () => {
  const all = SRC.map((f) => readFileSync(f, 'utf8')).join('\n');
  const names = new Set();
  for (const f of SRC) for (const m of readFileSync(f, 'utf8').matchAll(/\bon(?:Click|Submit|Change|Input)\("([A-Za-z_$][\w$]*)"/g)) names.add(m[1]);
  assert.ok(names.size > 30, 'found the call sites');
  const missing = [...names].filter((n) => !new RegExp(`function\\s+${n.replace(/\$/g, '\\$')}\\s*\\(|window\\.${n}\\s*=`).test(all) && !(csp.UI_RUNTIME.includes(`window.${n} =`)));
  assert.deepEqual(missing, []);
});

test('source scan: pages that carry scripts are never edge-cached (a cached nonce would be reused by everyone)', () => {
  const router = readFileSync(new URL('../worker/public-site/router.js', import.meta.url), 'utf8');
  assert.match(router, /caches\.default/);
  const publicFiles = walk(new URL('../worker/public-site', import.meta.url).pathname).filter((f) => f.endsWith('.js'));
  for (const f of publicFiles) assert.doesNotMatch(readFileSync(f, 'utf8'), /nonceToken/, f);
});

// ---- real pages through the real Worker ----
function env(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, ASSETS: createAssets(), CONTACT_EMAIL: 'hello@example.test', CREDENTIAL_KEK: btoa('k'.repeat(32)), CSP_MODE: 'enforce', ...extra }; }
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
async function get(e, path, cookie, method = 'GET', body) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.' + (Math.floor(Math.random() * 200) + 1) });
  if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
  return { res, text: await res.text() };
}
const cookieOf = (res) => (res.headers.get('Set-Cookie') || '').split(';')[0];

function checkPage(label, { res, text }) {
  assert.match(res.headers.get('Content-Type') || '', /html/, label);
  const n = nonceOf(res);
  if (!n) {
    // A page that brings its own policy (the public site): scripts may only be same-origin files, never inline.
    assert.match(res.headers.get('Content-Security-Policy'), /script-src 'self'/, `${label}: own policy`);
    for (const [, attrs] of text.matchAll(/<script\b([^>]*)>/g)) assert.ok(/\ssrc="\/static\//.test(attrs) || /ld\+json/.test(attrs), `${label}: inline script on a script-src 'self' page: ${attrs}`);
    assert.equal(/<[^>]*(?<![\w.-])on(click|submit|change|input)=/.test(text), false, `${label}: no inline handler`);
    assert.equal(/lnt[0-9a-f]{32}/.test(text), false, `${label}: no secret token`);
    return 0;
  }
  assert.ok(n, `${label}: has a nonce`);
  assert.match(res.headers.get('Content-Security-Policy'), /script-src 'nonce-[^']+'; script-src-attr 'none'/, label);
  assert.equal(/lnt[0-9a-f]{32}/.test(text), false, `${label}: the secret token never leaves the Worker`);
  assert.equal(text.includes('nonceToken'), false, `${label}: no unrendered template call`);
  assert.equal(/<[^>]*(?<![\w.-])on(click|submit|change|input|load|error|keyup|keydown)=/.test(text), false, `${label}: no inline handler`);
  const scripts = [...text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  for (const [, attrs, code] of scripts) {
    if (/type="application\/(ld\+)?json"/.test(attrs)) continue;
    assert.ok(attrs.includes(`nonce="${n}"`), `${label}: script without this response's nonce: ${attrs}`);
    assert.doesNotMatch(code, /\$\{/, `${label}: template text left in a script`);
  }
  const defined = scripts.map((s) => s[2]).join('\n');
  for (const m of text.matchAll(/\sdata-on(?:click|submit|change|input)="([^"]+)"/g)) {
    assert.match(defined, new RegExp(`function\\s+${m[1]}\\s*\\(|window\\.${m[1]}\\s*=`), `${label}: ${m[1]} is defined on the page`);
  }
  return scripts.length;
}

test('real pages: staff console, customer portal and public site all satisfy the policy', async () => {
  const e = env();
  const pages = [];
  const home = await get(e, '/'); assert.equal(home.res.status, 200, 'the public home really rendered');
  pages.push(['public home', home]);
  pages.push(['staff login', await get(e, '/login')]);
  pages.push(['customer login', await get(e, '/app/login')]);
  await get(e, '/api/auth/bootstrap', null, 'POST', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' });
  const staff = cookieOf((await get(e, '/api/auth/login', null, 'POST', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' })).res);
  const cust = await get(e, '/api/customer/signup', null, 'POST', { email: 'c@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'Acme <b>x</b>' });
  const ccookie = cookieOf(cust.res);
  for (const p of ['/platform/saas', '/platform/saas/organizations', '/platform/saas/plans', '/platform/saas/coupons', '/platform/saas/jobs', '/platform/saas/tenant-template', '/platform/saas/alerts', '/tenants', '/dashboard']) pages.push(['staff ' + p, await get(e, p, staff)]);
  for (const p of ['/app', '/app/sites', '/app/billing', '/app/team', '/app/domains', '/app/usage', '/app/developer', '/app/settings', '/app/account', '/app/backups', '/app/automations', '/app/deployments']) pages.push(['customer ' + p, await get(e, p, ccookie)]);
  let withScripts = 0, checked = 0;
  for (const [label, page] of pages) {
    if (!/html/.test(page.res.headers.get('Content-Type') || '')) continue;
    if (page.res.status >= 300) continue;
    withScripts += checkPage(label, page) > 0 ? 1 : 0; checked++;
  }
  assert.ok(checked >= 15, `checked ${checked} pages`);
  assert.ok(withScripts >= 10, 'most pages carry scripts, so the nonce path was really exercised');
});

test('a stored-XSS style name is escaped and, even if it were not, could not carry the nonce or the token', async () => {
  const e = env();
  await get(e, '/api/customer/signup', null, 'POST', { email: 'x@example.com', password: 'Correct-Horse-Battery-9', organizationName: '"><script>alert(1)</script><img src=x onerror=alert(2)>' });
  const login = await get(e, '/api/customer/login', null, 'POST', { email: 'x@example.com', password: 'Correct-Horse-Battery-9' });
  const page = await get(e, '/app/team', cookieOf(login.res));
  const n = nonceOf(page.res);
  assert.equal(page.text.includes('<script>alert(1)</script>'), false);
  assert.equal(new RegExp(`<script[^>]*>[^<]*alert\\(1\\)`).test(page.text), false);
  for (const m of page.text.matchAll(/<script\b([^>]*)>/g)) if (!/ld\+json/.test(m[1])) assert.ok(m[1].includes(n));
});

test('POST /api/csp-report: no auth, no CSRF block, always 204, logs a trimmed record and stores nothing', async () => {
  const e = env(); const logged = []; const orig = console.warn; console.warn = (m) => logged.push(m);
  try {
    const body = JSON.stringify({ 'csp-report': { 'document-uri': 'https://cp.test/app?token=SECRET', 'violated-directive': 'script-src-elem', 'blocked-uri': 'inline' } });
    const h = new Headers({ 'Content-Type': 'application/csp-report', Cookie: 'lummet_session=x', Origin: 'https://evil.example' });
    const res = await worker.fetch(new Request('https://cp.test/api/csp-report', { method: 'POST', headers: h, body }), e, ctx);
    assert.equal(res.status, 204);
    const bad = await worker.fetch(new Request('https://cp.test/api/csp-report', { method: 'POST', body: 'not json' }), e, ctx);
    assert.equal(bad.status, 204);
  } finally { console.warn = orig; }
  assert.equal(logged.length, 1);
  const rec = JSON.parse(logged[0]);
  assert.equal(rec.csp_violation, true); assert.equal(rec.directive, 'script-src-elem'); assert.equal(rec.document, 'https://cp.test/app');
  assert.equal(logged[0].includes('SECRET'), false, 'query strings are dropped');
});

test('production configuration check asks for CSP_MODE=enforce and warns when the DNS check is off', async () => {
  const { configIssues } = await import('../worker/config-check.js');
  const keys = (e) => configIssues({ ENVIRONMENT: 'production', ...e }).map((i) => i.key);
  assert.ok(keys({}).includes('CSP_MODE'));
  assert.ok(keys({ CSP_MODE: 'report-only' }).includes('CSP_MODE'));
  assert.ok(!keys({ CSP_MODE: 'enforce' }).includes('CSP_MODE'));
  assert.ok(!keys({}).includes('OUTBOUND_DNS_CHECK'), 'on by default in production');
  assert.ok(keys({ OUTBOUND_DNS_CHECK: 'off' }).includes('OUTBOUND_DNS_CHECK'));
});


test('a response that carries its own CSP keeps it untouched, in both modes (the public site loads same-origin scripts under script-src \'self\')', async () => {
  const own = "default-src 'self'; script-src 'self'; frame-ancestors 'self'";
  for (const mode of ['enforce', 'report-only']) {
    const r = await csp.finalizeResponse(html('<script src="/static/js/nav.js"></script>', { 'Content-Security-Policy': own }), { CSP_MODE: mode });
    assert.equal(r.headers.get('Content-Security-Policy'), own, mode);
    assert.equal(r.headers.get('Content-Security-Policy-Report-Only'), null, mode);
    assert.equal(await r.text(), '<script src="/static/js/nav.js"></script>');
  }
  const leaked = await csp.finalizeResponse(html(`x${csp.nonceToken()}y`, { 'Content-Security-Policy': own }), {});
  assert.equal(await leaked.text(), 'xy', 'the secret still never leaves');
});

test('the real public site is served with its own policy and its scripts are not blocked, in enforce mode', async () => {
  const e = env();
  for (const path of ['/', '/brands', '/pricing', '/contact']) {
    const { res, text } = await get(e, path);
    assert.equal(res.status, 200, path);
    const header = res.headers.get('Content-Security-Policy');
    assert.match(header, /script-src 'self'/, path);
    assert.doesNotMatch(header, /nonce-/, path);
    assert.match(text, /<script src="\/static\/js\/nav\.js"/, path);
    assert.doesNotMatch(text, /\son(click|submit|change|input)=/, path);
  }
});
